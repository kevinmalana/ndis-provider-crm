-- 0009_provider_readiness_service_evidence.sql
-- Ticket 05b corrective, forward-only migration.  This migration deliberately
-- does not backfill evidence that did not exist in 0008.
set search_path = '';

do $$
declare c record;
begin
  -- PostgreSQL treats a changed argument list as an overload.  Retire the
  -- context-free command explicitly before creating the ready-only command.
  execute 'drop function if exists public.cmd_admin_create_shift(text, uuid, uuid, uuid, timestamptz, timestamptz, text, jsonb)';
  for c in select conname from pg_catalog.pg_constraint
    where conrelid = 'public.shifts'::pg_catalog.regclass
      and contype = 'c' and conname like '%state%' loop
    execute format('alter table public.shifts drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.shifts add constraint shifts_state_check check (state in (
  'scheduled','in_transit','started','ended_summary_required','submitted_local',
  'syncing','finalised','needs_review','cancelled','cancelled_needs_review',
  'corrected','legacy_incomplete','urgent_provider_review'
));

alter table public.command_receipts drop constraint if exists command_receipts_command_type_check;
alter table public.command_receipts add constraint command_receipts_command_type_check check (command_type in (
  'on_my_way','start_shift','end_shift','submit_summary','finalise_summary','cancel_shift',
  'reassign_shift','resolve_conflict','request_correction','request_access','apply_correction',
  'accept_invitation','admin_invite','admin_create_participant','admin_set_authority',
  'admin_create_grant','admin_revoke_grant','admin_set_availability','admin_update_critical_info',
  'admin_link_self','admin_record_consent','admin_renew_consent','admin_create_service_ready_shift',
  'admin_provider_scope','admin_catalogue','admin_worker_readiness','admin_service_context',
  'admin_identifier','admin_acknowledgement'
));

------------------------------------------------------------------------
-- Provider-owned scope and catalogue
------------------------------------------------------------------------
create table if not exists public.organisation_provider_scope_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  registration_state text not null check (registration_state in ('registered','unregistered')),
  registration_group text,
  class_of_support text,
  jurisdictions text[] not null check (cardinality(jurisdictions) > 0),
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  authored_by uuid not null references public.global_profiles(id),
  reviewed_by uuid references public.global_profiles(id),
  superseded_by uuid references public.organisation_provider_scope_versions(id),
  created_at timestamptz not null default pg_catalog.now(),
  check (effective_until is null or effective_until > effective_from)
);
create table if not exists public.organisation_support_capabilities (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  scope_version_id uuid not null references public.organisation_provider_scope_versions(id) on delete restrict,
  support_category text not null,
  service_kind text not null,
  capability text not null check (capability in ('individual_time_supported','specialist_phased','not_supported')),
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.organisation_support_capabilities(id),
  created_at timestamptz not null default pg_catalog.now(),
  check (effective_until is null or effective_until > effective_from)
);
create table if not exists public.provider_support_catalogue_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  source_label text not null,
  source_version text not null,
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.provider_support_catalogue_versions(id),
  created_by uuid not null references public.global_profiles(id),
  created_at timestamptz not null default pg_catalog.now(),
  check (effective_until is null or effective_until > effective_from)
);
create table if not exists public.provider_support_items (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  catalogue_version_id uuid not null references public.provider_support_catalogue_versions(id) on delete restrict,
  item_code text not null,
  item_name text not null,
  support_category text not null,
  time_unit text not null check (time_unit in ('hour','minute')),
  service_kind text not null,
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.provider_support_items(id),
  unique (organisation_id, catalogue_version_id, item_code),
  check (effective_until is null or effective_until > effective_from)
);

------------------------------------------------------------------------
-- Worker screening and competence evidence
------------------------------------------------------------------------
create table if not exists public.risk_assessed_role_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id),
  title text not null, definition_basis text not null, description text not null,
  assessed_at timestamptz not null, assessor_name text not null, assessor_title text not null,
  effective_from timestamptz not null, effective_until timestamptz, status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.risk_assessed_role_versions(id), created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now()
);
alter table public.risk_assessed_role_versions add column if not exists risk_assessed boolean not null default true;
create table if not exists public.role_screening_policy_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id),
  role_version_id uuid not null references public.risk_assessed_role_versions(id), registration_state text not null check (registration_state in ('registered','unregistered')),
  decision text not null check (decision in ('required','not_required')), decision_owner text not null, decision_reason text not null,
  effective_from timestamptz not null, effective_until timestamptz, status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.role_screening_policy_versions(id), created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now()
);
create table if not exists public.worker_screening_verification_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), worker_membership_id uuid not null references public.organisation_memberships(id),
  role_version_id uuid references public.risk_assessed_role_versions(id), source_checked text not null, verifier_name text not null, verified_at timestamptz not null,
  application_or_check_reference text not null, clearance_status text not null check (clearance_status in ('current','expired','pending','not_required')),
  clearance_expires_at timestamptz, interim_bar boolean not null default false, suspension boolean not null default false, exclusion boolean not null default false, revocation boolean not null default false,
  effective_from timestamptz not null, effective_until timestamptz, status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.worker_screening_verification_versions(id), created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now()
);
create table if not exists public.worker_screening_pathway_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), worker_membership_id uuid not null references public.organisation_memberships(id), role_version_id uuid references public.risk_assessed_role_versions(id),
  pathway text not null check (pathway in ('secondary_school_work_experience','working_on_application','higher_education_placement','contractor_administered')),
  jurisdiction text not null, application_placement_contract_reference text not null, pathway_start timestamptz not null, pathway_end timestamptz not null,
  supervisor_membership_id uuid references public.organisation_memberships(id), supervisor_clearance_reference text, risk_management_plan_reference text, administering_organisation text,
  effective_from timestamptz not null, effective_until timestamptz, status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.worker_screening_pathway_versions(id), created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now(),
  check (pathway_end > pathway_start)
);
create table if not exists public.role_competence_requirements (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), role_version_id uuid references public.risk_assessed_role_versions(id), support_category text not null, evidence_type text not null,
  requirement_state text not null check (requirement_state in ('required','not_required')), assessment_method text not null, review_owner text not null, effective_from timestamptz not null, effective_until timestamptz,
  status text not null default 'active' check (status in ('active','superseded','withdrawn')), superseded_by uuid references public.role_competence_requirements(id), created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now()
);
create table if not exists public.worker_competence_evidence_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), worker_membership_id uuid not null references public.organisation_memberships(id), requirement_id uuid not null references public.role_competence_requirements(id), evidence_type text not null, issuer text not null, evidence_reference text not null, verifier_name text not null,
  assessed_state text not null check (assessed_state in ('met','not_met','pending')), limitation text, expires_at timestamptz, effective_from timestamptz not null, effective_until timestamptz, status text not null default 'active' check (status in ('active','superseded','withdrawn')),
  superseded_by uuid references public.worker_competence_evidence_versions(id), created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now()
);

