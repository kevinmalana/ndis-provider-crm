-- 0005_sensitive_command_rpcs.sql
--
-- Transactional command RPCs.
--
-- Per decision-log/2026-08-06 ("Direct Supabase RPC for sensitive state
-- transitions"), sensitive state transitions use narrow Postgres RPC
-- functions called directly through Supabase. Each RPC:
--
--   1. Verifies the caller is authenticated and holds an *active,
--      currently effective* membership in the relevant organisation.
--   2. Verifies role-specific authority (worker / scheduler-admin /
--      participant self-link / representative authority / external grant).
--   3. Verifies expected_version on the subject row (when applicable).
--   4. Deduplicates by (organisation_id, actor_membership_id,
--      command_type, command_id) — a retry returns the original receipt
--      atomically and only if the SAME actor calls it. Cross-actor and
--      cross-organisation collisions are not possible because the unique
--      key is scoped.
--   5. Records client-reported (claimed_at) AND server-receipt times.
--   6. Applies ONE state transition.
--   7. Routes every post-capture failure (reassignment, cancellation,
--      stale version, invalid state, wrong assignment, token
--      validation) into an attributed receipt + audit + shift_event +
--      evidence_review_queue row. Evidence is never silently dropped.
--   8. Conflict review decisions are one-way (immutable once decided).
--   9. Successful worker summary submission auto-finalises the
--      participant-visible summary; no admin bottleneck.
--
-- Parameter naming convention: every parameter is named with a `p_`
-- prefix so PostgREST named-argument resolution matches the SQL
-- function signature exactly. The TypeScript wrapper
-- (src/lib/supabase/commands.ts) and the route handlers mirror this.
--
-- Out of scope: mobile outbox flush layer, background scheduler, retry
-- policy, dashboard UI.

set search_path = public;

------------------------------------------------------------------------
-- Pre-flight helper: assert caller is currently authenticated.
------------------------------------------------------------------------

create or replace function public.require_authenticated()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.require_authenticated() from public;
grant execute on function public.require_authenticated() to authenticated;

------------------------------------------------------------------------
-- Helper: scoped command-receipt lookup.
------------------------------------------------------------------------
-- Returns the receipt for the (org, actor, type, command_id) tuple,
-- or NULL when no row exists. Cross-actor / cross-org / cross-type
-- lookups return nothing.

create or replace function public.lookup_command_receipt(
  p_organisation_id    uuid,
  p_actor_membership   uuid,
  p_command_type       text,
  p_command_id         text
)
returns table (
  found              boolean,
  status             text,
  outcome            jsonb,
  receipt_id         uuid,
  server_received_at timestamptz,
  subject_shift_id   uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    true,
    r.status,
    r.outcome,
    r.id,
    r.server_received_at,
    r.subject_shift_id
  from public.command_receipts r
  where r.organisation_id = p_organisation_id
    and r.actor_membership_id = p_actor_membership
    and r.command_type = p_command_type
    and r.command_id = p_command_id
    and (
      auth.role() = 'service_role'
      or exists (
        select 1
        from public.organisation_memberships m
        join public.organisations o on o.id = m.organisation_id
        where m.id = p_actor_membership
          and m.organisation_id = p_organisation_id
          and m.profile_id = auth.uid()
          and m.status = 'active'
          and m.effective_from <= now()
          and (m.effective_until is null or m.effective_until > now())
          and o.deleted_at is null
      )
    )
  limit 1
$$;

revoke all on function public.lookup_command_receipt(uuid, uuid, text, text) from public;
grant execute on function public.lookup_command_receipt(uuid, uuid, text, text) to authenticated;

------------------------------------------------------------------------
-- Internal helper: append audit + shift_event in one transaction.
------------------------------------------------------------------------
-- Records auth.uid() as the audit actor (profile id, satisfies the FK
-- on audit_log.actor); shift_events.actor_membership_id stays as the
-- caller's membership id.

create or replace function public.record_shift_audit(
  p_organisation_id   uuid,
  p_shift_id          uuid,
  p_actor_membership  uuid,
  p_event_type        text,
  p_action            text,
  p_metadata          jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_profile uuid := auth.uid();
begin
  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    p_organisation_id,
    v_actor_profile,
    p_action,
    'shift',
    p_shift_id,
    p_metadata
  );

  insert into public.shift_events (
    organisation_id, shift_id, event_type, actor_membership_id, payload
  )
  values (
    p_organisation_id,
    p_shift_id,
    p_event_type,
    p_actor_membership,
    p_metadata
  );
end;
$$;

revoke all on function public.record_shift_audit(uuid, uuid, uuid, text, text, jsonb) from public;

------------------------------------------------------------------------
-- Generic "preserve evidence" helper used by every sensitive RPC.
------------------------------------------------------------------------
-- Atomically writes a command_receipt + (optional) evidence_review_queue
-- row + (optional) audit + (optional) shift_event in one transaction.
-- Used by both happy-path and conflict-path branches.

create or replace function public.record_command_outcome(
  p_command_id         text,
  p_command_type       text,
  p_organisation_id    uuid,
  p_actor_membership   uuid,
  p_subject_shift_id   uuid,
  p_expected_version   bigint,
  p_claimed_at         timestamptz,
  p_client_tz          text,
  p_payload            jsonb,
  p_status             text,
  p_outcome            jsonb,
  p_open_review        boolean,
  p_review_context     jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt_id uuid;
begin
  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id, actor_profile_id,
    subject_shift_id, expected_version, claimed_at, client_tz,
    server_received_at, completed_at, status, outcome, payload
  )
  values (
    p_command_id, p_command_type, p_organisation_id, p_actor_membership, auth.uid(),
    p_subject_shift_id, p_expected_version, p_claimed_at, p_client_tz,
    now(), now(), p_status, p_outcome, p_payload
  )
  on conflict (organisation_id, actor_membership_id, command_type, command_id)
  do update set server_received_at = public.command_receipts.server_received_at
  returning id into v_receipt_id;

  if p_open_review then
    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, p_organisation_id, p_payload,
      coalesce(p_review_context, '{}'::jsonb)
    )
    on conflict (receipt_id) do nothing;
  end if;

  return v_receipt_id;
end;
$$;

revoke all on function public.record_command_outcome(
  text, text, uuid, uuid, uuid, bigint, timestamptz, text, jsonb, text, jsonb, boolean, jsonb
) from public;

------------------------------------------------------------------------
-- Shared helper: validate caller is the worker's currently effective
-- assignment for a shift in the named org.
------------------------------------------------------------------------

create or replace function public.assert_worker_assignment(
  p_shift_id uuid,
  p_organisation_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_membership_id uuid;
begin
  select m.id
    into v_membership_id
  from public.organisation_memberships m
  join public.shift_assignments sa on sa.membership_id = m.id
  where sa.shift_id = p_shift_id
    and sa.withdrawn_at is null
    and sa.effective_from <= now()
    and (sa.effective_until is null or sa.effective_until > now())
    and m.profile_id = auth.uid()
    and m.organisation_id = p_organisation_id
    and m.status = 'active'
    and m.effective_from <= now()
    and (m.effective_until is null or m.effective_until > now())
    and m.role = 'worker'
  limit 1;

  if v_membership_id is null then
    raise exception 'not_assigned' using errcode = '42501';
  end if;

  return v_membership_id;
end;
$$;

revoke all on function public.assert_worker_assignment(uuid, uuid) from public;

-- Preserve the actor dimension for an offline command captured before a
-- membership was withdrawn or expired. This is not an authorization helper;
-- callers still require a live assignment before applying state changes.
create or replace function public.historical_membership(p_organisation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.organisation_memberships m
  where m.organisation_id = p_organisation_id
    and m.profile_id = auth.uid()
  order by m.updated_at desc, m.created_at desc
  limit 1
$$;

revoke all on function public.historical_membership(uuid) from public;
grant execute on function public.historical_membership(uuid) to authenticated;

------------------------------------------------------------------------
-- on_my_way: optional, never gates Start
------------------------------------------------------------------------

create or replace function public.cmd_on_my_way(
  p_command_id       text,
  p_shift_id         uuid,
  p_claimed_at       timestamptz,
  p_client_tz        text,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_existing           record;
  v_receipt_id         uuid;
  v_state_ok           boolean := false;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(public.current_membership(v_shift.organisation_id),
                              public.historical_membership(v_shift.organisation_id));
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- Authorisation: must be the currently assigned worker (role check
  -- + effective windows inside assert_worker_assignment).
  begin
    v_membership_id := public.assert_worker_assignment(p_shift_id, v_shift.organisation_id);
  exception when sqlstate '42501' then
    -- Evidence-preservation path: write a receipt + audit + event +
    -- review row so the worker can later see "my on-my-way was
    -- rejected because I was no longer assigned".
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'on_my_way', v_shift.organisation_id, v_membership_id,
      p_shift_id, null, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','not_assigned'),
      true,
      jsonb_build_object('reason','not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.on_my_way.conflicted',
      jsonb_build_object('command_id',p_command_id,'reason','not_assigned')
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'on_my_way', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id
    );
  end if;

  v_state_ok := v_shift.state in ('scheduled','in_transit');

  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'on_my_way', v_shift.organisation_id, v_membership_id,
      p_shift_id, v_shift.version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      true,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.on_my_way.conflicted',
      jsonb_build_object('command_id',p_command_id,'state',v_shift.state)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','invalid_state',
      'state', v_shift.state,
      'receipt_id', v_receipt_id
    );
  end if;

  update public.shifts
    set state = 'in_transit',
        version = version + 1
    where id = p_shift_id
      and version = v_shift.version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'on_my_way', 'shift.on_my_way',
    jsonb_build_object(
      'claimed_at',p_claimed_at,
      'client_tz',p_client_tz,
      'expected_version',v_shift.version,
      'command_id',p_command_id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'on_my_way', v_shift.organisation_id, v_membership_id,
    p_shift_id, v_shift.version, p_claimed_at, p_client_tz, p_payload,
    'accepted',
    jsonb_build_object('new_state','in_transit','version',v_shift.version+1),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'new_state','in_transit',
    'version', v_shift.version + 1
  );
end;
$$;

revoke all on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) from public;
grant execute on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- start_shift: scheduled|in_transit → started (atomic, evidence-preserving)
------------------------------------------------------------------------

create or replace function public.cmd_start_shift(
  p_command_id       text,
  p_shift_id         uuid,
  p_expected_version bigint,
  p_claimed_at       timestamptz,
  p_client_tz        text,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_existing           record;
  v_receipt_id         uuid;
  v_state_ok           boolean := false;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(public.current_membership(v_shift.organisation_id),
                              public.historical_membership(v_shift.organisation_id));
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- Scoped idempotency: lookup BEFORE assignment check so a worker
  -- retrying their own command_id can get the original receipt even
  -- if they were subsequently unassigned.
  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'start_shift', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  begin
    v_membership_id := public.assert_worker_assignment(p_shift_id, v_shift.organisation_id);
  exception when sqlstate '42501' then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','not_assigned'),
      true,
      jsonb_build_object('reason','not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.start.conflicted',
      jsonb_build_object('command_id',p_command_id,'reason','not_assigned')
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object(
        'reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      ),
      true,
      jsonb_build_object(
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.start.conflicted',
      jsonb_build_object(
        'command_id',p_command_id,
        'claimed_version',p_expected_version,
        'current_version',v_shift.version
      )
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state in ('scheduled','in_transit');

  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      true,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.start.conflicted',
      jsonb_build_object('command_id',p_command_id,'state',v_shift.state)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','invalid_state',
      'state', v_shift.state,
      'receipt_id', v_receipt_id
    );
  end if;

  update public.shifts
    set state = 'started',
        version = version + 1
    where id = p_shift_id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'start', 'shift.start',
    jsonb_build_object(
      'claimed_at',p_claimed_at,
      'client_tz',p_client_tz,
      'expected_version',p_expected_version,
      'command_id',p_command_id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
    'accepted',
    jsonb_build_object(
      'new_state','started',
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'new_state','started',
    'version', p_expected_version + 1
  );
end;
$$;

revoke all on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) from public;
grant execute on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- end_shift: started → ended_summary_required (atomic, evidence-preserving)
------------------------------------------------------------------------

create or replace function public.cmd_end_shift(
  p_command_id       text,
  p_shift_id         uuid,
  p_expected_version bigint,
  p_claimed_at       timestamptz,
  p_client_tz        text,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_existing           record;
  v_receipt_id         uuid;
  v_state_ok           boolean := false;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(public.current_membership(v_shift.organisation_id),
                              public.historical_membership(v_shift.organisation_id));
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'end_shift', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  begin
    v_membership_id := public.assert_worker_assignment(p_shift_id, v_shift.organisation_id);
  exception when sqlstate '42501' then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','not_assigned'),
      true,
      jsonb_build_object('reason','not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.end.conflicted',
      jsonb_build_object('command_id',p_command_id,'reason','not_assigned')
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object(
        'reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      ),
      true,
      jsonb_build_object(
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.end.conflicted',
      jsonb_build_object(
        'command_id',p_command_id,
        'claimed_version',p_expected_version,
        'current_version',v_shift.version
      )
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state = 'started';

  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      true,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.end.conflicted',
      jsonb_build_object('command_id',p_command_id,'state',v_shift.state)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','invalid_state',
      'state', v_shift.state,
      'receipt_id', v_receipt_id
    );
  end if;

  update public.shifts
    set state = 'ended_summary_required',
        version = version + 1
    where id = p_shift_id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'end', 'shift.end',
    jsonb_build_object(
      'claimed_at',p_claimed_at,
      'client_tz',p_client_tz,
      'expected_version',p_expected_version,
      'command_id',p_command_id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
    'accepted',
    jsonb_build_object(
      'new_state','ended_summary_required',
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'new_state','ended_summary_required',
    'version', p_expected_version + 1
  );
end;
$$;

revoke all on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) from public;
grant execute on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- submit_summary: ended_summary_required → finalised (auto-finalise)
------------------------------------------------------------------------
-- Per the revised flow: a successful worker submission finalises the
-- participant-readable summary automatically. There is no mandatory
-- admin step. External visibility remains grant-scoped.
-- Idempotency: (org, actor, type, command_id).

create or replace function public.cmd_submit_summary(
  p_command_id       text,
  p_shift_id         uuid,
  p_expected_version bigint,
  p_claimed_at       timestamptz,
  p_activities       text[],
  p_summary_text     text,
  p_audience         text[],
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_existing           record;
  v_receipt_id         uuid;
  v_summary_id         uuid;
  v_version_id         uuid;
  v_state_ok           boolean := false;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(public.current_membership(v_shift.organisation_id),
                              public.historical_membership(v_shift.organisation_id));
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'submit_summary', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  begin
    v_membership_id := public.assert_worker_assignment(p_shift_id, v_shift.organisation_id);
  exception when sqlstate '42501' then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'submit_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, null, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','not_assigned'),
      true,
      jsonb_build_object('reason','not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.submit_summary.conflicted',
      jsonb_build_object('command_id',p_command_id,'reason','not_assigned')
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'submit_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, null, p_payload,
      'conflict_preserved',
      jsonb_build_object(
        'reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      ),
      true,
      jsonb_build_object(
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.submit_summary.conflicted',
      jsonb_build_object(
        'command_id',p_command_id,
        'claimed_version',p_expected_version,
        'current_version',v_shift.version
      )
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state = 'ended_summary_required';

  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'submit_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, null, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      true,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.submit_summary.conflicted',
      jsonb_build_object('command_id',p_command_id,'state',v_shift.state)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','invalid_state',
      'state', v_shift.state,
      'receipt_id', v_receipt_id
    );
  end if;

  insert into public.service_summaries (organisation_id, shift_id)
  values (v_shift.organisation_id, p_shift_id)
  on conflict (shift_id) do update set updated_at = now()
  returning id into v_summary_id;

  insert into public.service_summary_versions (
    summary_id, version_number, activities, summary_text, audience_categories,
    author_membership_id, is_correction, correction_reason
  )
  values (
    v_summary_id, 1, p_activities, p_summary_text, p_audience,
    v_membership_id, false, null
  )
  returning id into v_version_id;

  update public.service_summaries
    set current_version_id = v_version_id,
        finalised_at = now(),
        has_correction = false,
        updated_at = now()
    where id = v_summary_id;

  update public.shifts
    set state = 'finalised',
        version = version + 1
    where id = p_shift_id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'summary_submitted', 'shift.summary_submitted',
    jsonb_build_object(
      'command_id',p_command_id,
      'claimed_at',p_claimed_at,
      'summary_id',v_summary_id,
      'version_id',v_version_id
    )
  );

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'summary_finalised', 'shift.summary_finalised',
    jsonb_build_object(
      'command_id',p_command_id,
      'summary_id',v_summary_id,
      'current_version_id',v_version_id,
      'auto_finalise', true
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'submit_summary', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, null, p_payload,
    'accepted',
    jsonb_build_object(
      'summary_id',v_summary_id,
      'current_version_id',v_version_id,
      'new_state','finalised',
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1,
      'auto_finalise', true
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'summary_id', v_summary_id,
    'current_version_id', v_version_id,
    'new_state','finalised',
    'version', p_expected_version + 1
  );
end;
$$;

revoke all on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) from public;
grant execute on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) to authenticated;

-- Compatibility endpoint for clients that still send the pre-auto-finalise
-- command. Worker submission now finalises atomically; this endpoint is
-- therefore idempotent for an already-finalised shift and never reopens or
-- overwrites a summary.
create or replace function public.cmd_finalise_summary(
  p_command_id text,
  p_shift_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_authenticated();
  v_shift public.shifts%rowtype;
  v_membership_id uuid;
  v_membership_role text;
  v_role text;
  v_existing record;
  v_receipt_id uuid;
  v_expected_version bigint;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_shift.organisation_id);
  if v_membership_id is not null then
    select m.role into v_membership_role
    from public.organisation_memberships m
    where m.id = v_membership_id
      and m.profile_id = v_uid
      and m.organisation_id = v_shift.organisation_id;
    if v_membership_role not in ('admin','scheduler','worker') then
      v_membership_id := null;
    end if;
  end if;
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  select m.role into v_role
  from public.organisation_memberships m
  where m.id = v_membership_id
    and m.profile_id = v_uid
    and m.organisation_id = v_shift.organisation_id;
  if v_role not in ('admin','scheduler') then
    raise exception 'finalise_requires_admin_or_scheduler' using errcode = '42501';
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'finalise_summary', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  if p_payload ? 'expected_version' then
    v_expected_version := (p_payload ->> 'expected_version')::bigint;
  end if;
  if v_expected_version is not null and v_shift.version <> v_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'finalise_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, v_expected_version, now(), null, p_payload,
      'conflict_preserved',
      jsonb_build_object(
        'reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',v_expected_version
      ),
      true,
      jsonb_build_object('current_version',v_shift.version,'claimed_version',v_expected_version)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'receipt_id',v_receipt_id,
      'current_version',v_shift.version
    );
  end if;

  if v_shift.state not in ('finalised','corrected','cancelled') then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'finalise_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, v_expected_version, now(), null, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','summary_not_ready','state',v_shift.state),
      true,
      jsonb_build_object('state',v_shift.state)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','summary_not_ready',
      'receipt_id',v_receipt_id,
      'state',v_shift.state
    );
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'summary_finalised', 'shift.summary_finalised.compatibility',
    jsonb_build_object('command_id',p_command_id,'version',v_shift.version)
  );
  v_receipt_id := public.record_command_outcome(
    p_command_id, 'finalise_summary', v_shift.organisation_id, v_membership_id,
    p_shift_id, v_expected_version, now(), null, p_payload,
    'accepted',
    jsonb_build_object('state',v_shift.state,'version',v_shift.version,'duplicate',true),
    false,
    null
  );
  return jsonb_build_object('status','accepted','duplicate',true,
                            'command_id',p_command_id,'shift_id',p_shift_id,
                            'state',v_shift.state,'version',v_shift.version,
                            'receipt_id',v_receipt_id);
end;
$$;

revoke all on function public.cmd_finalise_summary(text, uuid, jsonb) from public;
grant execute on function public.cmd_finalise_summary(text, uuid, jsonb) to authenticated;

------------------------------------------------------------------------
-- cancel_shift: scheduled|in_transit|started → cancelled/cancelled_needs_review
------------------------------------------------------------------------
-- Authorised actor: admin/scheduler in the active org. Cancellation
-- AFTER local evidence moves the shift to cancelled_needs_review; the
-- evidence (audit + events + receipts) is preserved untouched.

create or replace function public.cmd_cancel_shift(
  p_command_id       text,
  p_shift_id         uuid,
  p_expected_version bigint,
  p_claimed_at       timestamptz,
  p_client_tz        text,
  p_reason           text,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_role               text;
  v_existing           record;
  v_receipt_id         uuid;
  v_new_state          text;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  v_role := public.current_user_membership_role();
  if v_role not in ('admin','scheduler') then
    raise exception 'cancel_requires_admin_or_scheduler' using errcode = '42501';
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'cancel_shift', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'cancel_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version),
      true,
      jsonb_build_object('reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  -- Decide new state based on whether any local evidence exists for
  -- this shift. Evidence is preserved (audit + events + receipts are
  -- append-only), so cancellation after evidence routes to
  -- cancelled_needs_review rather than a silent cancelled.
  if exists (
    select 1 from public.shift_events
    where shift_id = p_shift_id
      and event_type in ('on_my_way','start','end','summary_submitted','summary_finalised')
  ) then
    v_new_state := 'cancelled_needs_review';
  else
    v_new_state := 'cancelled';
  end if;

  update public.shifts
    set state = v_new_state,
        version = version + 1,
        cancellation_reason = p_reason,
        cancelled_at = now(),
        cancelled_by = auth.uid()
    where id = p_shift_id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'cancelled', 'shift.cancelled',
    jsonb_build_object(
      'command_id',p_command_id,
      'reason',p_reason,
      'new_state',v_new_state
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'cancel_shift', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
    'accepted',
    jsonb_build_object(
      'new_state',v_new_state,
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1,
      'reason',p_reason
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'new_state', v_new_state,
    'version', p_expected_version + 1
  );
end;
$$;

revoke all on function public.cmd_cancel_shift(text, uuid, bigint, timestamptz, text, text, jsonb) from public;
grant execute on function public.cmd_cancel_shift(text, uuid, bigint, timestamptz, text, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- reassign_shift: insert a new shift_assignments row for the named
-- worker, withdraw the previous one, and transition the shift to
-- reassigned. Existing evidence is preserved.
------------------------------------------------------------------------

create or replace function public.cmd_reassign_shift(
  p_command_id          text,
  p_shift_id            uuid,
  p_expected_version    bigint,
  p_claimed_at          timestamptz,
  p_client_tz           text,
  p_new_worker_membership uuid,
  p_reason              text,
  p_payload             jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_role               text;
  v_existing           record;
  v_receipt_id         uuid;
  v_new_assignment_id  uuid;
  v_old                public.shift_assignments%rowtype;
begin
  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  v_role := public.current_user_membership_role();
  if v_role not in ('admin','scheduler') then
    raise exception 'reassign_requires_admin_or_scheduler' using errcode = '42501';
  end if;

  -- Validate the new worker membership belongs to the same org and
  -- has worker role, and is currently effective.
  if not exists (
    select 1
    from public.organisation_memberships m
    where m.id = p_new_worker_membership
      and m.organisation_id = v_shift.organisation_id
      and m.role = 'worker'
      and m.status = 'active'
      and m.effective_from <= now()
      and (m.effective_until is null or m.effective_until > now())
  ) then
    raise exception 'invalid_target_worker' using errcode = 'P0001';
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'reassign_shift', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'reassign_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version),
      true,
      jsonb_build_object('reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  -- Insert the new active assignment, withdraw the prior one.
  insert into public.shift_assignments (
    shift_id, organisation_id, membership_id, effective_from, assigned_by, reassignment_reason
  )
  values (
    p_shift_id, v_shift.organisation_id, p_new_worker_membership, now(),
    auth.uid(), p_reason
  )
  returning id into v_new_assignment_id;

  update public.shift_assignments
    set withdrawn_at = now(),
        superseded_by = v_new_assignment_id,
        effective_until = now()
    where shift_id = p_shift_id
      and withdrawn_at is null
      and id <> v_new_assignment_id
    returning * into v_old;

  update public.shifts
    set version = version + 1
    where id = p_shift_id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'reassigned', 'shift.reassigned',
    jsonb_build_object(
      'command_id',p_command_id,
      'reason',p_reason,
      'new_assignment_id',v_new_assignment_id,
      'previous_assignment_id', v_old.id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'reassign_shift', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
    'accepted',
    jsonb_build_object(
      'new_assignment_id',v_new_assignment_id,
      'previous_assignment_id',v_old.id,
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1,
      'reason',p_reason
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'new_assignment_id', v_new_assignment_id,
    'version', p_expected_version + 1
  );
end;
$$;

revoke all on function public.cmd_reassign_shift(text, uuid, bigint, timestamptz, text, uuid, text, jsonb) from public;
grant execute on function public.cmd_reassign_shift(text, uuid, bigint, timestamptz, text, uuid, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- resolve_conflict: supervisor decision on evidence_review_queue row.
------------------------------------------------------------------------
-- Decisions are one-way: once a review is decided, only updates to the
-- same decided state are permitted (the constraint on the table
-- rejects rewrites of decided_by / decided_at). The original receipt
-- is also rewritten to a single outcome.

create or replace function public.cmd_resolve_conflict(
  p_command_id   text,
  p_review_id    uuid,
  p_decision     text,
  p_reason       text,
  p_payload      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_review             public.evidence_review_queue%rowtype;
  v_original           public.command_receipts%rowtype;
  v_shift              public.shifts%rowtype;
  v_membership_id      uuid;
  v_role               text;
  v_receipt_id         uuid;
  v_existing           record;
  v_receipt_status     text;
  v_authoritative_state text;
begin
  if p_decision not in ('accept_exception','reject','needs_more_info') then
    raise exception 'invalid_decision' using errcode = '22P02';
  end if;

  select * into v_review
  from public.evidence_review_queue
  where id = p_review_id
  for update;
  if v_review.id is null then
    raise exception 'review_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_review.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  v_role := public.current_user_membership_role();
  if v_role not in ('admin','scheduler') then
    raise exception 'resolve_requires_admin_or_scheduler'
      using errcode = '42501';
  end if;

  if v_review.state <> 'pending' then
    raise exception 'review_already_decided' using errcode = 'P0001';
  end if;

  select * into v_original
  from public.command_receipts
  where id = v_review.receipt_id
  for share;
  if v_original.id is null then
    raise exception 'original_receipt_not_found' using errcode = 'P0002';
  end if;

  if v_original.subject_shift_id is not null then
    select * into v_shift
    from public.shifts
    where id = v_original.subject_shift_id
      and organisation_id = v_review.organisation_id
    for update;
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_review.organisation_id, v_membership_id, 'resolve_conflict', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  -- accept_exception applies the preserved evidence to the original
  -- subject when the command has an authoritative shift transition.
  -- The original receipt remains immutable; this decision receipt links
  -- back to it and records the resulting state/version.
  if p_decision = 'accept_exception' and v_shift.id is not null then
    v_authoritative_state := case v_original.command_type
      when 'start_shift' then 'started'
      when 'end_shift' then 'ended_summary_required'
      when 'cancel_shift' then 'cancelled'
      else null
    end;
    if v_authoritative_state is not null
       and v_shift.state not in ('finalised','corrected','cancelled') then
      update public.shifts
        set state = v_authoritative_state,
            version = version + 1
        where id = v_shift.id;
      v_shift.state := v_authoritative_state;
      v_shift.version := v_shift.version + 1;
    end if;
  end if;

  update public.evidence_review_queue
    set state = case p_decision
                  when 'accept_exception' then 'accepted_exception'
                  when 'reject' then 'rejected_with_reason'
                  when 'needs_more_info' then 'needs_more_info'
                end,
        decision_reason = p_reason,
        decided_by = auth.uid(),
        decided_at = now(),
        updated_at = now()
    where id = p_review_id;

  if v_original.subject_shift_id is not null then
    perform public.record_shift_audit(
      v_review.organisation_id, v_original.subject_shift_id, v_membership_id,
      'resolved', 'evidence_review.' || p_decision,
      jsonb_build_object(
        'reason',p_reason,
        'command_id',p_command_id,
        'review_id',p_review_id,
        'original_receipt_id',v_original.id,
        'authoritative_state',v_authoritative_state,
        'authoritative_version',case when v_shift.id is null then null else v_shift.version end
      )
    );
  end if;

  v_receipt_status := case p_decision
    when 'accept_exception' then 'accepted'
    when 'reject' then 'rejected'
    when 'needs_more_info' then 'rejected'
  end;

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'resolve_conflict', v_review.organisation_id, v_membership_id,
    v_original.subject_shift_id, null, now(), null, p_payload,
    v_receipt_status,
    jsonb_build_object(
      'review_id',v_review.id,
      'decision',p_decision,
      'reason',p_reason,
      'original_receipt_id',v_original.id,
      'authoritative_state',v_authoritative_state,
      'authoritative_version',case when v_shift.id is null then null else v_shift.version end
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status', v_receipt_status,
    'receipt_id', v_receipt_id,
    'review_id', v_review.id,
    'decision', p_decision,
    'original_receipt_id', v_original.id,
    'authoritative_state', v_authoritative_state,
    'authoritative_version', case when v_shift.id is null then null else v_shift.version end
  );
end;
$$;

revoke all on function public.cmd_resolve_conflict(text, uuid, text, text, jsonb) from public;
grant execute on function public.cmd_resolve_conflict(text, uuid, text, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- request_correction: participant / representative / worker logs an
-- explicit pending correction request. Audited atomically. NEVER
-- silently mutates anything.
------------------------------------------------------------------------

-- Non-membership portal actors use their immutable profile identity as the
-- idempotency dimension. They never borrow another person's membership.
create or replace function public.lookup_command_receipt_profile(
  p_organisation_id uuid,
  p_actor_profile    uuid,
  p_command_type    text,
  p_command_id      text
)
returns table (
  found boolean,
  status text,
  outcome jsonb,
  receipt_id uuid,
  server_received_at timestamptz,
  subject_shift_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select true, r.status, r.outcome, r.id, r.server_received_at, r.subject_shift_id
  from public.command_receipts r
  where r.organisation_id = p_organisation_id
    and r.actor_profile_id = p_actor_profile
    and r.command_type = p_command_type
    and r.command_id = p_command_id
    and (auth.role() = 'service_role' or p_actor_profile = auth.uid())
  limit 1
$$;

revoke all on function public.lookup_command_receipt_profile(uuid, uuid, text, text) from public;
grant execute on function public.lookup_command_receipt_profile(uuid, uuid, text, text) to authenticated;

create or replace function public.record_command_outcome_profile(
  p_command_id text,
  p_command_type text,
  p_organisation_id uuid,
  p_actor_profile uuid,
  p_subject_shift_id uuid,
  p_payload jsonb,
  p_status text,
  p_outcome jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt_id uuid;
begin
  if auth.role() <> 'service_role' and p_actor_profile <> auth.uid() then
    raise exception 'actor_profile_mismatch' using errcode = '42501';
  end if;
  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    actor_profile_id, subject_shift_id, claimed_at, server_received_at,
    completed_at, status, outcome, payload
  ) values (
    p_command_id, p_command_type, p_organisation_id, null, p_actor_profile,
    p_subject_shift_id, now(), now(), now(), p_status, p_outcome,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (organisation_id, actor_profile_id, command_type, command_id)
  do update set server_received_at = public.command_receipts.server_received_at
  returning id into v_receipt_id;
  return v_receipt_id;
end;
$$;

revoke all on function public.record_command_outcome_profile(text, text, uuid, uuid, uuid, jsonb, text, jsonb) from public;

-- Actors:
--   workforce: requires an active membership in the shift's org.
--   participant_self: requires an active participant_self_links row
--     for the shift's participant.
--   representative: requires an active, in-window
--     representative_authorities row whose scope includes
--     'service_summary' for the shift's participant.

create or replace function public.cmd_request_correction(
  p_command_id        text,
  p_shift_id          uuid,
  p_reason            text,
  p_requested_changes text,
  p_payload           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_shift              public.shifts%rowtype;
  v_summary            public.service_summaries%rowtype;
  v_membership_id      uuid;
  v_membership_role    text;
  v_requester_kind     text;
  v_existing           record;
  v_receipt_id         uuid;
  v_request_id         uuid;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_shift.organisation_id);
  if v_membership_id is not null then
    select m.role into v_membership_role
    from public.organisation_memberships m
    where m.id = v_membership_id
      and m.profile_id = v_uid
      and m.organisation_id = v_shift.organisation_id;
    if v_membership_role not in ('admin','scheduler','worker') then
      v_membership_id := null;
    end if;
  end if;

  -- Determine requester class.
  if v_membership_id is not null then
    v_requester_kind := 'workforce';
  elsif exists (
    select 1 from public.participant_self_links psl
    where psl.participant_id = v_shift.participant_id
      and psl.profile_id = auth.uid()
      and psl.status = 'active'
  ) then
    v_requester_kind := 'participant_self';
  elsif exists (
    select 1 from public.representative_authorities ra
    where ra.participant_id = v_shift.participant_id
      and ra.representative_profile_id = auth.uid()
      and ra.status = 'active'
      and ra.effective_from <= now()
      and (ra.effective_until is null or ra.effective_until > now())
      and 'service_summary' = any (ra.scope_categories)
  ) then
    v_requester_kind := 'representative';
  else
    raise exception 'not_authorized_to_request_correction'
      using errcode = '42501';
  end if;

  if v_membership_id is not null then
    select * into v_existing from public.lookup_command_receipt(
      v_shift.organisation_id, v_membership_id, 'request_correction', p_command_id
    );
  else
    select * into v_existing from public.lookup_command_receipt_profile(
      v_shift.organisation_id, v_uid, 'request_correction', p_command_id
    );
  end if;
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  select * into v_summary
  from public.service_summaries
  where shift_id = p_shift_id;

  insert into public.correction_requests (
    organisation_id, shift_id, summary_id, requester_kind, requester_profile_id,
    reason, requested_changes
  )
  values (
    v_shift.organisation_id, p_shift_id, v_summary.id, v_requester_kind, auth.uid(),
    p_reason, p_requested_changes
  )
  returning id into v_request_id;

  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    v_shift.organisation_id, auth.uid(),
    'correction.requested',
    'shift', p_shift_id,
    jsonb_build_object(
      'command_id',p_command_id,
      'reason',p_reason,
      'requested_changes',p_requested_changes,
      'requester_kind',v_requester_kind,
      'request_id',v_request_id
    )
  );

  if v_membership_id is not null then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'request_correction', v_shift.organisation_id, v_membership_id,
      p_shift_id, null, now(), null, p_payload, 'accepted',
      jsonb_build_object('shift_id',p_shift_id,'request_id',v_request_id,
        'requester_kind',v_requester_kind,'reason',p_reason), false, null);
  else
    v_receipt_id := public.record_command_outcome_profile(
      p_command_id, 'request_correction', v_shift.organisation_id, v_uid,
      p_shift_id, p_payload, 'accepted',
      jsonb_build_object('shift_id',p_shift_id,'request_id',v_request_id,
        'requester_kind',v_requester_kind,'reason',p_reason));
  end if;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'request_id', v_request_id,
    'requester_kind', v_requester_kind
  );
end;
$$;

revoke all on function public.cmd_request_correction(text, uuid, text, text, jsonb) from public;
grant execute on function public.cmd_request_correction(text, uuid, text, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- request_access: formal access / correction request under qualified
-- policy. Audited atomically. NEVER silently alters a grant or
-- historical record.
------------------------------------------------------------------------

create or replace function public.cmd_request_access(
  p_command_id        text,
  p_participant_id    uuid,
  p_scope_categories  text[],
  p_reason            text,
  p_payload           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_participant        public.participants%rowtype;
  v_membership_id      uuid;
  v_membership_role    text;
  v_existing           record;
  v_receipt_id         uuid;
  v_request_id         uuid;
  v_requester_kind     text;
begin
  select * into v_participant
  from public.participants
  where id = p_participant_id;
  if v_participant.id is null then
    raise exception 'participant_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_participant.organisation_id);
  if v_membership_id is not null then
    select m.role into v_membership_role
    from public.organisation_memberships m
    where m.id = v_membership_id
      and m.profile_id = v_uid
      and m.organisation_id = v_participant.organisation_id;
    if v_membership_role not in ('admin','scheduler','worker') then
      v_membership_id := null;
    end if;
  end if;
  if v_membership_id is not null then
    v_requester_kind := 'workforce';
  elsif exists (
    select 1 from public.participant_self_links psl
    where psl.participant_id = p_participant_id
      and psl.profile_id = auth.uid()
      and psl.status = 'active'
  ) then
    v_requester_kind := 'participant_self';
  elsif exists (
    select 1 from public.representative_authorities ra
    where ra.participant_id = p_participant_id
      and ra.representative_profile_id = auth.uid()
      and ra.status = 'active'
      and ra.effective_from <= now()
      and (ra.effective_until is null or ra.effective_until > now())
  ) then
    v_requester_kind := 'representative';
  else
    -- An external grant recipient may also request access.
    if exists (
      select 1 from public.external_disclosure_grants g
      where g.participant_id = p_participant_id
        and g.recipient_profile_id = auth.uid()
        and g.status = 'active'
        and g.effective_from <= now()
        and g.effective_until > now()
    ) then
      v_requester_kind := 'external';
    else
      raise exception 'not_authorized_to_request_access' using errcode = '42501';
    end if;
  end if;

  if v_membership_id is not null then
    select * into v_existing from public.lookup_command_receipt(
      v_participant.organisation_id, v_membership_id, 'request_access', p_command_id);
  else
    select * into v_existing from public.lookup_command_receipt_profile(
      v_participant.organisation_id, v_uid, 'request_access', p_command_id);
  end if;
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  insert into public.access_requests (
    organisation_id, requester_profile_id, participant_id,
    scope_categories, reason
  )
  values (
    v_participant.organisation_id, auth.uid(), p_participant_id,
    p_scope_categories, p_reason
  )
  returning id into v_request_id;

  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    v_participant.organisation_id, auth.uid(),
    'access.requested',
    'participant', p_participant_id,
    jsonb_build_object(
      'command_id',p_command_id,
      'reason',p_reason,
      'scope_categories',p_scope_categories,
      'requester_kind',v_requester_kind,
      'request_id',v_request_id
    )
  );

  if v_membership_id is not null then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'request_access', v_participant.organisation_id, v_membership_id,
      null, null, now(), null, p_payload, 'accepted',
      jsonb_build_object('request_id',v_request_id,'requester_kind',v_requester_kind,
        'participant_id',p_participant_id,'scope_categories',p_scope_categories), false, null);
  else
    v_receipt_id := public.record_command_outcome_profile(
      p_command_id, 'request_access', v_participant.organisation_id, v_uid,
      null, p_payload, 'accepted',
      jsonb_build_object('request_id',v_request_id,'requester_kind',v_requester_kind,
        'participant_id',p_participant_id,'scope_categories',p_scope_categories));
  end if;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'request_id', v_request_id,
    'requester_kind', v_requester_kind
  );
end;
$$;

revoke all on function public.cmd_request_access(text, uuid, text[], text, jsonb) from public;
grant execute on function public.cmd_request_access(text, uuid, text[], text, jsonb) to authenticated;

------------------------------------------------------------------------
-- apply_correction: authorised supervisor creates a NEW version row.
-- Original version remains immutable. The shift state moves to
-- 'corrected'. Takes a request_id (mandatory) and rejects when the
-- underlying summary is not in 'finalised' state.
------------------------------------------------------------------------

create or replace function public.cmd_apply_correction(
  p_command_id         text,
  p_request_id         uuid,
  p_expected_version   bigint,
  p_claimed_at         timestamptz,
  p_client_tz          text,
  p_activities         text[],
  p_summary_text       text,
  p_audience           text[],
  p_reason             text,
  p_payload            jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_request            public.correction_requests%rowtype;
  v_shift              public.shifts%rowtype;
  v_summary            public.service_summaries%rowtype;
  v_existing_version   public.service_summary_versions%rowtype;
  v_new_version        public.service_summary_versions%rowtype;
  v_membership_id      uuid;
  v_role               text;
  v_existing           record;
  v_receipt_id         uuid;
begin
  select * into v_request
  from public.correction_requests
  where id = p_request_id
  for update;
  if v_request.id is null then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'request_already_decided' using errcode = 'P0001';
  end if;

  if v_request.shift_id is null then
    raise exception 'request_missing_shift' using errcode = 'P0001';
  end if;

  select * into v_shift from public.shifts where id = v_request.shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_membership(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  v_role := public.current_user_membership_role();
  if v_role not in ('admin','scheduler') then
    raise exception 'correction_requires_admin_or_scheduler' using errcode = '42501';
  end if;

  if v_shift.state <> 'finalised' then
    raise exception 'summary_not_finalised'
      using errcode = 'P0001', detail = v_shift.state;
  end if;

  select * into v_summary
  from public.service_summaries
  where shift_id = v_shift.id;
  if v_summary.current_version_id is null then
    raise exception 'no_summary_to_correct' using errcode = 'P0001';
  end if;

  select * into v_existing_version
  from public.service_summary_versions
  where id = v_summary.current_version_id;
  if v_existing_version.id is null then
    raise exception 'summary_version_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id, v_membership_id, 'apply_correction', p_command_id
  );
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'outcome', v_existing.outcome
    );
  end if;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id, 'apply_correction', v_shift.organisation_id, v_membership_id,
      v_shift.id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
      'conflict_preserved',
      jsonb_build_object('reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version),
      true,
      jsonb_build_object('reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  insert into public.service_summary_versions (
    summary_id, version_number, activities, summary_text, audience_categories,
    author_membership_id, is_correction, correction_reason
  )
  values (
    v_summary.id, v_existing_version.version_number + 1,
    p_activities, p_summary_text, p_audience,
    v_membership_id, true, p_reason
  )
  returning * into v_new_version;

  update public.service_summary_versions
    set superseded_by = v_new_version.id
    where id = v_existing_version.id;

  update public.service_summaries
    set current_version_id = v_new_version.id,
        finalised_at = now(),
        has_correction = true,
        updated_at = now()
    where id = v_summary.id;

  update public.shifts
    set state = 'corrected',
        version = version + 1
    where id = v_shift.id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  update public.correction_requests
    set status = 'approved',
        decided_by = auth.uid(),
        decided_at = now(),
        decision_reason = p_reason,
        updated_at = now()
    where id = p_request_id;

  perform public.record_shift_audit(
    v_shift.organisation_id, v_shift.id, v_membership_id,
    'corrected', 'shift.corrected',
    jsonb_build_object(
      'command_id',p_command_id,
      'previous_version_id',v_existing_version.id,
      'new_version_id',v_new_version.id,
      'correction_reason',p_reason,
      'request_id',p_request_id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id, 'apply_correction', v_shift.organisation_id, v_membership_id,
    v_shift.id, p_expected_version, p_claimed_at, p_client_tz, p_payload,
    'accepted',
    jsonb_build_object(
      'summary_id',v_summary.id,
      'previous_version_id',v_existing_version.id,
      'new_version_id',v_new_version.id,
      'new_state','corrected',
      'request_id',p_request_id
    ),
    false,
    null
  );

  return jsonb_build_object(
    'status','accepted',
    'receipt_id', v_receipt_id,
    'summary_id', v_summary.id,
    'previous_version_id', v_existing_version.id,
    'new_version_id', v_new_version.id,
    'new_state','corrected'
  );
end;
$$;

revoke all on function public.cmd_apply_correction(text, uuid, bigint, timestamptz, text, text[], text, text[], text, jsonb) from public;
grant execute on function public.cmd_apply_correction(text, uuid, bigint, timestamptz, text, text[], text, text[], text, jsonb) to authenticated;
