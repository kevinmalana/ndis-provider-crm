begin;
set search_path = '';

create or replace function public.current_worker_route_state(p_organisation_id uuid)
returns table(
  has_emergency_route boolean,
  has_incident_route boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists(
      select 1
      from public.organisation_handoff_route_versions route
      where route.organisation_id = p_organisation_id
        and route.route_type = 'emergency'
        and route.status = 'active'
        and route.effective_from <= pg_catalog.now()
        and (route.effective_until is null or route.effective_until > pg_catalog.now())
    ) as has_emergency_route,
    exists(
      select 1
      from public.organisation_handoff_route_versions route
      where route.organisation_id = p_organisation_id
        and route.route_type = 'incident'
        and route.status = 'active'
        and route.effective_from <= pg_catalog.now()
        and (route.effective_until is null or route.effective_until > pg_catalog.now())
    ) as has_incident_route
$$;
revoke all on function public.current_worker_route_state(uuid) from public;
revoke all on function public.current_worker_route_state(uuid) from anon;
revoke all on function public.current_worker_route_state(uuid) from authenticated;

drop trigger if exists worker_handoff_receipts_immutable on public.worker_handoff_receipts;
create trigger worker_handoff_receipts_immutable
before update or delete on public.worker_handoff_receipts
for each row execute function public.prevent_05b_immutable_evidence();

create or replace function public.cmd_on_my_way(
  p_command_id text,
  p_shift_id uuid,
  p_claimed_at timestamptz,
  p_client_tz text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_membership_id uuid;
  v_existing record;
  v_receipt_id uuid;
  v_state_ok boolean := false;
  v_route_state record;
begin
  perform public.require_authenticated();

  select *
    into v_shift
  from public.shifts
  where id = p_shift_id
  for update;

  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(
    public.current_membership(v_shift.organisation_id),
    public.historical_membership(v_shift.organisation_id)
  );
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select *
    into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id,
    v_membership_id,
    'on_my_way',
    p_command_id
  );
  if v_existing.found then
    return pg_catalog.jsonb_build_object(
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
      p_command_id,
      'on_my_way',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      null,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'not_assigned'),
      true,
      pg_catalog.jsonb_build_object('reason', 'not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.on_my_way.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'reason', 'not_assigned')
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  select *
    into v_route_state
  from public.current_worker_route_state(v_shift.organisation_id);
  if not coalesce(v_route_state.has_emergency_route, false)
     or not coalesce(v_route_state.has_incident_route, false) then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'on_my_way',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      null,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      ),
      true,
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.on_my_way.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'urgent_routes_not_current',
      'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
      'has_incident_route', coalesce(v_route_state.has_incident_route, false),
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state in ('scheduled', 'in_transit');
  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'on_my_way',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      null,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state),
      true,
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.on_my_way.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'state', v_shift.state)
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'invalid_state',
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
    v_shift.organisation_id,
    p_shift_id,
    v_membership_id,
    'on_my_way',
    'shift.on_my_way',
    pg_catalog.jsonb_build_object(
      'claimed_at', p_claimed_at,
      'client_tz', p_client_tz,
      'expected_version', v_shift.version,
      'command_id', p_command_id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id,
    'on_my_way',
    v_shift.organisation_id,
    v_membership_id,
    p_shift_id,
    v_shift.version,
    p_claimed_at,
    p_client_tz,
    p_payload,
    'accepted',
    pg_catalog.jsonb_build_object('new_state', 'in_transit', 'version', v_shift.version + 1),
    false,
    null
  );

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'receipt_id', v_receipt_id,
    'new_state', 'in_transit',
    'version', v_shift.version + 1
  );
end;
$$;
revoke all on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) from public;
revoke all on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) from anon;
grant execute on function public.cmd_on_my_way(text, uuid, timestamptz, text, jsonb) to authenticated;