------------------------------------------------------------------------
-- Participant identifier, service context and immutable shift evidence
------------------------------------------------------------------------
create table if not exists public.participant_ndis_identifiers (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), participant_id uuid not null references public.participants(id), identifier_value text not null,
  created_by uuid not null references public.global_profiles(id), created_at timestamptz not null default pg_catalog.now(), updated_at timestamptz not null default pg_catalog.now(), unique (organisation_id, participant_id)
);
create table if not exists public.participant_service_context_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), participant_id uuid not null references public.participants(id), capability_id uuid not null references public.organisation_support_capabilities(id), catalogue_item_id uuid not null references public.provider_support_items(id),
  external_agreement_reference text not null, plan_reference text, source_type text not null, owner_profile_id uuid not null references public.global_profiles(id), reviewer_profile_id uuid references public.global_profiles(id), effective_from timestamptz not null, effective_until timestamptz not null,
  goal_source text not null, goal_reference text not null, goal_display text not null, lifecycle_state text not null check (lifecycle_state in ('draft','active','review_required','superseded','withdrawn','expired')),
  screening_required_by_participant boolean not null default false, screening_decision_issuer text, screening_decision_authority text, screening_evidence_reference text,
  superseded_by uuid references public.participant_service_context_versions(id), created_at timestamptz not null default pg_catalog.now(), check (effective_until > effective_from)
);
create table if not exists public.shift_service_snapshots (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), shift_id uuid not null unique references public.shifts(id) on delete cascade, service_context_id uuid not null references public.participant_service_context_versions(id), capability_id uuid not null references public.organisation_support_capabilities(id), catalogue_item_id uuid not null references public.provider_support_items(id), catalogue_version_id uuid not null references public.provider_support_catalogue_versions(id), item_code text not null, item_name text not null, support_category text not null, service_kind text not null, time_unit text not null, goal_reference text not null, goal_display text not null, scheduled_start timestamptz not null, scheduled_end timestamptz not null, created_at timestamptz not null default pg_catalog.now()
);

update public.shifts s
set state = 'legacy_incomplete'
where not exists (select 1 from public.shift_service_snapshots x where x.shift_id = s.id);
create table if not exists public.service_acknowledgement_events (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), shift_id uuid not null references public.shifts(id) on delete cascade,
  event_class text not null check (event_class in ('attempt','conclusive')), event_type text not null check (event_type in ('unavailable_attempt','not_obtained_attempt','external_signed_evidence','external_decline_evidence')),
  source_channel text not null default 'provider_recorded', recorder_profile_id uuid not null references public.global_profiles(id), reported_signer_profile_id uuid references public.global_profiles(id), authority_type text check (authority_type is null or authority_type in ('participant_self','child_representative','plan_nominee','legal_guardian')), method text, occurred_at timestamptz not null, external_evidence_reference text, reason text, supersedes_event_id uuid references public.service_acknowledgement_events(id), command_receipt_id uuid references public.command_receipts(id), created_at timestamptz not null default pg_catalog.now(), unique (command_receipt_id)
);
create table if not exists public.service_acknowledgement_reviews (
  id uuid primary key default pg_catalog.gen_random_uuid(), organisation_id uuid not null references public.organisations(id), shift_id uuid not null references public.shifts(id), event_id uuid not null references public.service_acknowledgement_events(id), reason text not null, created_at timestamptz not null default pg_catalog.now(), unique(event_id)
);

