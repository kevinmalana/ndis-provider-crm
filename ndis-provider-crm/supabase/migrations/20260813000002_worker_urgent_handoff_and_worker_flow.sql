-- 20260813000002_worker_urgent_handoff_and_worker_flow.sql
--
-- Ticket 06 prerequisite and worker-flow foundation:
--   * provider-owned urgent handoff route versions
--   * truthful append-only worker handoff receipts
--   * worker-safe route / acknowledgement reads
--   * today-list projection for the phone-first worker flow
--   * minimal participant location fields for the worker detail screen

begin;
set search_path = '';

alter table public.participants
  add column if not exists location_hint text,
  add column if not exists full_address text,
  add column if not exists access_instructions text;

create table if not exists public.organisation_handoff_route_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  route_type text not null check (route_type in ('emergency','incident','complaint')),
  guidance_text text not null,
  owner_role_label text not null,
  primary_label text not null,
  primary_contact_uri text not null,
  fallback_phone text not null,
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  authored_by uuid not null references public.global_profiles(id) on delete restrict,
  reviewed_by uuid references public.global_profiles(id) on delete set null,
  superseded_by uuid references public.organisation_handoff_route_versions(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organisation_id, id),
  constraint organisation_handoff_route_window_valid
    check (effective_until is null or effective_until > effective_from),
  constraint organisation_handoff_route_primary_uri_valid
    check (
      primary_contact_uri like 'tel:%'
      or primary_contact_uri like 'https://%'
    )
);

create index if not exists organisation_handoff_route_current_idx
  on public.organisation_handoff_route_versions (organisation_id, route_type, effective_from desc, created_at desc)
  where status = 'active';

drop trigger if exists organisation_handoff_route_versions_set_updated_at on public.organisation_handoff_route_versions;
create trigger organisation_handoff_route_versions_set_updated_at
  before update on public.organisation_handoff_route_versions
  for each row execute function public.set_updated_at();

create table if not exists public.worker_handoff_receipts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  assignment_id uuid not null references public.shift_assignments(id) on delete restrict,
  actor_membership_id uuid not null references public.organisation_memberships(id) on delete restrict,
  actor_profile_id uuid not null references public.global_profiles(id) on delete restrict,
  route_version_id uuid not null references public.organisation_handoff_route_versions(id) on delete restrict,
  route_type text not null check (route_type in ('emergency','incident')),
  handoff_event text not null check (handoff_event in ('initiated','worker_confirmed','failed')),
  selected_channel text not null check (selected_channel in ('primary','fallback')),
  failure_code text check (failure_code is null or failure_code in ('launch_blocked','launch_failed','unsupported_device','worker_cancelled')),
  claimed_at timestamptz not null,
  client_tz text,
  server_received_at timestamptz not null default pg_catalog.now(),
  command_receipt_id uuid not null references public.command_receipts(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  unique (command_receipt_id),
  constraint worker_handoff_receipts_shift_tenant
    foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id)
    on delete cascade,
  constraint worker_handoff_receipts_membership_tenant
    foreign key (organisation_id, actor_membership_id)
    references public.organisation_memberships (organisation_id, id)
    on delete restrict,
  constraint worker_handoff_receipts_route_tenant
    foreign key (organisation_id, route_version_id)
    references public.organisation_handoff_route_versions (organisation_id, id)
    on delete restrict
);

create index if not exists worker_handoff_receipts_shift_idx
  on public.worker_handoff_receipts (shift_id, created_at desc);

create index if not exists worker_handoff_receipts_actor_idx
  on public.worker_handoff_receipts (actor_profile_id, created_at desc);

alter table public.command_receipts
  drop constraint if exists command_receipts_command_type_check;

