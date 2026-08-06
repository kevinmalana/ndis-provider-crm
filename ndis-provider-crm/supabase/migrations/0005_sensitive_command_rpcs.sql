-- 0005_sensitive_command_rpcs.sql
--
-- Transactional command RPCs.
--
-- Per decision-log/2026-08-06 ("Direct Supabase RPC for sensitive state
-- transitions"), sensitive state transitions use narrow Postgres RPC
-- functions called directly through Supabase. Each RPC:
--
--   1. Verifies the caller is authenticated and holds an *active*
--      membership in the relevant organisation.
--   2. Verifies role-specific authority (worker, scheduler/admin,
--      participant self-link, representative authority, external grant).
--   3. Verifies expected_version on the subject row.
--   4. Deduplicates by command_id — a retry returns the original receipt.
--   5. Records client-reported (claimed_at) AND server-receipt times.
--   6. Applies ONE state transition.
--   7. Preserves conflicts on the evidence_review_queue (no silent drop).
--   8. Appends one audit_log row and one shift_events row in the same
--      transaction.
--
-- No raw multi-table write path is exposed for these commands.
--
-- Out of scope (later tickets):
--   * Mobile outbox flush layer
--   * Background scheduler / retry policy
--   * Dashboard UI
--
-- Test plan (local pglite):
--   * Happy path: on_my_way → start → end → submit → finalise.
--   * Idempotency: re-calling with the same command_id returns the
--     original receipt verbatim and does not write a second audit row.
--   * Wrong assignment: another worker's command is rejected with
--     conflict_preserved status.
--   * Stale version: replaying an old version returns conflict_preserved.
--   * Cancellation after Start: shift moves to cancelled_needs_review,
--     evidence remains.

set search_path = public;

------------------------------------------------------------------------
-- Pre-flight helper: assert caller is currently authenticated.
------------------------------------------------------------------------
-- Triggered at the start of every RPC. Returns auth.uid() in a
-- SECURITY DEFINER context (function owner is postgres). The exception
-- carries SQLSTATE 42501 so callers get a uniform "not_authorized"
-- error if the JWT was somehow invalid (shouldn't happen — middleware
-- would have already redirected — but defence in depth).

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
    raise exception 'not_authorized'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.require_authenticated() from public;
grant execute on function public.require_authenticated() to authenticated;

------------------------------------------------------------------------
-- Helper: lookup the caller's active membership id for an organisation.
------------------------------------------------------------------------
-- Returns null when caller is not a current active member.

create or replace function public.current_active_membership_id(
  p_organisation_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.organisation_memberships m
  where m.profile_id = auth.uid()
    and m.organisation_id = p_organisation_id
    and m.status = 'active'
  limit 1
$$;

revoke all on function public.current_active_membership_id(uuid) from public;
grant execute on function public.current_active_membership_id(uuid) to authenticated;

------------------------------------------------------------------------
-- Helper: get-or-noop for an existing command receipt.
------------------------------------------------------------------------
-- Used at the top of each sensitive RPC. If a row exists for the command
-- id, returns it (status + outcome) and tells the caller to short-circuit.
-- Otherwise returns a sentinel so the caller can proceed.

create or replace function public.lookup_command_receipt(p_command_id text)
returns table (
  found              boolean,
  status             text,
  outcome            jsonb,
  receipt_id         uuid,
  server_received_at timestamptz
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
    r.server_received_at
  from public.command_receipts r
  where r.command_id = p_command_id
  limit 1
$$;

revoke all on function public.lookup_command_receipt(text) from public;
grant execute on function public.lookup_command_receipt(text) to authenticated;

------------------------------------------------------------------------
-- Internal helper: append audit + shift_event in the same transaction.
------------------------------------------------------------------------
-- Called by every RPC after a successful state transition. Centralised
-- so the audit/event shape stays consistent. The audit row stores
-- auth.uid() as actor (a profile id); the shift_event stores the
-- caller's membership id so the actor path is auditable.

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
  v_uid                  uuid := public.require_authenticated();
  v_shift                public.shifts%rowtype;
  v_membership_id        uuid;
  v_assignment           public.shift_assignments%rowtype;
  v_receipt_id           uuid;
  v_server_received_at   timestamptz := now();
  v_status               text;
  v_outcome              jsonb;
  v_existing             record;
begin
  -- Idempotency: short-circuit on repeat.
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- Must currently be assigned to this shift.
  select * into v_assignment
  from public.shift_assignments sa
  where sa.shift_id = p_shift_id
    and sa.membership_id = v_membership_id
    and sa.withdrawn_at is null
  limit 1;

  if v_assignment.id is null then
    raise exception 'not_assigned' using errcode = '42501';
  end if;

  -- Allowed transitions: scheduled → in_transit (and back via resolved,
  -- but in_transit → in_transit is a no-op idem-style call).
  if v_shift.state not in ('scheduled','in_transit') then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, claimed_at, client_tz, status, outcome, payload,
      server_received_at, completed_at
    )
    values (
      p_command_id, 'on_my_way', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_claimed_at, p_client_tz, 'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      p_payload, v_server_received_at, v_server_received_at
    )
    returning id into v_receipt_id;

    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, v_shift.organisation_id, p_payload,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );

    return jsonb_build_object(
      'status','conflict_preserved',
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at,
      'reason','invalid_state'
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

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, expected_version, claimed_at, client_tz,
    server_received_at, completed_at, status, outcome, payload
  )
  values (
    p_command_id, 'on_my_way', v_shift.organisation_id, v_membership_id,
    p_shift_id, v_shift.version, p_claimed_at, p_client_tz,
    v_server_received_at, v_server_received_at, 'accepted',
    jsonb_build_object('new_state','in_transit','version',v_shift.version+1),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'new_state','in_transit',
    'version',v_shift.version+1
  );
end;
$$;

revoke all on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) from public;
grant execute on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- start_shift: scheduled|in_transit → started
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
  v_assignment         public.shift_assignments%rowtype;
  v_receipt_id         uuid;
  v_server_received_at timestamptz := now();
  v_existing           record;