create or replace function public.cmd_start_shift(
  p_command_id text,
  p_shift_id uuid,
  p_expected_version bigint,
  p_claimed_at timestamptz,
  p_client_tz text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_membership_id uuid;
  v_existing record;
  v_receipt_id uuid;
  v_state_ok boolean := false;
  v_route_state record;
begin
  perform public.require_authenticated();

  select *
    into v_shift
  from public.shifts
  where id = p_shift_id
  for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(
    public.current_membership(v_shift.organisation_id),
    public.historical_membership(v_shift.organisation_id)
  );
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select *
    into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id,
    v_membership_id,
    'start_shift',
    p_command_id
  );
  if v_existing.found then
    return pg_catalog.jsonb_build_object(
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
      p_command_id,
      'start_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'not_assigned'),
      true,
      pg_catalog.jsonb_build_object('reason', 'not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.start.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'reason', 'not_assigned')
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'start_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'stale_version',
        'current_version', v_shift.version,
        'claimed_version', p_expected_version
      ),
      true,
      pg_catalog.jsonb_build_object(
        'current_version', v_shift.version,
        'claimed_version', p_expected_version
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.start.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'claimed_version', p_expected_version,
        'current_version', v_shift.version
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  select *
    into v_route_state
  from public.current_worker_route_state(v_shift.organisation_id);
  if not coalesce(v_route_state.has_emergency_route, false)
     or not coalesce(v_route_state.has_incident_route, false) then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'start_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      ),
      true,
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.start.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'urgent_routes_not_current',
      'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
      'has_incident_route', coalesce(v_route_state.has_incident_route, false),
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state in ('scheduled', 'in_transit');
  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'start_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state),
      true,
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.start.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'state', v_shift.state)
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'invalid_state',
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
    v_shift.organisation_id,
    p_shift_id,
    v_membership_id,
    'start',
    'shift.start',
    pg_catalog.jsonb_build_object(
      'claimed_at', p_claimed_at,
      'client_tz', p_client_tz,
      'expected_version', p_expected_version,
      'command_id', p_command_id
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id,
    'start_shift',
    v_shift.organisation_id,
    v_membership_id,
    p_shift_id,
    p_expected_version,
    p_claimed_at,
    p_client_tz,
    p_payload,
    'accepted',
    pg_catalog.jsonb_build_object(
      'new_state', 'started',
      'previous_version', p_expected_version,
      'new_version', p_expected_version + 1
    ),
    false,
    null
  );

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'receipt_id', v_receipt_id,
    'new_state', 'started',
    'version', p_expected_version + 1
  );
end;
$$;
revoke all on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) from public;
revoke all on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) from anon;
grant execute on function public.cmd_start_shift(text, uuid, bigint, timestamptz, text, jsonb) to authenticated;

create or replace function public.cmd_end_shift(
  p_command_id text,
  p_shift_id uuid,
  p_expected_version bigint,
  p_claimed_at timestamptz,
  p_client_tz text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_membership_id uuid;
  v_existing record;
  v_receipt_id uuid;
  v_state_ok boolean := false;
  v_route_state record;
  v_new_state text;
begin
  perform public.require_authenticated();

  select *
    into v_shift
  from public.shifts
  where id = p_shift_id
  for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(
    public.current_membership(v_shift.organisation_id),
    public.historical_membership(v_shift.organisation_id)
  );
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select *
    into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id,
    v_membership_id,
    'end_shift',
    p_command_id
  );
  if v_existing.found then
    return pg_catalog.jsonb_build_object(
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
      p_command_id,
      'end_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'not_assigned'),
      true,
      pg_catalog.jsonb_build_object('reason', 'not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.end.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'reason', 'not_assigned')
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'end_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'stale_version',
        'current_version', v_shift.version,
        'claimed_version', p_expected_version
      ),
      true,
      pg_catalog.jsonb_build_object(
        'current_version', v_shift.version,
        'claimed_version', p_expected_version
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.end.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'claimed_version', p_expected_version,
        'current_version', v_shift.version
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  select *
    into v_route_state
  from public.current_worker_route_state(v_shift.organisation_id);
  if not coalesce(v_route_state.has_emergency_route, false)
     or not coalesce(v_route_state.has_incident_route, false) then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'end_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      ),
      true,
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.end.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'urgent_routes_not_current',
      'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
      'has_incident_route', coalesce(v_route_state.has_incident_route, false),
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state in ('started', 'urgent_provider_review');
  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'end_shift',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state),
      true,
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.end.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'state', v_shift.state)
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'invalid_state',
      'state', v_shift.state,
      'receipt_id', v_receipt_id
    );
  end if;

  v_new_state := case
    when v_shift.state = 'urgent_provider_review' then 'urgent_provider_review'
    else 'ended_summary_required'
  end;

  update public.shifts
    set state = v_new_state,
        version = version + 1
  where id = p_shift_id
    and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id,
    p_shift_id,
    v_membership_id,
    'end',
    'shift.end',
    pg_catalog.jsonb_build_object(
      'claimed_at', p_claimed_at,
      'client_tz', p_client_tz,
      'expected_version', p_expected_version,
      'command_id', p_command_id,
      'new_state', v_new_state,
      'provider_review_active', v_new_state = 'urgent_provider_review'
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id,
    'end_shift',
    v_shift.organisation_id,
    v_membership_id,
    p_shift_id,
    p_expected_version,
    p_claimed_at,
    p_client_tz,
    p_payload,
    'accepted',
    pg_catalog.jsonb_build_object(
      'new_state', v_new_state,
      'previous_version', p_expected_version,
      'new_version', p_expected_version + 1,
      'provider_review_active', v_new_state = 'urgent_provider_review',
      'summary_required', true
    ),
    false,
    null
  );

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'receipt_id', v_receipt_id,
    'new_state', v_new_state,
    'version', p_expected_version + 1
  );