alter table public.command_receipts
  add constraint command_receipts_command_type_check check (command_type in (
    'on_my_way','start_shift','end_shift','submit_summary','finalise_summary',
    'cancel_shift','reassign_shift','resolve_conflict','request_correction',
    'request_access','apply_correction','accept_invitation',
    'admin_invite','admin_create_participant','admin_set_authority',
    'admin_create_grant','admin_revoke_grant','admin_set_availability',
    'admin_create_shift','admin_update_critical_info','admin_link_self',
    'admin_record_consent','admin_renew_consent',
    'admin_create_service_ready_shift','admin_provider_scope','admin_catalogue',
    'admin_worker_readiness','admin_service_context','admin_identifier',
    'admin_acknowledgement','admin_handoff_route','worker_handoff'
  ));

alter table public.organisation_handoff_route_versions enable row level security;
alter table public.worker_handoff_receipts enable row level security;
revoke all on table public.organisation_handoff_route_versions from public;
revoke all on table public.organisation_handoff_route_versions from anon;
revoke all on table public.worker_handoff_receipts from public;
revoke all on table public.worker_handoff_receipts from anon;
grant select on public.organisation_handoff_route_versions to authenticated;
grant select on public.worker_handoff_receipts to authenticated;

drop policy if exists organisation_handoff_route_versions_office_select on public.organisation_handoff_route_versions;
create policy organisation_handoff_route_versions_office_select
  on public.organisation_handoff_route_versions
  for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists worker_handoff_receipts_actor_select on public.worker_handoff_receipts;
create policy worker_handoff_receipts_actor_select
  on public.worker_handoff_receipts
  for select to authenticated
  using (actor_profile_id = auth.uid());

drop policy if exists worker_handoff_receipts_office_select on public.worker_handoff_receipts;
create policy worker_handoff_receipts_office_select
  on public.worker_handoff_receipts
  for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

create or replace function public.cmd_admin_create_handoff_route(
  p_command_id text,
  p_organisation_id uuid,
  p_route_type text,
  p_guidance_text text,
  p_owner_role_label text,
  p_primary_label text,
  p_primary_contact_uri text,
  p_fallback_phone text,
  p_effective_from timestamptz,
  p_effective_until timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  reserved record;
  route_row public.organisation_handoff_route_versions%rowtype;
  out jsonb;
  retry jsonb;
begin
  actor := public.require_05b_admin_or_scheduler(p_organisation_id, true);
  retry := public.lookup_05b_admin_retry(p_command_id, 'admin_handoff_route', p_organisation_id);
  if retry is not null then
    return retry;
  end if;

  if p_route_type not in ('emergency','incident','complaint')
     or nullif(pg_catalog.btrim(p_guidance_text), '') is null
     or nullif(pg_catalog.btrim(p_owner_role_label), '') is null
     or nullif(pg_catalog.btrim(p_primary_label), '') is null
     or nullif(pg_catalog.btrim(p_primary_contact_uri), '') is null
     or nullif(pg_catalog.btrim(p_fallback_phone), '') is null
     or p_effective_until is not null and p_effective_until <= p_effective_from
     or (
       pg_catalog.btrim(p_primary_contact_uri) not like 'tel:%'
       and pg_catalog.btrim(p_primary_contact_uri) not like 'https://%'
     ) then
    raise exception 'handoff_route_invalid';
  end if;

  select * into reserved
  from public.reserve_admin_command(p_command_id, 'admin_handoff_route', p_organisation_id, p_payload);

  if not reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id',reserved.receipt_id,'outcome',reserved.outcome
    );
  end if;

  insert into public.organisation_handoff_route_versions (
    organisation_id,
    route_type,
    guidance_text,
    owner_role_label,
    primary_label,
    primary_contact_uri,
    fallback_phone,
    effective_from,
    effective_until,
    status,
    authored_by,
    reviewed_by
  )
  values (
    p_organisation_id,
    p_route_type,
    pg_catalog.btrim(p_guidance_text),
    pg_catalog.btrim(p_owner_role_label),
    pg_catalog.btrim(p_primary_label),
    pg_catalog.btrim(p_primary_contact_uri),
    pg_catalog.btrim(p_fallback_phone),
    p_effective_from,
    p_effective_until,
    'active',
    auth.uid(),
    auth.uid()
  )
  returning * into route_row;

  if p_effective_from <= pg_catalog.now() then
    update public.organisation_handoff_route_versions
      set status = 'superseded',
          superseded_by = route_row.id,
          reviewed_by = coalesce(reviewed_by, auth.uid())
    where organisation_id = p_organisation_id
      and route_type = p_route_type
      and id <> route_row.id
      and status = 'active'
      and effective_from <= pg_catalog.now()
      and (effective_until is null or effective_until > pg_catalog.now());
  end if;

  insert into public.audit_log(organisation_id, actor, action, subject_type, subject_id, metadata)
  values (
    p_organisation_id,
    auth.uid(),
    'handoff_route.created',
    'handoff_route',
    route_row.id,
    pg_catalog.jsonb_build_object(
      'route_type', route_row.route_type,
      'effective_from', route_row.effective_from,
      'effective_until', route_row.effective_until,
      'actor_membership_id', actor
    )
  );

  out := pg_catalog.jsonb_build_object(
    'route_version_id', route_row.id,
    'route_type', route_row.route_type
  );
  perform public.finalize_admin_command(reserved.receipt_id, out);

  return pg_catalog.jsonb_build_object(
    'status','accepted',
    'receipt_id',reserved.receipt_id,
    'route_version_id', route_row.id,
    'route_type', route_row.route_type
  );