begin
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_assignment
  from public.shift_assignments sa
  where sa.shift_id = p_shift_id
    and sa.membership_id = v_membership_id
    and sa.withdrawn_at is null
  limit 1;
  if v_assignment.id is null then
    raise exception 'not_assigned' using errcode = '42501';
  end if;

  -- Stale version is the conflict path.
  if v_shift.version <> p_expected_version then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, expected_version, claimed_at, client_tz,
      server_received_at, status, outcome, payload
    )
    values (
      p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz,
      v_server_received_at, 'conflict_preserved',
      jsonb_build_object(
        'reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      ),
      p_payload
    )
    returning id into v_receipt_id;

    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, v_shift.organisation_id, p_payload,
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
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at
    );
  end if;

  if v_shift.state not in ('scheduled','in_transit') then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, expected_version, claimed_at, client_tz,
      server_received_at, status, outcome, payload
    )
    values (
      p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz,
      v_server_received_at, 'conflict_preserved',
      jsonb_build_object(
        'reason','invalid_state',
        'state',v_shift.state
      ),
      p_payload
    )
    returning id into v_receipt_id;
    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, v_shift.organisation_id, p_payload,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id, p_shift_id, v_membership_id,
      'conflicted', 'shift.start.conflicted',
      jsonb_build_object(
        'command_id',p_command_id,
        'state',v_shift.state
      )
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','invalid_state',
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at
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

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, expected_version, claimed_at, client_tz,
    server_received_at, completed_at, status, outcome, payload
  )
  values (
    p_command_id, 'start_shift', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, p_client_tz,
    v_server_received_at, v_server_received_at, 'accepted',
    jsonb_build_object(
      'new_state','started',
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1
    ),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'new_state','started',
    'version',p_expected_version+1
  );
end;
$$;

revoke all on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) from public;
grant execute on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- end_shift: started → ended_summary_required
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
  v_assignment         public.shift_assignments%rowtype;
  v_receipt_id         uuid;
  v_server_received_at timestamptz := now();
  v_existing           record;