end;
$$;
revoke all on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) from public;
revoke all on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) from anon;
grant execute on function public.cmd_end_shift(text, uuid, bigint, timestamptz, text, jsonb) to authenticated;

create or replace function public.cmd_submit_summary(
  p_command_id text,
  p_shift_id uuid,
  p_expected_version bigint,
  p_claimed_at timestamptz,
  p_activities text[],
  p_summary_text text,
  p_audience text[],
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift public.shifts%rowtype;
  v_membership_id uuid;
  v_existing record;
  v_receipt_id uuid;
  v_summary_id uuid;
  v_version_id uuid;
  v_state_ok boolean := false;
  v_route_state record;
  v_new_state text;
begin
  perform public.require_authenticated();

  select *
    into v_shift
  from public.shifts
  where id = p_shift_id
  for update;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  v_membership_id := coalesce(
    public.current_membership(v_shift.organisation_id),
    public.historical_membership(v_shift.organisation_id)
  );
  if v_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select *
    into v_existing
  from public.lookup_command_receipt(
    v_shift.organisation_id,
    v_membership_id,
    'submit_summary',
    p_command_id
  );
  if v_existing.found then
    return pg_catalog.jsonb_build_object(
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
      p_command_id,
      'submit_summary',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      null,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'not_assigned'),
      true,
      pg_catalog.jsonb_build_object('reason', 'not_assigned')
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.submit_summary.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'reason', 'not_assigned')
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'not_assigned',
      'receipt_id', v_receipt_id
    );
  end;

  if v_shift.version <> p_expected_version then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'submit_summary',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      null,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'stale_version',
        'current_version', v_shift.version,
        'claimed_version', p_expected_version
      ),
      true,
      pg_catalog.jsonb_build_object(
        'current_version', v_shift.version,
        'claimed_version', p_expected_version
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.submit_summary.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'claimed_version', p_expected_version,
        'current_version', v_shift.version
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'stale_version',
      'current_version', v_shift.version,
      'receipt_id', v_receipt_id
    );
  end if;

  select *
    into v_route_state
  from public.current_worker_route_state(v_shift.organisation_id);
  if not coalesce(v_route_state.has_emergency_route, false)
     or not coalesce(v_route_state.has_incident_route, false) then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'submit_summary',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      null,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      ),
      true,
      pg_catalog.jsonb_build_object(
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.submit_summary.conflicted',
      pg_catalog.jsonb_build_object(
        'command_id', p_command_id,
        'reason', 'urgent_routes_not_current',
        'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
        'has_incident_route', coalesce(v_route_state.has_incident_route, false)
      )
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'urgent_routes_not_current',
      'has_emergency_route', coalesce(v_route_state.has_emergency_route, false),
      'has_incident_route', coalesce(v_route_state.has_incident_route, false),
      'receipt_id', v_receipt_id
    );
  end if;

  v_state_ok := v_shift.state in ('ended_summary_required', 'urgent_provider_review');
  if not v_state_ok then
    v_receipt_id := public.record_command_outcome(
      p_command_id,
      'submit_summary',
      v_shift.organisation_id,
      v_membership_id,
      p_shift_id,
      p_expected_version,
      p_claimed_at,
      null,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state),
      true,
      pg_catalog.jsonb_build_object('reason', 'invalid_state', 'state', v_shift.state)
    );
    perform public.record_shift_audit(
      v_shift.organisation_id,
      p_shift_id,
      v_membership_id,
      'conflicted',
      'shift.submit_summary.conflicted',
      pg_catalog.jsonb_build_object('command_id', p_command_id, 'state', v_shift.state)
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'invalid_state',
      'state', v_shift.state,
      'receipt_id', v_receipt_id
    );
  end if;

  insert into public.service_summaries (organisation_id, shift_id)
  values (v_shift.organisation_id, p_shift_id)
  on conflict (shift_id) do update
    set updated_at = pg_catalog.now()
  returning id into v_summary_id;

  insert into public.service_summary_versions (
    summary_id,
    version_number,
    activities,
    summary_text,
    audience_categories,
    author_membership_id,
    is_correction,
    correction_reason
  )
  values (
    v_summary_id,
    1,
    p_activities,
    p_summary_text,
    p_audience,
    v_membership_id,
    false,
    null
  )
  returning id into v_version_id;

  update public.service_summaries
    set current_version_id = v_version_id,
        finalised_at = pg_catalog.now(),
        has_correction = false,
        updated_at = pg_catalog.now()
  where id = v_summary_id;

  v_new_state := case
    when v_shift.state = 'urgent_provider_review' then 'urgent_provider_review'
    else 'finalised'
  end;

  update public.shifts
    set state = v_new_state,
        version = version + 1
  where id = p_shift_id
    and version = p_expected_version;
  if not found then
    raise exception 'concurrent_update' using errcode = '40001';
  end if;

  perform public.record_shift_audit(
    v_shift.organisation_id,
    p_shift_id,
    v_membership_id,
    'summary_submitted',
    'shift.summary_submitted',
    pg_catalog.jsonb_build_object(
      'command_id', p_command_id,
      'claimed_at', p_claimed_at,
      'summary_id', v_summary_id,
      'version_id', v_version_id,
      'provider_review_active', v_new_state = 'urgent_provider_review'
    )
  );

  perform public.record_shift_audit(
    v_shift.organisation_id,
    p_shift_id,
    v_membership_id,
    'summary_finalised',
    'shift.summary_finalised',
    pg_catalog.jsonb_build_object(
      'command_id', p_command_id,
      'summary_id', v_summary_id,
      'current_version_id', v_version_id,
      'auto_finalise', true,
      'provider_review_active', v_new_state = 'urgent_provider_review'
    )
  );

  v_receipt_id := public.record_command_outcome(
    p_command_id,
    'submit_summary',
    v_shift.organisation_id,
    v_membership_id,
    p_shift_id,
    p_expected_version,
    p_claimed_at,
    null,
    p_payload,
    'accepted',
    pg_catalog.jsonb_build_object(
      'summary_id', v_summary_id,
      'current_version_id', v_version_id,
      'new_state', v_new_state,
      'previous_version', p_expected_version,
      'new_version', p_expected_version + 1,
      'auto_finalise', true,
      'provider_review_active', v_new_state = 'urgent_provider_review'
    ),
    false,
    null
  );

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'receipt_id', v_receipt_id,
    'summary_id', v_summary_id,
    'current_version_id', v_version_id,
    'new_state', v_new_state,
    'version', p_expected_version + 1
  );