end;
$$;

revoke all on function public.cmd_admin_create_handoff_route(text,uuid,text,text,text,text,text,text,timestamptz,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_create_handoff_route(text,uuid,text,text,text,text,text,text,timestamptz,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_create_handoff_route(text,uuid,text,text,text,text,text,text,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.list_worker_today_shifts()
returns table(
  shift_id uuid,
  participant_id uuid,
  participant_first_name text,
  location_hint text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  state text,
  version bigint,
  has_emergency_route boolean,
  has_incident_route boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org_id uuid;
  worker_membership_id uuid;
begin
  org_id := public.current_active_organisation_id();
  if org_id is null then
    raise exception 'active_organisation_required' using errcode = '42501';
  end if;

  worker_membership_id := public.current_membership(org_id);
  if worker_membership_id is null or not public.membership_has_role(worker_membership_id, 'worker') then
    raise exception 'worker_membership_required' using errcode = '42501';
  end if;

  return query
  with route_state as (
    select
      exists(
        select 1
        from public.organisation_handoff_route_versions route
        where route.organisation_id = org_id
          and route.route_type = 'emergency'
          and route.status = 'active'
          and route.effective_from <= pg_catalog.now()
          and (route.effective_until is null or route.effective_until > pg_catalog.now())
        order by route.effective_from desc, route.created_at desc
        limit 1
      ) as has_emergency,
      exists(
        select 1
        from public.organisation_handoff_route_versions route
        where route.organisation_id = org_id
          and route.route_type = 'incident'
          and route.status = 'active'
          and route.effective_from <= pg_catalog.now()
          and (route.effective_until is null or route.effective_until > pg_catalog.now())
        order by route.effective_from desc, route.created_at desc
        limit 1
      ) as has_incident
  )
  select
    s.id,
    p.id,
    p.first_name,
    coalesce(nullif(p.location_hint, ''), 'Open the assigned shift to view the location.'),
    s.scheduled_start,
    s.scheduled_end,
    s.state,
    s.version,
    route_state.has_emergency,
    route_state.has_incident
  from public.shifts s
  join public.shift_assignments assignment
    on assignment.shift_id = s.id
   and assignment.membership_id = worker_membership_id
   and assignment.withdrawn_at is null
   and assignment.effective_from <= pg_catalog.now()
   and (assignment.effective_until is null or assignment.effective_until > pg_catalog.now())
  join public.participants p
    on p.id = s.participant_id
   and p.organisation_id = s.organisation_id
  join public.shift_service_snapshots snapshot
    on snapshot.shift_id = s.id
  cross join route_state
  where s.organisation_id = org_id
    and s.state <> 'legacy_incomplete'
    and (s.scheduled_start at time zone 'Australia/Sydney')::date = (pg_catalog.now() at time zone 'Australia/Sydney')::date
  order by s.scheduled_start;
end;
$$;

revoke all on function public.list_worker_today_shifts() from public;
revoke all on function public.list_worker_today_shifts() from anon;
grant execute on function public.list_worker_today_shifts() to authenticated;

create or replace function public.list_worker_shift_handoff_routes(p_shift_id uuid)
returns table(
  route_version_id uuid,
  route_type text,
  owner_role_label text,
  guidance_text text,
  primary_label text,
  primary_contact_uri text,
  fallback_phone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  shift_row public.shifts%rowtype;
begin
  select * into shift_row
  from public.shifts
  where id = p_shift_id;

  if shift_row.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  perform public.assert_worker_assignment(p_shift_id, shift_row.organisation_id);

  return query
  select
    current_route.id,
    current_route.route_type,
    current_route.owner_role_label,
    current_route.guidance_text,
    current_route.primary_label,
    current_route.primary_contact_uri,
    current_route.fallback_phone
  from (
    select distinct on (route_version.route_type)
      route_version.id,
      route_version.route_type,
      route_version.owner_role_label,
      route_version.guidance_text,
      route_version.primary_label,
      route_version.primary_contact_uri,
      route_version.fallback_phone,
      route_version.effective_from,
      route_version.created_at
    from public.organisation_handoff_route_versions route_version
    where route_version.organisation_id = shift_row.organisation_id
      and route_version.route_type in ('emergency', 'incident')
      and route_version.status = 'active'
      and route_version.effective_from <= pg_catalog.now()
      and (route_version.effective_until is null or route_version.effective_until > pg_catalog.now())
    order by route_version.route_type, route_version.effective_from desc, route_version.created_at desc
  ) current_route
  order by case current_route.route_type when 'emergency' then 1 else 2 end;
end;
$$;

revoke all on function public.list_worker_shift_handoff_routes(uuid) from public;
revoke all on function public.list_worker_shift_handoff_routes(uuid) from anon;
grant execute on function public.list_worker_shift_handoff_routes(uuid) to authenticated;

create or replace function public.get_worker_shift_acknowledgement(p_shift_id uuid)
returns table(
  status_kind text,
  event_type text,
  source_label text,
  occurred_at timestamptz,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  shift_row public.shifts%rowtype;
begin
  select * into shift_row
  from public.shifts
  where id = p_shift_id;

  if shift_row.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  perform public.assert_worker_assignment(p_shift_id, shift_row.organisation_id);

  return query
  with current_leaf as (
    select
      'conclusive'::text as status_kind,
      current_ack.event_type,
      'Provider-recorded external evidence; not participant-authenticated'::text as source_label,
      current_ack.occurred_at,
      current_ack.reason,
      1 as ord
    from public.service_acknowledgement_current current_ack
    where current_ack.shift_id = p_shift_id
  ),
  latest_attempt as (
    select
      'attempt'::text as status_kind,
      event.event_type,
      'Provider-recorded attempt; not participant-authenticated'::text as source_label,
      event.occurred_at,
      event.reason,
      2 as ord
    from public.service_acknowledgement_events event
    where event.organisation_id = shift_row.organisation_id
      and event.shift_id = p_shift_id
      and event.event_class = 'attempt'
    order by event.occurred_at desc, event.created_at desc
    limit 1
  )
  select candidate.status_kind, candidate.event_type, candidate.source_label, candidate.occurred_at, candidate.reason
  from (
    select * from current_leaf
    union all
    select * from latest_attempt
  ) candidate
  order by candidate.ord
  limit 1;
end;
$$;

revoke all on function public.get_worker_shift_acknowledgement(uuid) from public;
revoke all on function public.get_worker_shift_acknowledgement(uuid) from anon;
grant execute on function public.get_worker_shift_acknowledgement(uuid) to authenticated;

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
set search_path = public
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
  select * into shift_row
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

  select * into existing
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
     or (p_event_type = 'failed' and p_failure_code not in ('launch_blocked','launch_failed','unsupported_device','worker_cancelled'))
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
      pg_catalog.jsonb_build_object('reason','not_assigned'),
      true,
      pg_catalog.jsonb_build_object('reason','not_assigned')
    );
    return pg_catalog.jsonb_build_object(
      'status','conflict_preserved',
      'reason','not_assigned',
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

  if route_row.id is null then
    raise exception 'worker_handoff_route_not_current';
  end if;

  if route_row.id <> p_route_version_id then
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
    'status','accepted',
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

create or replace function public.seed_synthetic_demo(p_worker_membership_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.organisation_memberships%rowtype;
  scope_id uuid;
  cap_id uuid;
  cv_id uuid;
  item_id uuid;
  role_id uuid;
  policy_id uuid;
  req_id uuid;
  emergency_route_id uuid;
  incident_route_id uuid;
  complaint_route_id uuid;
  p_id uuid;
  ctx_id uuid;
  shift_id uuid;
  snap_id uuid;
  i integer;
begin
  if coalesce(auth.role(),'anon') <> 'service_role' then
    raise exception 'synthetic_seed_service_role_required' using errcode='42501';
  end if;

  select * into m
  from public.organisation_memberships
  where id = p_worker_membership_id
    and role = 'worker'
    and status = 'active'
  for update;

  if m.id is null then
    raise exception 'synthetic_seed_worker_membership_invalid';
  end if;

  if not exists(
    select 1
    from public.global_profiles
    where id = m.profile_id
      and email like '%.synthetic'
  ) then
    raise exception 'synthetic_seed_requires_dedicated_identity';
  end if;

  scope_id := md5('ndis.synthetic.scope:'||m.organisation_id::text)::uuid;
  cap_id := md5('ndis.synthetic.capability:'||m.organisation_id::text)::uuid;
  cv_id := md5('ndis.synthetic.catalogue:'||m.organisation_id::text)::uuid;
  item_id := md5('ndis.synthetic.item:'||m.organisation_id::text)::uuid;
  role_id := md5('ndis.synthetic.role:'||m.organisation_id::text)::uuid;
  policy_id := md5('ndis.synthetic.policy:'||m.organisation_id::text)::uuid;
  req_id := md5('ndis.synthetic.requirement:'||m.organisation_id::text)::uuid;
  emergency_route_id := md5('ndis.synthetic.handoff:'||m.organisation_id::text||':emergency')::uuid;
  incident_route_id := md5('ndis.synthetic.handoff:'||m.organisation_id::text||':incident')::uuid;
  complaint_route_id := md5('ndis.synthetic.handoff:'||m.organisation_id::text||':complaint')::uuid;

  insert into public.organisation_provider_scope_versions(id,organisation_id,registration_state,registration_group,class_of_support,jurisdictions,effective_from,authored_by,reviewed_by)
  values(scope_id,m.organisation_id,'registered','synthetic','individual',array['NSW'],pg_catalog.now(),m.profile_id,m.profile_id)
  on conflict(id) do nothing;

  insert into public.organisation_support_capabilities(id,organisation_id,scope_version_id,support_category,service_kind,capability,effective_from)
  values(cap_id,m.organisation_id,scope_id,'daily_living','individual_time','individual_time_supported',pg_catalog.now())
  on conflict(id) do nothing;

  insert into public.provider_support_catalogue_versions(id,organisation_id,source_label,source_version,effective_from,created_by)
  values(cv_id,m.organisation_id,'Provider synthetic catalogue','v1',pg_catalog.now(),m.profile_id)
  on conflict(id) do nothing;

  insert into public.provider_support_items(id,organisation_id,catalogue_version_id,item_code,item_name,support_category,time_unit,service_kind,effective_from)
  values(item_id,m.organisation_id,cv_id,'SYN-TIME-001','Individual time support','daily_living','hour','individual_time',pg_catalog.now())
  on conflict(id) do nothing;

  insert into public.risk_assessed_role_versions(id,organisation_id,title,definition_basis,description,assessed_at,assessor_name,assessor_title,effective_from,created_by)
  values(role_id,m.organisation_id,'Synthetic support worker','provider policy','Synthetic readiness role',pg_catalog.now(),'Synthetic Admin','Provider Admin',pg_catalog.now(),m.profile_id)
  on conflict(id) do nothing;

  insert into public.role_screening_policy_versions(id,organisation_id,role_version_id,registration_state,decision,decision_owner,decision_reason,effective_from,created_by)
  values(policy_id,m.organisation_id,role_id,'registered','required','Synthetic Admin','Synthetic provider policy',pg_catalog.now(),m.profile_id)
  on conflict(id) do nothing;

  insert into public.role_competence_requirements(id,organisation_id,role_version_id,support_category,evidence_type,requirement_state,assessment_method,review_owner,effective_from,created_by)
  values(req_id,m.organisation_id,role_id,'daily_living','induction','required','provider_assessed','Synthetic Admin',pg_catalog.now(),m.profile_id)
  on conflict(id) do nothing;

  insert into public.worker_screening_verification_versions(organisation_id,worker_membership_id,role_version_id,source_checked,verifier_name,verified_at,application_or_check_reference,clearance_status,clearance_expires_at,effective_from,created_by)
  values(m.organisation_id,m.id,role_id,'synthetic provider register','Synthetic Admin',pg_catalog.now(),'SYN-CHECK-001','current',pg_catalog.now()+interval '365 days',pg_catalog.now(),m.profile_id);

  insert into public.worker_competence_evidence_versions(organisation_id,worker_membership_id,requirement_id,evidence_type,issuer,evidence_reference,verifier_name,assessed_state,expires_at,effective_from,created_by)
  values(m.organisation_id,m.id,req_id,'induction','Synthetic Provider','SYN-COMP-001','Synthetic Admin','met',pg_catalog.now()+interval '365 days',pg_catalog.now(),m.profile_id);

  insert into public.organisation_handoff_route_versions(id,organisation_id,route_type,guidance_text,owner_role_label,primary_label,primary_contact_uri,fallback_phone,effective_from,status,authored_by,reviewed_by)
  values
    (emergency_route_id,m.organisation_id,'emergency','Call the provider emergency line after immediate danger is addressed.','On-call manager','Call emergency coordinator','tel:+61255501000','02 5550 1099',pg_catalog.now(),'active',m.profile_id,m.profile_id),
    (incident_route_id,m.organisation_id,'incident','Use the incident route for urgent provider escalation that is not immediate danger.','Incident lead','Open incident guide','https://example.test/incident','02 5550 1088',pg_catalog.now(),'active',m.profile_id,m.profile_id),
    (complaint_route_id,m.organisation_id,'complaint','Use the complaint route for later portal and office follow-up only.','Complaints officer','Open complaints guide','https://example.test/complaints','02 5550 1077',pg_catalog.now(),'active',m.profile_id,m.profile_id)
  on conflict(id) do nothing;

  for i in 1..3 loop
    p_id := md5('ndis.synthetic.participant:'||m.organisation_id::text||':'||i::text)::uuid;
    ctx_id := md5('ndis.synthetic.context:'||m.organisation_id::text||':'||i::text)::uuid;
    shift_id := md5('ndis.synthetic.shift:'||m.organisation_id::text||':'||i::text)::uuid;
    snap_id := md5('ndis.synthetic.snapshot:'||m.organisation_id::text||':'||i::text)::uuid;

    insert into public.participants(id,organisation_id,first_name,last_initial,location_hint,full_address,access_instructions,created_by)
    values(
      p_id,
      m.organisation_id,
      case i when 1 then 'Test Alpha' when 2 then 'Test Beta' else 'Test Gamma' end,
      'S',
      case i when 1 then 'Fairfield' when 2 then 'Parramatta' else 'Liverpool' end,
      case i when 1 then '12 Acacia St, Fairfield NSW 2165' when 2 then '88 George St, Parramatta NSW 2150' else '4 Green Rd, Liverpool NSW 2170' end,
      'Ring the side bell and wait for a support worker handoff.',
      m.profile_id
    )
    on conflict(id) do nothing;

    insert into public.participant_ndis_identifiers(organisation_id,participant_id,identifier_value,created_by)
    values(m.organisation_id,p_id,'43000000000'||i::text,m.profile_id)
    on conflict(organisation_id,participant_id) do nothing;

    insert into public.participant_service_context_versions(id,organisation_id,participant_id,capability_id,catalogue_item_id,role_version_id,jurisdiction,external_agreement_reference,plan_reference,source_type,owner_profile_id,reviewer_profile_id,effective_from,effective_until,goal_source,goal_reference,goal_display,lifecycle_state)
    values(ctx_id,m.organisation_id,p_id,cap_id,item_id,role_id,'NSW','SYN-AGREEMENT-'||i::text,'SYN-PLAN-'||i::text,'provider_recorded',m.profile_id,m.profile_id,pg_catalog.now(),pg_catalog.now()+interval '365 days','participant_goal','SYN-GOAL-'||i::text,'Synthetic participant goal','active')
    on conflict(id) do nothing;

    insert into public.shifts(id,organisation_id,participant_id,scheduled_start,scheduled_end,state,version)
    values(shift_id,m.organisation_id,p_id,pg_catalog.date_trunc('day',pg_catalog.now())+interval '9 hours',pg_catalog.date_trunc('day',pg_catalog.now())+interval '10 hours','scheduled',1)
    on conflict(id) do update
      set state='scheduled',
          version=1;

    insert into public.shift_service_snapshots(id,organisation_id,shift_id,service_context_id,capability_id,catalogue_item_id,catalogue_version_id,item_code,item_name,support_category,service_kind,time_unit,goal_reference,goal_display,scheduled_start,scheduled_end)
    values(snap_id,m.organisation_id,shift_id,ctx_id,cap_id,item_id,cv_id,'SYN-TIME-001','Individual time support','daily_living','individual_time','hour','SYN-GOAL-'||i::text,'Synthetic participant goal',pg_catalog.date_trunc('day',pg_catalog.now())+interval '9 hours',pg_catalog.date_trunc('day',pg_catalog.now())+interval '10 hours')
    on conflict(id) do nothing;

    insert into public.shift_assignments(id,shift_id,organisation_id,membership_id,assigned_by)
    values(md5('ndis.synthetic.assignment:'||m.organisation_id::text||':'||i::text)::uuid,shift_id,m.organisation_id,m.id,m.profile_id)
    on conflict(id) do update
      set withdrawn_at = null,
          effective_until = null;
  end loop;

  return pg_catalog.jsonb_build_object(
    'status','seeded',
    'organisation_id',m.organisation_id,
    'worker_membership_id',m.id,
    'participants',3,
    'ready_path',true,
    'synthetic_only',true,
    'deterministic',true,
    'transactional',true,
    'handoff_routes',true
  );
end;
$$;

revoke all on function public.seed_synthetic_demo(uuid) from public;
revoke all on function public.seed_synthetic_demo(uuid) from anon;
grant execute on function public.seed_synthetic_demo(uuid) to service_role;

commit;