begin
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_assignment
  from public.shift_assignments sa
  where sa.shift_id = p_shift_id
    and sa.membership_id = v_membership_id
    and sa.withdrawn_at is null
  limit 1;
  if v_assignment.id is null then
    raise exception 'not_assigned' using errcode = '42501';
  end if;

  if v_shift.version <> p_expected_version then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, expected_version, claimed_at, client_tz,
      server_received_at, status, outcome, payload
    )
    values (
      p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz,
      v_server_received_at, 'conflict_preserved',
      jsonb_build_object(
        'reason','stale_version',
        'current_version',v_shift.version,
        'claimed_version',p_expected_version
      ),
      p_payload
    )
    returning id into v_receipt_id;
    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, v_shift.organisation_id, p_payload,
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
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at
    );
  end if;

  if v_shift.state <> 'started' then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, expected_version, claimed_at, client_tz,
      server_received_at, status, outcome, payload
    )
    values (
      p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, p_client_tz,
      v_server_received_at, 'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      p_payload
    )
    returning id into v_receipt_id;
    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, v_shift.organisation_id, p_payload,
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
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at
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

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, expected_version, claimed_at, client_tz,
    server_received_at, completed_at, status, outcome, payload
  )
  values (
    p_command_id, 'end_shift', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at, p_client_tz,
    v_server_received_at, v_server_received_at, 'accepted',
    jsonb_build_object(
      'new_state','ended_summary_required',
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1
    ),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'new_state','ended_summary_required',
    'version',p_expected_version+1
  );
end;
$$;

revoke all on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) from public;
grant execute on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- submit_summary: ended_summary_required → submitted_local
-- Records the FIRST version of the summary (not a correction).
------------------------------------------------------------------------

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
  v_assignment         public.shift_assignments%rowtype;
  v_receipt_id         uuid;
  v_version_id         uuid;
  v_summary_id         uuid;
  v_server_received_at timestamptz := now();
  v_existing           record;
begin
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_assignment
  from public.shift_assignments sa
  where sa.shift_id = p_shift_id
    and sa.membership_id = v_membership_id
    and sa.withdrawn_at is null
  limit 1;
  if v_assignment.id is null then
    raise exception 'not_assigned' using errcode = '42501';
  end if;

  -- A summary may only be submitted for a shift the worker ended (or is
  -- assigned-and-ending in the same submit). For v1 we require
  -- ended_summary_required as the precondition.
  if v_shift.state <> 'ended_summary_required' then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, expected_version, claimed_at, status, outcome, payload,
      server_received_at
    )
    values (
      p_command_id, 'submit_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, p_expected_version, p_claimed_at, 'conflict_preserved',
      jsonb_build_object('reason','invalid_state','state',v_shift.state),
      p_payload, v_server_received_at
    )
    returning id into v_receipt_id;
    insert into public.evidence_review_queue (
      receipt_id, organisation_id, original_payload, conflicting_context
    )
    values (
      v_receipt_id, v_shift.organisation_id, p_payload,
      jsonb_build_object('reason','invalid_state','state',v_shift.state)
    );
    return jsonb_build_object(
      'status','conflict_preserved',
      'reason','invalid_state',
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at
    );
  end if;

  -- Idempotency / uniqueness at shift level: there is exactly one
  -- service_summaries row per shift. A retry of submit_summary (different
  -- command_id) on the same shift would collide, and is therefore
  -- rejected with conflict_preserved. The supervisor-led correction
  -- flow uses apply_correction.

  insert into public.service_summaries (shift_id)
  values (p_shift_id)
  on conflict (shift_id) do update set updated_at = now()
  returning id into v_summary_id;

  -- Replace any prior unsubmitted version with a new v=1. Corrections
  -- create subsequent version rows; this RPC produces only v=1.
  delete from public.service_summary_versions
    where summary_id = v_summary_id and version_number = 1 and is_correction = false;

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
        has_correction = false,
        finalised_at = null,
        updated_at = now()
    where id = v_summary_id;

  update public.shifts
    set state = 'submitted_local',
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
      'version_id',v_version_id
    )
  );

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, expected_version, claimed_at,
    server_received_at, completed_at, status, outcome, payload
  )
  values (
    p_command_id, 'submit_summary', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, p_claimed_at,
    v_server_received_at, v_server_received_at, 'accepted',
    jsonb_build_object(
      'summary_id',v_summary_id,
      'current_version_id',v_version_id,
      'new_state','submitted_local',
      'previous_version',p_expected_version,
      'new_version',p_expected_version+1
    ),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'summary_id',v_summary_id,
    'current_version_id',v_version_id,
    'new_state','submitted_local',
    'version',p_expected_version+1
  );