------------------------------------------------------------------------
-- RLS is explicit on every new relation; writes are RPC-only.
------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['organisation_provider_scope_versions','organisation_support_capabilities','provider_support_catalogue_versions','provider_support_items','risk_assessed_role_versions','role_screening_policy_versions','worker_screening_verification_versions','worker_screening_pathway_versions','role_competence_requirements','worker_competence_evidence_versions','participant_ndis_identifiers','participant_service_context_versions','shift_service_snapshots','service_acknowledgement_events','service_acknowledgement_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    execute format('revoke all on table public.%I from anon', t);
  end loop;
end $$;

create or replace function public.provider_readiness(p_organisation_id uuid, p_worker_membership_id uuid, p_context_id uuid, p_start timestamptz, p_end timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.participant_service_context_versions%rowtype; cap public.organisation_support_capabilities%rowtype; item public.provider_support_items%rowtype; scope public.organisation_provider_scope_versions%rowtype; m public.organisation_memberships%rowtype; role_row public.risk_assessed_role_versions%rowtype; required_screening boolean; registered_risk boolean; policy_missing boolean; bad_screening boolean; missing_competence boolean;
begin
  select * into c from public.participant_service_context_versions where id=p_context_id and organisation_id=p_organisation_id;
  if c.id is null or c.lifecycle_state <> 'active' or c.reviewer_profile_id is null or c.effective_from > p_start or c.effective_until < p_end then return pg_catalog.jsonb_build_object('ready',false,'reason','context_not_current'); end if;
  select * into cap from public.organisation_support_capabilities where id=c.capability_id and organisation_id=p_organisation_id and status='active' and capability='individual_time_supported' and effective_from <= p_start and (effective_until is null or effective_until >= p_end);
  if cap.id is null then return pg_catalog.jsonb_build_object('ready',false,'reason','capability_not_supported'); end if;
  select * into item from public.provider_support_items where id=c.catalogue_item_id and organisation_id=p_organisation_id and status='active' and time_unit in ('hour','minute') and effective_from <= p_start and (effective_until is null or effective_until >= p_end);
  if item.id is null or item.service_kind <> cap.service_kind or item.support_category <> cap.support_category then return pg_catalog.jsonb_build_object('ready',false,'reason','catalogue_mismatch'); end if;
  select * into m from public.organisation_memberships where id=p_worker_membership_id and organisation_id=p_organisation_id and status='active' and role='worker' and effective_from <= p_start and (effective_until is null or effective_until >= p_end);
  if m.id is null then return pg_catalog.jsonb_build_object('ready',false,'reason','worker_membership_invalid'); end if;
  select rr.* into role_row from public.risk_assessed_role_versions rr where rr.organisation_id=p_organisation_id and rr.status='active' order by rr.created_at desc limit 1;
  registered_risk := coalesce(role_row.risk_assessed,false) and exists(select 1 from public.organisation_provider_scope_versions s where s.organisation_id=p_organisation_id and s.status='active' and s.registration_state='registered');
  select exists(select 1 from public.role_screening_policy_versions p where p.organisation_id=p_organisation_id and p.role_version_id=role_row.id and p.status='active' and p.decision='required' and p.effective_from <= p_start and (p.effective_until is null or p.effective_until >= p_end)) into required_screening;
  select not exists(select 1 from public.role_screening_policy_versions p where p.organisation_id=p_organisation_id and p.role_version_id=role_row.id and p.status='active' and p.effective_from <= p_start and (p.effective_until is null or p.effective_until >= p_end)) into policy_missing;
  if required_screening or registered_risk or c.screening_required_by_participant then
    if not exists(select 1 from public.worker_screening_verification_versions v where v.organisation_id=p_organisation_id and v.worker_membership_id=p_worker_membership_id and v.status='active' and v.clearance_status='current' and v.verified_at <= p_start and (v.clearance_expires_at is null or v.clearance_expires_at >= p_end) and not (v.interim_bar or v.suspension or v.exclusion or v.revocation))
       and not exists(select 1 from public.worker_screening_pathway_versions w where w.organisation_id=p_organisation_id and w.worker_membership_id=p_worker_membership_id and w.status='active' and w.effective_from <= p_start and w.effective_until >= p_end and w.supervisor_clearance_reference is not null and w.risk_management_plan_reference is not null and (w.pathway not in ('higher_education_placement','contractor_administered') or w.administering_organisation is not null)) then return pg_catalog.jsonb_build_object('ready',false,'reason','screening_not_current'); end if;
  elsif policy_missing and exists(select 1 from public.organisation_provider_scope_versions s where s.organisation_id=p_organisation_id and s.registration_state='unregistered' and s.status='active') then return pg_catalog.jsonb_build_object('ready',false,'reason','unregistered_screening_policy_missing'); end if;
  select exists(select 1 from public.worker_screening_verification_versions v where v.organisation_id=p_organisation_id and v.worker_membership_id=p_worker_membership_id and (v.interim_bar or v.suspension or v.exclusion or v.revocation) and v.effective_from <= p_end and (v.effective_until is null or v.effective_until >= p_start)) into bad_screening;
  if bad_screening then return pg_catalog.jsonb_build_object('ready',false,'reason','adverse_screening_status'); end if;
  select exists(select 1 from public.role_competence_requirements r where r.organisation_id=p_organisation_id and r.support_category=item.support_category and r.requirement_state='required' and r.status='active' and not exists(select 1 from public.worker_competence_evidence_versions e where e.organisation_id=p_organisation_id and e.worker_membership_id=p_worker_membership_id and e.requirement_id=r.id and e.status='active' and e.assessed_state='met' and e.effective_from <= p_start and (e.expires_at is null or e.expires_at >= p_end))) into missing_competence;
  if missing_competence then return pg_catalog.jsonb_build_object('ready',false,'reason','competence_not_current'); end if;
  return pg_catalog.jsonb_build_object('ready',true,'context_id',c.id,'capability_id',cap.id,'catalogue_item_id',item.id);
end $$;
revoke all on function public.provider_readiness(uuid,uuid,uuid,timestamptz,timestamptz) from public;
revoke all on function public.provider_readiness(uuid,uuid,uuid,timestamptz,timestamptz) from anon;
grant execute on function public.provider_readiness(uuid,uuid,uuid,timestamptz,timestamptz) to authenticated;

create or replace function public.cmd_admin_create_service_ready_shift(p_command_id text,p_organisation_id uuid,p_participant_id uuid,p_worker_membership uuid,p_service_context_id uuid,p_scheduled_start timestamptz,p_scheduled_end timestamptz,p_reason text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; reserved record; ready jsonb; s public.shifts%rowtype; a public.shift_assignments%rowtype; c public.participant_service_context_versions%rowtype; i public.provider_support_items%rowtype; cap public.organisation_support_capabilities%rowtype; cv public.provider_support_catalogue_versions%rowtype; snap public.shift_service_snapshots%rowtype; out jsonb;
begin
  actor := public.admin_context(p_organisation_id);
  if p_scheduled_end <= p_scheduled_start then raise exception 'shift_dates_invalid'; end if;
  select * into reserved from public.reserve_admin_command(p_command_id,'admin_create_service_ready_shift',p_organisation_id,actor,p_payload);
  if not reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',reserved.receipt_id,'outcome',reserved.outcome); end if;
  ready := public.provider_readiness(p_organisation_id,p_worker_membership,p_service_context_id,p_scheduled_start,p_scheduled_end);
  if coalesce((ready->>'ready')::boolean,false) is not true then raise exception 'provider_not_ready' using detail = ready->>'reason'; end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  select * into c from public.participant_service_context_versions where id=p_service_context_id and participant_id=p_participant_id and organisation_id=p_organisation_id;
  select * into cap from public.organisation_support_capabilities where id=c.capability_id;
  select * into i from public.provider_support_items where id=c.catalogue_item_id;
  select * into cv from public.provider_support_catalogue_versions where id=i.catalogue_version_id;
  insert into public.shifts(organisation_id,participant_id,scheduled_start,scheduled_end,state,version) values(p_organisation_id,p_participant_id,p_scheduled_start,p_scheduled_end,'scheduled',1) returning * into s;
  insert into public.shift_assignments(shift_id,organisation_id,membership_id,effective_from,assigned_by,reassignment_reason) values(s.id,p_organisation_id,p_worker_membership,pg_catalog.now(),auth.uid(),nullif(pg_catalog.btrim(p_reason),'')) returning * into a;
  insert into public.shift_service_snapshots(organisation_id,shift_id,service_context_id,capability_id,catalogue_item_id,catalogue_version_id,item_code,item_name,support_category,service_kind,time_unit,goal_reference,goal_display,scheduled_start,scheduled_end) values(p_organisation_id,s.id,c.id,cap.id,i.id,cv.id,i.item_code,i.item_name,i.support_category,i.service_kind,i.time_unit,c.goal_reference,c.goal_display,s.scheduled_start,s.scheduled_end) returning * into snap;
  perform public.record_shift_audit(p_organisation_id,s.id,actor,'created','shift.service_ready_created',pg_catalog.jsonb_build_object('snapshot_id',snap.id,'readiness',ready));
  out := pg_catalog.jsonb_build_object('shift_id',s.id,'assignment_id',a.id,'snapshot_id',snap.id,'readiness',ready);
  perform public.finalize_admin_command(reserved.receipt_id,out);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',reserved.receipt_id) || out;
end $$;
revoke all on function public.cmd_admin_create_service_ready_shift(text,uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
revoke all on function public.cmd_admin_create_service_ready_shift(text,uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from anon;
grant execute on function public.cmd_admin_create_service_ready_shift(text,uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

create or replace function public.cmd_admin_reveal_participant_ndis_identifier(p_command_id text,p_organisation_id uuid,p_participant_id uuid,p_reason text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; reserved record; value text; out jsonb;
begin
  actor := public.current_membership(p_organisation_id);
  if actor is null or not public.membership_has_role(actor,'admin') then raise exception 'admin_required' using errcode='42501'; end if;
  if nullif(pg_catalog.btrim(p_reason),'') is null then raise exception 'reveal_reason_required'; end if;
  select * into reserved from public.reserve_admin_command(p_command_id,'admin_identifier',p_organisation_id,actor,p_payload);
  if not reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',reserved.receipt_id,'outcome',reserved.outcome); end if;
  select identifier_value into value from public.participant_ndis_identifiers where organisation_id=p_organisation_id and participant_id=p_participant_id;
  if value is null then raise exception 'identifier_not_found'; end if;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'participant_ndis_identifier.revealed','participant',p_participant_id,pg_catalog.jsonb_build_object('reason',pg_catalog.btrim(p_reason)));
  out := pg_catalog.jsonb_build_object('participant_id',p_participant_id,'identifier',value);
  perform public.finalize_admin_command(reserved.receipt_id,out);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',reserved.receipt_id) || out;
end $$;
revoke all on function public.cmd_admin_reveal_participant_ndis_identifier(text,uuid,uuid,text,jsonb) from public;
revoke all on function public.cmd_admin_reveal_participant_ndis_identifier(text,uuid,uuid,text,jsonb) from anon;
grant execute on function public.cmd_admin_reveal_participant_ndis_identifier(text,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.mask_participant_ndis_identifier(p_identifier text)
returns text language sql immutable set search_path = '' as $$ select case when p_identifier is null then null else repeat('*', greatest(length(p_identifier)-4,0)) || right(p_identifier,4) end $$;
revoke all on function public.mask_participant_ndis_identifier(text) from public;
revoke all on function public.mask_participant_ndis_identifier(text) from anon;
grant execute on function public.mask_participant_ndis_identifier(text) to authenticated;

-- Start must never trust roster-time evidence.  The existing worker command
-- calls this predicate through the shift snapshot; this trigger also prevents
-- accidental starts of migrated history from direct SQL in privileged tooling.
create or replace function public.prevent_legacy_incomplete_start()
returns trigger language plpgsql security definer set search_path = '' as $$ begin
  if new.state in ('started','ended_summary_required','finalised') and old.state = 'legacy_incomplete' then raise exception 'legacy_incomplete_not_actionable'; end if;
  if new.state = 'started' and old.state <> 'started' then
    if not exists (select 1 from public.shift_service_snapshots x where x.shift_id = new.id) then raise exception 'service_snapshot_required'; end if;
    if not exists (
      select 1 from public.shift_assignments a
      where a.shift_id = new.id and a.withdrawn_at is null and a.effective_from <= pg_catalog.now()
        and (a.effective_until is null or a.effective_until > pg_catalog.now())
        and (public.provider_readiness(new.organisation_id,a.membership_id,(select service_context_id from public.shift_service_snapshots where shift_id=new.id),new.scheduled_start,new.scheduled_end)->>'ready')::boolean
    ) then raise exception 'provider_readiness_failed'; end if;
  end if;
  if old.state = 'started' and new.state in ('ended_summary_required','finalised') then
    if exists (select 1 from public.shift_service_snapshots x where x.shift_id = new.id)
       and not exists (
         select 1 from public.shift_assignments a
         where a.shift_id = new.id and a.withdrawn_at is null
           and (public.provider_readiness(new.organisation_id,a.membership_id,(select service_context_id from public.shift_service_snapshots where shift_id=new.id),new.scheduled_start,new.scheduled_end)->>'ready')::boolean
       ) then new.state := 'urgent_provider_review'; end if;
  end if;
  return new;
end $$;
revoke all on function public.prevent_legacy_incomplete_start() from public;
revoke all on function public.prevent_legacy_incomplete_start() from anon;
drop trigger if exists shifts_prevent_legacy_incomplete_start on public.shifts;
create trigger shifts_prevent_legacy_incomplete_start before update on public.shifts for each row execute function public.prevent_legacy_incomplete_start();

create or replace function public.prevent_unready_reassignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.shifts%rowtype; x public.shift_service_snapshots%rowtype; result jsonb;
begin
  select * into s from public.shifts where id=new.shift_id and organisation_id=new.organisation_id;
  select * into x from public.shift_service_snapshots where shift_id=new.shift_id;
  if x.id is not null and s.state in ('scheduled','in_transit') then
    result := public.provider_readiness(new.organisation_id,new.membership_id,x.service_context_id,s.scheduled_start,s.scheduled_end);
    if coalesce((result->>'ready')::boolean,false) is not true then raise exception 'provider_readiness_failed' using detail=result->>'reason'; end if;
  end if;
  return new;
end $$;
revoke all on function public.prevent_unready_reassignment() from public;
revoke all on function public.prevent_unready_reassignment() from anon;
create trigger shift_assignments_require_readiness before insert or update on public.shift_assignments for each row execute function public.prevent_unready_reassignment();

-- New relations are intentionally not exposed through broad table grants.
grant select on public.organisation_provider_scope_versions, public.organisation_support_capabilities, public.provider_support_catalogue_versions, public.provider_support_items, public.risk_assessed_role_versions, public.role_screening_policy_versions, public.participant_service_context_versions, public.shift_service_snapshots to authenticated;

create or replace function public.cmd_admin_set_ndis_identifier(p_command_id text,p_organisation_id uuid,p_participant_id uuid,p_identifier text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; reserved record; row_id uuid; out jsonb;
begin
  actor := public.current_membership(p_organisation_id); if actor is null or not public.membership_has_role(actor,'admin') then raise exception 'admin_required' using errcode='42501'; end if;
  if nullif(pg_catalog.btrim(p_identifier),'') is null or p_identifier !~ '^[0-9]{9,12}$' then raise exception 'identifier_invalid'; end if;
  select * into reserved from public.reserve_admin_command(p_command_id,'admin_identifier',p_organisation_id,actor,p_payload); if not reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',reserved.receipt_id,'outcome',reserved.outcome); end if;
  insert into public.participant_ndis_identifiers(organisation_id,participant_id,identifier_value,created_by) values(p_organisation_id,p_participant_id,pg_catalog.btrim(p_identifier),auth.uid()) on conflict(organisation_id,participant_id) do update set identifier_value=excluded.identifier_value,updated_at=pg_catalog.now() returning id into row_id;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'participant_ndis_identifier.recorded','participant',p_participant_id,pg_catalog.jsonb_build_object('identifier_id',row_id));
  out := pg_catalog.jsonb_build_object('identifier_id',row_id,'masked_identifier',public.mask_participant_ndis_identifier(p_identifier)); perform public.finalize_admin_command(reserved.receipt_id,out); return pg_catalog.jsonb_build_object('status','accepted','receipt_id',reserved.receipt_id)||out;
end $$;
revoke all on function public.cmd_admin_set_ndis_identifier(text,uuid,uuid,text,jsonb) from public;
revoke all on function public.cmd_admin_set_ndis_identifier(text,uuid,uuid,text,jsonb) from anon;
grant execute on function public.cmd_admin_set_ndis_identifier(text,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.list_admin_masked_participant_ndis_identifiers(p_organisation_id uuid)
returns table(participant_id uuid, masked_identifier text) language sql stable security definer set search_path = '' as $$
  select i.participant_id, public.mask_participant_ndis_identifier(i.identifier_value) from public.participant_ndis_identifiers i where i.organisation_id=p_organisation_id and public.admin_context(p_organisation_id) is not null;
$$;
revoke all on function public.list_admin_masked_participant_ndis_identifiers(uuid) from public;
revoke all on function public.list_admin_masked_participant_ndis_identifiers(uuid) from anon;
grant execute on function public.list_admin_masked_participant_ndis_identifiers(uuid) to authenticated;

create or replace function public.cmd_admin_create_service_context(p_command_id text,p_organisation_id uuid,p_participant_id uuid,p_capability_id uuid,p_catalogue_item_id uuid,p_external_agreement_reference text,p_plan_reference text,p_source_type text,p_owner_profile_id uuid,p_reviewer_profile_id uuid,p_effective_from timestamptz,p_effective_until timestamptz,p_goal_source text,p_goal_reference text,p_goal_display text,p_lifecycle_state text,p_screening_required boolean,p_screening_decision_issuer text,p_screening_decision_authority text,p_screening_evidence_reference text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; reserved record; row_id uuid; out jsonb;
begin
  actor := public.admin_context(p_organisation_id); if p_effective_until <= p_effective_from then raise exception 'context_dates_invalid'; end if; if p_lifecycle_state not in ('draft','active','review_required') then raise exception 'context_lifecycle_invalid'; end if;
  if p_lifecycle_state='active' and (p_reviewer_profile_id is null or nullif(pg_catalog.btrim(p_goal_reference),'') is null) then raise exception 'reviewed_context_required'; end if;
  select * into reserved from public.reserve_admin_command(p_command_id,'admin_service_context',p_organisation_id,actor,p_payload); if not reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',reserved.receipt_id,'outcome',reserved.outcome); end if;
  insert into public.participant_service_context_versions(organisation_id,participant_id,capability_id,catalogue_item_id,external_agreement_reference,plan_reference,source_type,owner_profile_id,reviewer_profile_id,effective_from,effective_until,goal_source,goal_reference,goal_display,lifecycle_state,screening_required_by_participant,screening_decision_issuer,screening_decision_authority,screening_evidence_reference) values(p_organisation_id,p_participant_id,p_capability_id,p_catalogue_item_id,pg_catalog.btrim(p_external_agreement_reference),nullif(pg_catalog.btrim(p_plan_reference),''),pg_catalog.btrim(p_source_type),p_owner_profile_id,p_reviewer_profile_id,p_effective_from,p_effective_until,pg_catalog.btrim(p_goal_source),pg_catalog.btrim(p_goal_reference),pg_catalog.btrim(p_goal_display),p_lifecycle_state,p_screening_required,p_screening_decision_issuer,p_screening_decision_authority,p_screening_evidence_reference) returning id into row_id;
  out := pg_catalog.jsonb_build_object('service_context_id',row_id); perform public.finalize_admin_command(reserved.receipt_id,out); return pg_catalog.jsonb_build_object('status','accepted','receipt_id',reserved.receipt_id)||out;
end $$;
revoke all on function public.cmd_admin_create_service_context(text,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz,timestamptz,text,text,text,text,boolean,text,text,text,jsonb) from public;
revoke all on function public.cmd_admin_create_service_context(text,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz,timestamptz,text,text,text,text,boolean,text,text,text,jsonb) from anon;
grant execute on function public.cmd_admin_create_service_context(text,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz,timestamptz,text,text,text,text,boolean,text,text,text,jsonb) to authenticated;

create or replace function public.cmd_admin_record_acknowledgement(p_command_id text,p_organisation_id uuid,p_shift_id uuid,p_event_class text,p_event_type text,p_reported_signer_profile_id uuid,p_authority_type text,p_method text,p_occurred_at timestamptz,p_reason text,p_external_evidence_reference text,p_expected_current_event_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid; reserved record; prior public.service_acknowledgement_events%rowtype; ev public.service_acknowledgement_events%rowtype; out jsonb; valid_authority boolean := false;
begin
  actor := public.admin_context(p_organisation_id); if p_event_class not in ('attempt','conclusive') then raise exception 'ack_event_class_invalid'; end if;
  if p_event_class='attempt' and (p_event_type not in ('unavailable_attempt','not_obtained_attempt') or nullif(pg_catalog.btrim(p_reason),'') is null) then raise exception 'ack_attempt_reason_required'; end if;
  if p_event_class='conclusive' and (p_event_type not in ('external_signed_evidence','external_decline_evidence') or nullif(pg_catalog.btrim(p_method),'') is null or nullif(pg_catalog.btrim(p_external_evidence_reference),'') is null or p_reported_signer_profile_id is null or p_authority_type is null) then raise exception 'ack_conclusive_evidence_required'; end if;
  select * into reserved from public.reserve_admin_command(p_command_id,'admin_acknowledgement',p_organisation_id,actor,p_payload); if not reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',reserved.receipt_id,'outcome',reserved.outcome); end if;
  if p_event_class='conclusive' then
    valid_authority := p_authority_type='participant_self' and exists(select 1 from public.shifts s join public.participant_self_links l on l.participant_id=s.participant_id where s.id=p_shift_id and l.profile_id=p_reported_signer_profile_id and l.status='active')
      or p_authority_type in ('child_representative','plan_nominee','legal_guardian') and exists(select 1 from public.shifts s join public.representative_authorities a on a.participant_id=s.participant_id where s.id=p_shift_id and a.representative_profile_id=p_reported_signer_profile_id and a.status='active' and p_occurred_at >= a.effective_from and (a.effective_until is null or p_occurred_at < a.effective_until) and ('service_acknowledgement'=any(a.scope_categories) or 'service_summary'=any(a.scope_categories)));
    if not valid_authority then raise exception 'ack_authority_not_allowed'; end if;
    select * into prior from public.service_acknowledgement_events where shift_id=p_shift_id and event_class='conclusive' and supersedes_event_id is null order by created_at desc limit 1;
    if prior.id is not null and p_expected_current_event_id is distinct from prior.id then
      insert into public.service_acknowledgement_events(organisation_id,shift_id,event_class,event_type,recorder_profile_id,reported_signer_profile_id,authority_type,method,occurred_at,external_evidence_reference,reason,command_receipt_id) values(p_organisation_id,p_shift_id,p_event_class,p_event_type,auth.uid(),p_reported_signer_profile_id,p_authority_type,p_method,p_occurred_at,p_external_evidence_reference,p_reason,reserved.receipt_id) returning * into ev;
      insert into public.service_acknowledgement_reviews(organisation_id,shift_id,event_id,reason) values(p_organisation_id,p_shift_id,ev.id,'stale_expected_current_event');
      out := pg_catalog.jsonb_build_object('status','conflict_preserved','event_id',ev.id,'reason','stale_expected_current_event'); perform public.finalize_admin_command(reserved.receipt_id,out); return pg_catalog.jsonb_build_object('status','conflict_preserved','receipt_id',reserved.receipt_id)||out;
    end if;
  end if;
  insert into public.service_acknowledgement_events(organisation_id,shift_id,event_class,event_type,recorder_profile_id,reported_signer_profile_id,authority_type,method,occurred_at,external_evidence_reference,reason,supersedes_event_id,command_receipt_id) values(p_organisation_id,p_shift_id,p_event_class,p_event_type,auth.uid(),p_reported_signer_profile_id,p_authority_type,p_method,p_occurred_at,p_external_evidence_reference,p_reason,p_expected_current_event_id,reserved.receipt_id) returning * into ev;
  out := pg_catalog.jsonb_build_object('event_id',ev.id,'current_event_id',case when p_event_class='conclusive' then ev.id else prior.id end); perform public.finalize_admin_command(reserved.receipt_id,out); return pg_catalog.jsonb_build_object('status','accepted','receipt_id',reserved.receipt_id)||out;
end $$;
revoke all on function public.cmd_admin_record_acknowledgement(text,uuid,uuid,text,text,uuid,text,text,timestamptz,text,text,uuid,jsonb) from public;
revoke all on function public.cmd_admin_record_acknowledgement(text,uuid,uuid,text,text,uuid,text,text,timestamptz,text,text,uuid,jsonb) from anon;
grant execute on function public.cmd_admin_record_acknowledgement(text,uuid,uuid,text,text,uuid,text,text,timestamptz,text,text,uuid,jsonb) to authenticated;

-- Office read views are explicit.  Compliance verification/pathway/evidence
-- relations intentionally have no authenticated SELECT policy: they remain
-- office-owned evidence and are only consumed by readiness RPCs.
do $$
declare t text;
begin
  foreach t in array array['organisation_provider_scope_versions','organisation_support_capabilities','provider_support_catalogue_versions','provider_support_items','risk_assessed_role_versions','role_screening_policy_versions','participant_service_context_versions','shift_service_snapshots'] loop
    execute format('drop policy if exists %I on public.%I', t||'_office_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (organisation_id = public.current_active_organisation_id() and public.current_user_membership_role() in (''admin'',''scheduler''))', t||'_office_select', t);
  end loop;
end $$;
drop policy if exists shift_service_snapshots_assigned_worker_select on public.shift_service_snapshots;
create policy shift_service_snapshots_assigned_worker_select on public.shift_service_snapshots for select to authenticated using (
  exists (select 1 from public.shift_assignments a join public.organisation_memberships m on m.id=a.membership_id where a.shift_id=shift_service_snapshots.shift_id and m.profile_id=auth.uid() and m.role='worker' and a.withdrawn_at is null)
);

-- Replace the pre-0009 seed so a synthetic environment exercises the same
-- provider-ready path as the admin UI.  It remains service-role-only and
-- writes synthetic identifiers/evidence only.
create or replace function public.seed_synthetic_demo(p_worker_membership_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.organisation_memberships%rowtype; scope_id uuid; cap_id uuid; cv_id uuid; item_id uuid; role_id uuid; policy_id uuid; req_id uuid; p_id uuid; ctx_id uuid; shift_id uuid; snap_id uuid; i integer;
begin
  if coalesce(auth.role(),'anon') <> 'service_role' then raise exception 'synthetic_seed_service_role_required' using errcode='42501'; end if;
  select * into m from public.organisation_memberships where id=p_worker_membership_id and role='worker' and status='active' for update;
  if m.id is null then raise exception 'synthetic_seed_worker_membership_invalid'; end if;
  if not exists(select 1 from public.global_profiles where id=m.profile_id and email like '%.synthetic') then raise exception 'synthetic_seed_requires_dedicated_identity'; end if;
  scope_id := md5('ndis.synthetic.scope:'||m.organisation_id::text)::uuid; cap_id := md5('ndis.synthetic.capability:'||m.organisation_id::text)::uuid; cv_id := md5('ndis.synthetic.catalogue:'||m.organisation_id::text)::uuid; item_id := md5('ndis.synthetic.item:'||m.organisation_id::text)::uuid; role_id := md5('ndis.synthetic.role:'||m.organisation_id::text)::uuid; policy_id := md5('ndis.synthetic.policy:'||m.organisation_id::text)::uuid; req_id := md5('ndis.synthetic.requirement:'||m.organisation_id::text)::uuid;
  insert into public.organisation_provider_scope_versions(id,organisation_id,registration_state,registration_group,class_of_support,jurisdictions,effective_from,authored_by,reviewed_by) values(scope_id,m.organisation_id,'registered','synthetic','individual',array['NSW'],pg_catalog.now(),m.profile_id,m.profile_id) on conflict(id) do nothing;
  insert into public.organisation_support_capabilities(id,organisation_id,scope_version_id,support_category,service_kind,capability,effective_from) values(cap_id,m.organisation_id,scope_id,'daily_living','individual_time','individual_time_supported',pg_catalog.now()) on conflict(id) do nothing;
  insert into public.provider_support_catalogue_versions(id,organisation_id,source_label,source_version,effective_from,created_by) values(cv_id,m.organisation_id,'Provider synthetic catalogue','v1',pg_catalog.now(),m.profile_id) on conflict(id) do nothing;
  insert into public.provider_support_items(id,organisation_id,catalogue_version_id,item_code,item_name,support_category,time_unit,service_kind,effective_from) values(item_id,m.organisation_id,cv_id,'SYN-TIME-001','Individual time support','daily_living','hour','individual_time',pg_catalog.now()) on conflict(id) do nothing;
  insert into public.risk_assessed_role_versions(id,organisation_id,title,definition_basis,description,assessed_at,assessor_name,assessor_title,effective_from,created_by) values(role_id,m.organisation_id,'Synthetic support worker','provider policy','Synthetic readiness role',pg_catalog.now(),'Synthetic Admin','Provider Admin',pg_catalog.now(),m.profile_id) on conflict(id) do nothing;
  insert into public.role_screening_policy_versions(id,organisation_id,role_version_id,registration_state,decision,decision_owner,decision_reason,effective_from,created_by) values(policy_id,m.organisation_id,role_id,'registered','required','Synthetic Admin','Synthetic provider policy',pg_catalog.now(),m.profile_id) on conflict(id) do nothing;
  insert into public.role_competence_requirements(id,organisation_id,role_version_id,support_category,evidence_type,requirement_state,assessment_method,review_owner,effective_from,created_by) values(req_id,m.organisation_id,role_id,'daily_living','induction','required','provider_assessed','Synthetic Admin',pg_catalog.now(),m.profile_id) on conflict(id) do nothing;
  insert into public.worker_screening_verification_versions(organisation_id,worker_membership_id,role_version_id,source_checked,verifier_name,verified_at,application_or_check_reference,clearance_status,clearance_expires_at,effective_from,created_by) values(m.organisation_id,m.id,role_id,'synthetic provider register','Synthetic Admin',pg_catalog.now(),'SYN-CHECK-001','current',pg_catalog.now()+interval '365 days',pg_catalog.now(),m.profile_id);
  insert into public.worker_competence_evidence_versions(organisation_id,worker_membership_id,requirement_id,evidence_type,issuer,evidence_reference,verifier_name,assessed_state,expires_at,effective_from,created_by) values(m.organisation_id,m.id,req_id,'induction','Synthetic Provider','SYN-COMP-001','Synthetic Admin','met',pg_catalog.now()+interval '365 days',pg_catalog.now(),m.profile_id);
  for i in 1..3 loop
    p_id := md5('ndis.synthetic.participant:'||m.organisation_id::text||':'||i::text)::uuid; ctx_id := md5('ndis.synthetic.context:'||m.organisation_id::text||':'||i::text)::uuid; shift_id := md5('ndis.synthetic.shift:'||m.organisation_id::text||':'||i::text)::uuid; snap_id := md5('ndis.synthetic.snapshot:'||m.organisation_id::text||':'||i::text)::uuid;
    insert into public.participants(id,organisation_id,first_name,last_initial,created_by) values(p_id,m.organisation_id,case i when 1 then 'Test Alpha' when 2 then 'Test Beta' else 'Test Gamma' end,'S',m.profile_id) on conflict(id) do nothing;
    insert into public.participant_ndis_identifiers(organisation_id,participant_id,identifier_value,created_by) values(m.organisation_id,p_id,'43000000000'||i::text,m.profile_id) on conflict(organisation_id,participant_id) do nothing;
    insert into public.participant_service_context_versions(id,organisation_id,participant_id,capability_id,catalogue_item_id,external_agreement_reference,plan_reference,source_type,owner_profile_id,reviewer_profile_id,effective_from,effective_until,goal_source,goal_reference,goal_display,lifecycle_state) values(ctx_id,m.organisation_id,p_id,cap_id,item_id,'SYN-AGREEMENT-'||i::text,'SYN-PLAN-'||i::text,'provider_recorded',m.profile_id,m.profile_id,pg_catalog.now(),pg_catalog.now()+interval '365 days','participant_goal','SYN-GOAL-'||i::text,'Synthetic participant goal','active') on conflict(id) do nothing;
    insert into public.shifts(id,organisation_id,participant_id,scheduled_start,scheduled_end,state,version) values(shift_id,m.organisation_id,p_id,pg_catalog.date_trunc('day',pg_catalog.now())+interval '1 day 9 hours',pg_catalog.date_trunc('day',pg_catalog.now())+interval '1 day 10 hours','scheduled',1) on conflict(id) do update set state='scheduled',version=1;
    insert into public.shift_assignments(id,shift_id,organisation_id,membership_id,assigned_by) values(md5('ndis.synthetic.assignment:'||m.organisation_id::text||':'||i::text)::uuid,shift_id,m.organisation_id,m.id,m.profile_id) on conflict(id) do update set withdrawn_at=null,effective_until=null;
    insert into public.shift_service_snapshots(id,organisation_id,shift_id,service_context_id,capability_id,catalogue_item_id,catalogue_version_id,item_code,item_name,support_category,service_kind,time_unit,goal_reference,goal_display,scheduled_start,scheduled_end) values(snap_id,m.organisation_id,shift_id,ctx_id,cap_id,item_id,cv_id,'SYN-TIME-001','Individual time support','daily_living','individual_time','hour','SYN-GOAL-'||i::text,'Synthetic participant goal',pg_catalog.date_trunc('day',pg_catalog.now())+interval '1 day 9 hours',pg_catalog.date_trunc('day',pg_catalog.now())+interval '1 day 10 hours') on conflict(id) do nothing;
  end loop;
  return pg_catalog.jsonb_build_object('status','seeded','organisation_id',m.organisation_id,'worker_membership_id',m.id,'participants',3,'ready_path',true,'synthetic_only',true,'deterministic',true,'transactional',true);
end $$;
revoke all on function public.seed_synthetic_demo(uuid) from public;
revoke all on function public.seed_synthetic_demo(uuid) from anon;
grant execute on function public.seed_synthetic_demo(uuid) to service_role;