end;
$$;
revoke all on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) from public;
revoke all on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) from anon;
grant execute on function public.cmd_submit_summary(text, uuid, bigint, timestamptz, text[], text, text[], jsonb) to authenticated;

create or replace function public.cmd_worker_record_handoff(
  p_command_id text,
  p_shift_id uuid,
  p_route_version_id uuid,
  p_event_type text,
  p_selected_channel text,
  p_failure_code text,
  p_claimed_at timestamptz,
  p_client_tz text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  shift_row public.shifts%rowtype;
  route_row public.organisation_handoff_route_versions%rowtype;
  actor_membership_id uuid;
  assignment_row public.shift_assignments%rowtype;
  existing record;
  receipt_id uuid;
  handoff_row public.worker_handoff_receipts%rowtype;
begin
  select *
    into shift_row
  from public.shifts
  where id = p_shift_id
  for update;

  if shift_row.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  actor_membership_id := coalesce(
    public.current_membership(shift_row.organisation_id),
    public.historical_membership(shift_row.organisation_id)
  );
  if actor_membership_id is null then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select *
    into existing
  from public.lookup_command_receipt(
    shift_row.organisation_id,
    actor_membership_id,
    'worker_handoff',
    p_command_id
  );
  if existing.found then
    return pg_catalog.jsonb_build_object(
      'status', existing.status,
      'duplicate', true,
      'receipt_id', existing.receipt_id,
      'outcome', existing.outcome
    );
  end if;

  if p_event_type not in ('initiated', 'worker_confirmed', 'failed')
     or p_selected_channel not in ('primary', 'fallback')
     or (p_event_type = 'failed' and p_failure_code not in ('launch_blocked', 'launch_failed', 'unsupported_device', 'worker_cancelled'))
     or (p_event_type <> 'failed' and p_failure_code is not null) then
    raise exception 'worker_handoff_invalid';
  end if;

  begin
    actor_membership_id := public.assert_worker_assignment(p_shift_id, shift_row.organisation_id);
  exception when sqlstate '42501' then
    receipt_id := public.record_command_outcome(
      p_command_id,
      'worker_handoff',
      shift_row.organisation_id,
      actor_membership_id,
      p_shift_id,
      null,
      p_claimed_at,
      p_client_tz,
      p_payload,
      'conflict_preserved',
      pg_catalog.jsonb_build_object('reason', 'not_assigned'),
      true,
      pg_catalog.jsonb_build_object('reason', 'not_assigned')
    );
    return pg_catalog.jsonb_build_object(
      'status', 'conflict_preserved',
      'reason', 'not_assigned',
      'receipt_id', receipt_id
    );
  end;

  select route.*
    into route_row
  from public.organisation_handoff_route_versions route
  where route.id = p_route_version_id
    and route.organisation_id = shift_row.organisation_id
    and route.route_type in ('emergency', 'incident')
    and route.status = 'active'
    and route.effective_from <= pg_catalog.now()
    and (route.effective_until is null or route.effective_until > pg_catalog.now())
  order by route.effective_from desc, route.created_at desc
  limit 1;

  if route_row.id is null or route_row.id <> p_route_version_id then
    raise exception 'worker_handoff_route_not_current';
  end if;

  select assignment.*
    into assignment_row
  from public.shift_assignments assignment
  where assignment.shift_id = p_shift_id
    and assignment.membership_id = actor_membership_id
    and assignment.withdrawn_at is null
    and assignment.effective_from <= pg_catalog.now()
    and (assignment.effective_until is null or assignment.effective_until > pg_catalog.now())
  order by assignment.effective_from desc
  limit 1;

  if assignment_row.id is null then
    raise exception 'worker_handoff_assignment_not_current';
  end if;

  receipt_id := public.record_command_outcome(
    p_command_id,
    'worker_handoff',
    shift_row.organisation_id,
    actor_membership_id,
    p_shift_id,
    null,
    p_claimed_at,
    p_client_tz,
    p_payload,
    'accepted',
    pg_catalog.jsonb_build_object(
      'route_version_id', route_row.id,
      'route_type', route_row.route_type,
      'event_type', p_event_type,
      'selected_channel', p_selected_channel,
      'failure_code', p_failure_code
    ),
    false,
    null
  );

  insert into public.worker_handoff_receipts (
    organisation_id,
    shift_id,
    assignment_id,
    actor_membership_id,
    actor_profile_id,
    route_version_id,
    route_type,
    handoff_event,
    selected_channel,
    failure_code,
    claimed_at,
    client_tz,
    command_receipt_id
  )
  values (
    shift_row.organisation_id,
    p_shift_id,
    assignment_row.id,
    actor_membership_id,
    auth.uid(),
    route_row.id,
    route_row.route_type,
    p_event_type,
    p_selected_channel,
    p_failure_code,
    p_claimed_at,
    p_client_tz,
    receipt_id
  )
  returning * into handoff_row;

  insert into public.audit_log(organisation_id, actor, action, subject_type, subject_id, metadata)
  values (
    shift_row.organisation_id,
    auth.uid(),
    'worker.handoff.recorded',
    'shift',
    p_shift_id,
    pg_catalog.jsonb_build_object(
      'handoff_receipt_id', handoff_row.id,
      'route_type', handoff_row.route_type,
      'handoff_event', handoff_row.handoff_event,
      'selected_channel', handoff_row.selected_channel,
      'failure_code', handoff_row.failure_code
    )
  );

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'receipt_id', receipt_id,
    'handoff_receipt_id', handoff_row.id,
    'route_type', handoff_row.route_type,
    'event_type', handoff_row.handoff_event
  );
end;
$$;
revoke all on function public.cmd_worker_record_handoff(text,uuid,uuid,text,text,text,timestamptz,text,jsonb) from public;
revoke all on function public.cmd_worker_record_handoff(text,uuid,uuid,text,text,text,timestamptz,text,jsonb) from anon;
grant execute on function public.cmd_worker_record_handoff(text,uuid,uuid,text,text,text,timestamptz,text,jsonb) to authenticated;

commit;