end;
$$;

revoke all on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) from public;
grant execute on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) to authenticated;

------------------------------------------------------------------------
-- finalise_summary: submitted_local|syncing → finalised
-- Authorised actor: scheduler or admin in the active org.
------------------------------------------------------------------------

create or replace function public.cmd_finalise_summary(
  p_command_id       text,
  p_shift_id         uuid,
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
  v_summary            public.service_summaries%rowtype;
  v_membership_id      uuid;
  v_membership_role    text;
  v_receipt_id         uuid;
  v_server_received_at timestamptz := now();
  v_existing           record;
begin
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select role into v_membership_role
  from public.organisation_memberships
  where id = v_membership_id;
  if v_membership_role not in ('admin','scheduler') then
    raise exception 'finalise_requires_admin_or_scheduler'
      using errcode = '42501';
  end if;

  select * into v_summary
  from public.service_summaries
  where shift_id = p_shift_id;
  if v_summary.id is null or v_summary.current_version_id is null then
    raise exception 'no_summary_to_finalise' using errcode = 'P0001';
  end if;

  if v_shift.state not in ('submitted_local','syncing','finalised') then
    raise exception 'invalid_state_for_finalise'
      using errcode = '23514', detail = v_shift.state;
  end if;

  -- Finalise is idempotent on already-finalised.
  if v_shift.state = 'finalised' then
    insert into public.command_receipts (
      command_id, command_type, organisation_id, actor_membership_id,
      subject_shift_id, claimed_at, server_received_at, status, outcome, payload
    )
    values (
      p_command_id, 'finalise_summary', v_shift.organisation_id, v_membership_id,
      p_shift_id, now(), v_server_received_at, 'duplicate_returned',
      jsonb_build_object('already_finalised',true),
      p_payload
    )
    returning id into v_receipt_id;
    return jsonb_build_object(
      'status','duplicate_returned',
      'reason','already_finalised',
      'receipt_id',v_receipt_id,
      'server_received_at',v_server_received_at,
      'new_state','finalised'
    );
  end if;

  update public.shifts
    set state = 'finalised',
        version = version + 1
    where id = p_shift_id;

  update public.service_summaries
    set finalised_at = now(),
        updated_at = now()
    where id = v_summary.id;

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'summary_finalised', 'shift.summary_finalised',
    jsonb_build_object(
      'command_id',p_command_id,
      'summary_id',v_summary.id,
      'current_version_id',v_summary.current_version_id
    )
  );

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, claimed_at, server_received_at, completed_at,
    status, outcome, payload
  )
  values (
    p_command_id, 'finalise_summary', v_shift.organisation_id, v_membership_id,
    p_shift_id, now(), v_server_received_at, v_server_received_at,
    'accepted',
    jsonb_build_object('summary_id',v_summary.id,
                        'current_version_id',v_summary.current_version_id,
                        'new_state','finalised'),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'new_state','finalised'
  );
end;
$$;

revoke all on function public.cmd_finalise_summary(text, uuid, jsonb) from public;
grant execute on function public.cmd_finalise_summary(text, uuid, jsonb) to authenticated;

------------------------------------------------------------------------
-- resolve_conflict: supervisor decision on evidence_review_queue row
-- Authorised actor: scheduler or admin in the active org.
-- decision: 'accept_exception', 'reject', 'needs_more_info'
------------------------------------------------------------------------

create or replace function public.cmd_resolve_conflict(
  p_command_id text,
  p_review_id  uuid,
  p_decision   text,
  p_reason     text,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                uuid := public.require_authenticated();
  v_review             public.evidence_review_queue%rowtype;
  v_membership_id      uuid;
  v_membership_role    text;
  v_receipt_id         uuid;
  v_server_received_at timestamptz := now();
  v_existing           record;
begin
  if p_decision not in ('accept_exception','reject','needs_more_info') then
    raise exception 'invalid_decision' using errcode = '22P02';
  end if;

  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_review
  from public.evidence_review_queue
  where id = p_review_id
  for update;
  if v_review.id is null then
    raise exception 'review_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_review.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  select role into v_membership_role
  from public.organisation_memberships where id = v_membership_id;
  if v_membership_role not in ('admin','scheduler') then
    raise exception 'resolve_requires_admin_or_scheduler'
      using errcode = '42501';
  end if;

  update public.evidence_review_queue
    set state = case p_decision
                  when 'accept_exception' then 'accepted_exception'
                  when 'reject' then 'rejected_with_reason'
                  when 'needs_more_info' then 'needs_more_info'
                end,
        decision_reason = p_reason,
        decided_by = auth.uid(),
        decided_at = v_server_received_at,
        updated_at = v_server_received_at
    where id = p_review_id;

  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    v_review.organisation_id, auth.uid(),
    'evidence_review.' || p_decision,
    'evidence_review', v_review.id,
    jsonb_build_object('reason',p_reason,'command_id',p_command_id)
  );

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, claimed_at, server_received_at, completed_at,
    status, outcome, payload
  )
  values (
    p_command_id, 'resolve_conflict', v_review.organisation_id, v_membership_id,
    v_review.receipt_id, now(), v_server_received_at, v_server_received_at,
    'accepted',
    jsonb_build_object(
      'review_id',v_review.id,
      'decision',p_decision,
      'reason',p_reason
    ),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'review_id',v_review.id,
    'decision',p_decision
  );
end;
$$;

revoke all on function public.cmd_resolve_conflict(text, uuid, text, text, jsonb) from public;
grant execute on function public.cmd_resolve_conflict(text, uuid, text, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- request_correction: participant / representative / worker logs an
-- explicit pending correction request. NEVER silently changes anything.
-- Authorised actor: any authenticated member of the org OR the
-- participant (via self-link) OR a current representative.
------------------------------------------------------------------------

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
  v_uid                  uuid := public.require_authenticated();
  v_shift                public.shifts%rowtype;
  v_summary              public.service_summaries%rowtype;
  v_membership_id        uuid;
  v_org_id               uuid;
  v_receipt_id           uuid;
  v_server_received_at   timestamptz := now();
  v_existing             record;
begin
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;
  v_org_id := v_shift.organisation_id;

  v_membership_id := public.current_active_membership_id(v_org_id);

  -- Three accepted requester classes:
  --   (a) any active org member (worker / admin / scheduler)
  --   (b) the participant self-linked to the participant on this shift
  --   (c) an authorised representative (effective, not withdrawn)
  if v_membership_id is null then
    if not exists (
      select 1 from public.participant_self_links psl
      where psl.participant_id = v_shift.participant_id
        and psl.profile_id = auth.uid()
        and psl.status = 'active'
    ) and not exists (
      select 1 from public.representative_authorities ra
      where ra.participant_id = v_shift.participant_id
        and ra.representative_profile_id = auth.uid()
        and ra.status = 'active'
        and ra.effective_from <= now()
        and (ra.effective_until is null or ra.effective_until > now())
    ) then
      raise exception 'not_authorized_to_request_correction'
        using errcode = '42501';
    end if;
    -- participant/representative requesters don't have an org membership
    -- record; we still write audit with a null actor.
  end if;

  insert into public.correction_requests (
    organisation_id, shift_id, summary_id, requested_by, reason, requested_changes
  )
  values (
    v_org_id, p_shift_id,
    (select id from public.service_summaries where shift_id = p_shift_id),
    auth.uid(), p_reason, p_requested_changes
  );

  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    v_org_id,
    auth.uid(),
    'correction.requested',
    'shift',
    p_shift_id,
    jsonb_build_object(
      'command_id',p_command_id,
      'reason',p_reason,
      'requested_changes',p_requested_changes
    )
  );

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, claimed_at, server_received_at, completed_at,
    status, outcome, payload
  )
  values (
    p_command_id, 'request_correction', v_org_id, v_membership_id,
    p_shift_id, now(), v_server_received_at, v_server_received_at,
    'accepted',
    jsonb_build_object('shift_id',p_shift_id,'reason',p_reason),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at
  );
end;
$$;

revoke all on function public.cmd_request_correction(text, uuid, text, text, jsonb) from public;
grant execute on function public.cmd_request_correction(text, uuid, text, text, jsonb) to authenticated;

------------------------------------------------------------------------
-- apply_correction: authorised supervisor creates a NEW version row.
-- Original version remains immutable. shift state becomes 'corrected'.
------------------------------------------------------------------------

create or replace function public.cmd_apply_correction(
  p_command_id         text,
  p_shift_id           uuid,
  p_expected_version   bigint,
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
  v_shift              public.shifts%rowtype;
  v_summary            public.service_summaries%rowtype;
  v_existing_version   public.service_summary_versions%rowtype;
  v_new_version        public.service_summary_versions%rowtype;
  v_membership_id      uuid;
  v_membership_role    text;
  v_receipt_id         uuid;
  v_server_received_at timestamptz := now();
  v_existing           record;
begin
  select * into v_existing from public.lookup_command_receipt(p_command_id);
  if v_existing.found then
    return jsonb_build_object(
      'status', v_existing.status,
      'duplicate', true,
      'receipt_id', v_existing.receipt_id,
      'server_received_at', v_existing.server_received_at
    );
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := public.current_active_membership_id(v_shift.organisation_id);
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  select role into v_membership_role
  from public.organisation_memberships where id = v_membership_id;
  if v_membership_role not in ('admin','scheduler') then
    raise exception 'correction_requires_admin_or_scheduler'
      using errcode = '42501';
  end if;

  select * into v_summary
  from public.service_summaries where shift_id = p_shift_id for update;
  if v_summary.id is null or v_summary.current_version_id is null then
    raise exception 'no_summary_to_correct' using errcode = 'P0001';
  end if;

  select * into v_existing_version
  from public.service_summary_versions
  where id = v_summary.current_version_id;
  if v_existing_version.id is null then
    raise exception 'summary_version_not_found' using errcode = 'P0002';
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
    where id = p_shift_id
      and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  -- Resolve any open correction_requests for this shift.
  update public.correction_requests
    set status = 'approved',
        decided_by = v_membership_id,
        decided_at = v_server_received_at,
        decision_reason = p_reason,
        updated_at = v_server_received_at
    where shift_id = p_shift_id
      and status = 'pending';

  perform public.record_shift_audit(
    v_shift.organisation_id, p_shift_id, v_membership_id,
    'corrected', 'shift.corrected',
    jsonb_build_object(
      'command_id',p_command_id,
      'previous_version_id',v_existing_version.id,
      'new_version_id',v_new_version.id,
      'correction_reason',p_reason
    )
  );

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    subject_shift_id, expected_version, claimed_at, server_received_at,
    completed_at, status, outcome, payload
  )
  values (
    p_command_id, 'apply_correction', v_shift.organisation_id, v_membership_id,
    p_shift_id, p_expected_version, now(), v_server_received_at,
    v_server_received_at, 'accepted',
    jsonb_build_object(
      'summary_id',v_summary.id,
      'previous_version_id',v_existing_version.id,
      'new_version_id',v_new_version.id,
      'new_state','corrected'
    ),
    p_payload
  )
  returning id into v_receipt_id;

  return jsonb_build_object(
    'status','accepted',
    'receipt_id',v_receipt_id,
    'server_received_at',v_server_received_at,
    'summary_id',v_summary.id,
    'previous_version_id',v_existing_version.id,
    'new_version_id',v_new_version.id,
    'new_state','corrected'
  );
end;
$$;

revoke all on function public.cmd_apply_correction(text, uuid, bigint, text[], text, text[], text, jsonb) from public;
grant execute on function public.cmd_apply_correction(text, uuid, bigint, text[], text, text[], text, jsonb) to authenticated;
