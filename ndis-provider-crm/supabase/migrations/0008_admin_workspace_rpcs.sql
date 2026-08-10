-- 0008_admin_workspace_rpcs.sql
--
-- Ticket 05: narrow, transactional commands for the synthetic-only admin
-- workspace.  No authenticated client is granted direct write access to the
-- domain tables; all sensitive changes below validate the active membership,
-- write the record, and append an audit entry in one transaction.

set search_path = '';

alter table public.command_receipts drop constraint if exists command_receipts_command_type_check;
alter table public.command_receipts add constraint command_receipts_command_type_check check (command_type in (
  'on_my_way','start_shift','end_shift','submit_summary','finalise_summary',
  'cancel_shift','reassign_shift','resolve_conflict','request_correction',
  'request_access','apply_correction','accept_invitation',
  'admin_invite','admin_create_participant','admin_set_authority',
  'admin_create_grant','admin_revoke_grant','admin_set_availability',
  'admin_create_shift','admin_update_critical_info','admin_link_self'
  ,'admin_record_consent'
));

alter table public.shift_events drop constraint if exists shift_events_event_type_check;
alter table public.shift_events add constraint shift_events_event_type_check check (event_type in (
  'created','on_my_way','start','end','summary_submitted','summary_finalised',
  'cancelled','reassigned','corrected','conflicted','resolved'
));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'participant_self_links_identity_tenant'
      and conrelid = 'public.participant_self_links'::regclass
  ) then
    alter table public.participant_self_links
      add constraint participant_self_links_identity_tenant
      foreign key (organisation_id, profile_id)
      references public.organisation_memberships (organisation_id, profile_id)
      on delete restrict;
  end if;
end;
$$;

-- Consent evidence is intentionally separate from self-access links and
-- representative authority. It is a provider-recorded, immutable evidence
-- snapshot that a later disclosure grant must reference exactly.
create table if not exists public.participant_consent_evidence (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  participant_id uuid not null references public.participants(id) on delete restrict,
  recipient_profile_id uuid not null references public.global_profiles(id) on delete restrict,
  authorising_profile_id uuid not null references public.global_profiles(id) on delete restrict,
  consent_basis text not null check (consent_basis in ('participant','authorised_representative')),
  purpose text not null,
  scope_categories text[] not null check (cardinality(scope_categories) >= 1),
  evidence_reference text not null,
  effective_from timestamptz not null,
  effective_until timestamptz not null,
  status text not null default 'active' check (status in ('active','superseded','revoked','expired')),
  superseded_by uuid references public.participant_consent_evidence(id) on delete set null,
  representative_authority_id uuid references public.representative_authorities(id) on delete restrict,
  authority_scope_snapshot text[],
  authority_effective_from timestamptz,
  authority_effective_until timestamptz,
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.global_profiles(id) on delete set null,
  withdrawn_reason text,
  created_by uuid not null references public.global_profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint participant_consent_window_valid check (effective_until > effective_from),
  constraint participant_consent_tenant_match foreign key (organisation_id, participant_id)
    references public.participants(organisation_id, id) on delete restrict,
  constraint participant_consent_recipient_tenant foreign key (organisation_id, recipient_profile_id)
    references public.organisation_memberships(organisation_id, profile_id) on delete restrict,
  constraint participant_consent_authoriser_tenant foreign key (organisation_id, authorising_profile_id)
    references public.organisation_memberships(organisation_id, profile_id) on delete restrict
);
create index if not exists participant_consent_lookup_idx
  on public.participant_consent_evidence(organisation_id, participant_id, status, effective_until);
drop trigger if exists participant_consent_evidence_set_updated_at on public.participant_consent_evidence;
create trigger participant_consent_evidence_set_updated_at
  before update on public.participant_consent_evidence
  for each row execute function public.set_updated_at();
alter table public.participant_consent_evidence enable row level security;
drop policy if exists participant_consent_admin_select on public.participant_consent_evidence;
create policy participant_consent_admin_select on public.participant_consent_evidence for select to authenticated
using (organisation_id = public.current_active_organisation_id() and public.current_user_membership_role() in ('admin','scheduler'));
drop policy if exists participant_consent_self_select on public.participant_consent_evidence;
create policy participant_consent_self_select on public.participant_consent_evidence for select to authenticated
using (organisation_id = public.current_active_organisation_id() and (authorising_profile_id = auth.uid() or participant_id in (select public.current_user_self_links_participant_id())));

alter table public.external_disclosure_grants add column if not exists consent_record_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='external_grants_consent_record_fkey' and conrelid='public.external_disclosure_grants'::regclass) then
    alter table public.external_disclosure_grants add constraint external_grants_consent_record_fkey
      foreign key (consent_record_id) references public.participant_consent_evidence(id) on delete restrict;
  end if;
end $$;
revoke all on table public.participant_consent_evidence from anon;
revoke all on table public.participant_consent_evidence from public;

do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema='public' and table_name='invitations'
      and constraint_name='invitations_issued_by_fkey'
  ) then
    alter table public.invitations drop constraint invitations_issued_by_fkey;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname='invitations_issued_by_global_profiles_fkey'
      and conrelid='public.invitations'::regclass
  ) then
    alter table public.invitations
      add constraint invitations_issued_by_global_profiles_fkey
      foreign key (issued_by) references public.global_profiles(id) on delete set null;
  end if;
end;
$$;

create or replace function public.admin_context(p_organisation_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_membership uuid;
begin
  v_membership := public.current_membership(p_organisation_id);
  if v_membership is null then
    raise exception 'admin_or_scheduler_required' using errcode = '42501';
  end if;
  if not public.membership_has_role(v_membership,'admin')
     and not public.membership_has_role(v_membership,'scheduler') then
    raise exception 'admin_or_scheduler_required' using errcode = '42501';
  end if;
  return v_membership;
end;
$$;
revoke all on function public.admin_context(uuid) from public;
revoke all on function public.admin_context(uuid) from anon;
grant execute on function public.admin_context(uuid) to authenticated;

create or replace function public.list_admin_workspace_identities(
  p_organisation_id uuid,
  p_roles text[] default array['worker','participant','nominee','external']::text[]
)
returns table (membership_id uuid, profile_id uuid, role text, full_name text, email text)
language sql stable security definer set search_path = ''
as $$
  select distinct on (m.id, coalesce(r.role, m.role))
    m.id, m.profile_id, coalesce(r.role, m.role), gp.full_name, gp.email
  from public.organisation_memberships m
  left join public.organisation_membership_roles r on r.membership_id = m.id
  join public.global_profiles gp on gp.id = m.profile_id
  where m.organisation_id = p_organisation_id
    and coalesce(r.role, m.role) = any(p_roles)
    and public.current_membership(p_organisation_id) is not null
    and (public.membership_has_role(public.current_membership(p_organisation_id),'admin')
      or public.membership_has_role(public.current_membership(p_organisation_id),'scheduler'))
    and (r.id is null or (r.status = 'active'
      and r.effective_from <= pg_catalog.now()
      and (r.effective_until is null or r.effective_until > pg_catalog.now())))
    and (r.id is not null or not exists (select 1 from public.organisation_membership_roles r2 where r2.membership_id = m.id))
    and m.status = 'active'
    and m.effective_from <= pg_catalog.now()
    and (m.effective_until is null or m.effective_until > pg_catalog.now())
    and gp.deleted_at is null
  order by m.id, coalesce(r.role, m.role), gp.full_name;
$$;
revoke all on function public.list_admin_workspace_identities(uuid,text[]) from public;
revoke all on function public.list_admin_workspace_identities(uuid,text[]) from anon;
grant execute on function public.list_admin_workspace_identities(uuid,text[]) to authenticated;

create or replace function public.reserve_admin_command(
  p_command_id text,
  p_command_type text,
  p_organisation_id uuid,
  p_actor_membership uuid,
  p_payload jsonb
)
returns table (is_new boolean, receipt_id uuid, outcome jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  v_receipt_id uuid;
  v_outcome jsonb;
begin
  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    actor_profile_id, claimed_at, completed_at, status, outcome, payload
  ) values (
    p_command_id, p_command_type, p_organisation_id, p_actor_membership,
    auth.uid(), pg_catalog.now(), null, 'accepted', '{}'::jsonb,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (organisation_id, actor_membership_id, command_type, command_id) do nothing
  returning id into v_receipt_id;
  if v_receipt_id is not null then
    return query select true, v_receipt_id, '{}'::jsonb;
    return;
  end if;
  select r.id, r.outcome into v_receipt_id, v_outcome
  from public.command_receipts r
  where r.organisation_id = p_organisation_id
    and r.actor_membership_id = p_actor_membership
    and r.command_type = p_command_type
    and r.command_id = p_command_id;
  return query select false, v_receipt_id, v_outcome;
end;
$$;
revoke all on function public.reserve_admin_command(text,text,uuid,uuid,jsonb) from public;
revoke all on function public.reserve_admin_command(text,text,uuid,uuid,jsonb) from anon;
grant execute on function public.reserve_admin_command(text,text,uuid,uuid,jsonb) to authenticated;

create or replace function public.finalize_admin_command(p_receipt_id uuid, p_outcome jsonb)
returns void language sql security definer set search_path = ''
as $$
  update public.command_receipts
  set outcome = coalesce(p_outcome, '{}'::jsonb), completed_at = pg_catalog.now()
  where id = p_receipt_id and actor_profile_id = auth.uid();
$$;
revoke all on function public.finalize_admin_command(uuid,jsonb) from public;
revoke all on function public.finalize_admin_command(uuid,jsonb) from anon;
grant execute on function public.finalize_admin_command(uuid,jsonb) to authenticated;

create or replace function public.cmd_admin_invite(
  p_command_id text, p_organisation_id uuid, p_email text, p_role text,
  p_expires_at timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_actor_role text; v_inv public.invitations%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_invite',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  v_actor_role := case when public.membership_has_role(v_membership,'admin') then 'admin' else 'scheduler' end;
  if p_role not in ('admin','scheduler','worker','participant','external','nominee') then raise exception 'invalid_invitation_role'; end if;
  if v_actor_role = 'scheduler' and p_role not in ('worker','participant','nominee') then raise exception 'scheduler_invite_role_not_allowed' using errcode = '42501'; end if;
  if p_expires_at <= pg_catalog.now() then raise exception 'invitation_expiry_required'; end if;
  insert into public.invitations (organisation_id,email,role,token,expires_at,issued_by)
  values (p_organisation_id, pg_catalog.lower(pg_catalog.btrim(p_email)), p_role, pg_catalog.replace(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, '-',''), p_expires_at, auth.uid())
  returning * into v_inv;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (p_organisation_id,auth.uid(),'invitation.issued','invitation',v_inv.id,pg_catalog.jsonb_build_object('role',p_role,'expires_at',p_expires_at));
  v_outcome := pg_catalog.jsonb_build_object('invitation_id',v_inv.id,'role',p_role,'email_delivery','copy_link');
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'invitation_id',v_inv.id,'email',v_inv.email,'role',v_inv.role,'expires_at',v_inv.expires_at,'token',v_inv.token,'email_delivery','copy_link');
end; $$;
revoke all on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_link_participant(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_profile_id uuid, p_evidence_reference text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_row public.participant_self_links%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_link_self',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if nullif(pg_catalog.btrim(p_evidence_reference),'') is null then raise exception 'self_link_evidence_required'; end if;
  if not exists(
    select 1 from public.organisation_memberships m
    where m.organisation_id=p_organisation_id and m.profile_id=p_profile_id
      and public.membership_has_role(m.id,'participant')
  ) then raise exception 'participant_membership_required'; end if;
  insert into public.participant_self_links(organisation_id,participant_id,profile_id,status,evidence_reference)
  values(p_organisation_id,p_participant_id,p_profile_id,'active',pg_catalog.btrim(p_evidence_reference)) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'participant_self_link.created','participant_self_link',v_row.id,pg_catalog.jsonb_build_object('participant_id',p_participant_id,'profile_id',p_profile_id));
  v_outcome := pg_catalog.jsonb_build_object('self_link_id',v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'self_link_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) from public;
revoke all on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) from anon;
grant execute on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.cmd_admin_create_participant(
  p_command_id text, p_organisation_id uuid, p_first_name text,
  p_last_initial text, p_critical_content text, p_review_due_at timestamptz,
  p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_participant public.participants%rowtype; v_card public.critical_info_cards%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_create_participant',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if pg_catalog.length(pg_catalog.btrim(p_first_name)) < 2 then raise exception 'participant_name_required'; end if;
  if p_review_due_at <= pg_catalog.now() then raise exception 'review_due_must_be_future'; end if;
  insert into public.participants(organisation_id,first_name,last_initial,created_by)
  values(p_organisation_id,pg_catalog.btrim(p_first_name),nullif(pg_catalog.upper(pg_catalog.btrim(p_last_initial)),''),auth.uid()) returning * into v_participant;
  insert into public.critical_info_cards(organisation_id,participant_id,content_text,owner_profile_id,reviewed_at,review_due_at)
  values(p_organisation_id,v_participant.id,pg_catalog.btrim(p_critical_content),auth.uid(),pg_catalog.now(),p_review_due_at) returning * into v_card;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'participant.created','participant',v_participant.id,pg_catalog.jsonb_build_object('critical_info_card_id',v_card.id,'review_due_at',p_review_due_at));
  v_outcome := pg_catalog.jsonb_build_object('participant_id',v_participant.id,'critical_info_card_id',v_card.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'participant_id',v_participant.id,'critical_info_card_id',v_card.id);
end; $$;
revoke all on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_update_critical_info(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_critical_content text, p_review_due_at timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_old public.critical_info_cards%rowtype; v_new public.critical_info_cards%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_update_critical_info',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if p_review_due_at <= pg_catalog.now() then raise exception 'review_due_must_be_future'; end if;
  select * into v_old from public.critical_info_cards where organisation_id=p_organisation_id and participant_id=p_participant_id and status='active' for update;
  if v_old.id is null then raise exception 'critical_info_not_found'; end if;
  insert into public.critical_info_cards(organisation_id,participant_id,version,content_text,owner_profile_id,reviewed_at,review_due_at,status)
  values(p_organisation_id,p_participant_id,v_old.version+1,pg_catalog.btrim(p_critical_content),auth.uid(),pg_catalog.now(),p_review_due_at,'active') returning * into v_new;
  update public.critical_info_cards set status='superseded',superseded_by=v_new.id where id=v_old.id;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'critical_info.updated','participant',p_participant_id,pg_catalog.jsonb_build_object('previous_card_id',v_old.id,'critical_info_card_id',v_new.id));
  v_outcome := pg_catalog.jsonb_build_object('critical_info_card_id',v_new.id,'previous_card_id',v_old.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'critical_info_card_id',v_new.id,'previous_card_id',v_old.id);
end; $$;
revoke all on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_set_authority(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_representative_profile_id uuid, p_authority_type text, p_scope_categories text[],
  p_evidence_reference text, p_issuer text, p_effective_from timestamptz,
  p_effective_until timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_row public.representative_authorities%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_set_authority',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if p_effective_until is not null and p_effective_until <= p_effective_from then raise exception 'authority_dates_invalid'; end if;
  if nullif(pg_catalog.btrim(p_evidence_reference),'') is null then raise exception 'authority_evidence_required'; end if;
  if not exists(
    select 1 from public.organisation_memberships m
    where m.organisation_id=p_organisation_id and m.profile_id=p_representative_profile_id
      and public.membership_has_role(m.id,'nominee')
  ) then raise exception 'representative_membership_required'; end if;
  insert into public.representative_authorities(organisation_id,participant_id,representative_profile_id,authority_type,scope_categories,evidence_reference,issuer,issuer_profile_id,effective_from,effective_until)
  values(p_organisation_id,p_participant_id,p_representative_profile_id,pg_catalog.btrim(p_authority_type),p_scope_categories,pg_catalog.btrim(p_evidence_reference),nullif(pg_catalog.btrim(p_issuer),''),auth.uid(),p_effective_from,p_effective_until) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'representative_authority.created','representative_authority',v_row.id,pg_catalog.jsonb_build_object('participant_id',p_participant_id,'scope_categories',p_scope_categories,'effective_until',p_effective_until));
  v_outcome := pg_catalog.jsonb_build_object('authority_id',v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'authority_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_record_consent(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_recipient_profile_id uuid, p_authorising_profile_id uuid,
  p_purpose text, p_scope_categories text[], p_consent_basis text,
  p_representative_authority_id uuid, p_evidence_reference text,
  p_effective_from timestamptz, p_effective_until timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_row public.participant_consent_evidence%rowtype; v_authority public.representative_authorities%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_record_consent',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if p_effective_until <= p_effective_from or p_effective_until <= pg_catalog.now() then raise exception 'consent_dates_invalid'; end if;
  if p_consent_basis not in ('participant','authorised_representative') then raise exception 'consent_basis_invalid'; end if;
  if nullif(pg_catalog.btrim(p_purpose),'') is null or nullif(pg_catalog.btrim(p_evidence_reference),'') is null or cardinality(p_scope_categories) < 1 then raise exception 'consent_evidence_required'; end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if not exists(select 1 from public.organisation_memberships m where m.organisation_id=p_organisation_id and m.profile_id=p_recipient_profile_id and public.membership_has_role(m.id,'external')) then raise exception 'external_recipient_membership_required'; end if;
  if p_consent_basis = 'participant' then
    if p_representative_authority_id is not null or not exists(select 1 from public.organisation_memberships m where m.organisation_id=p_organisation_id and m.profile_id=p_authorising_profile_id and public.membership_has_role(m.id,'participant')) or not exists(select 1 from public.participant_self_links sl where sl.organisation_id=p_organisation_id and sl.participant_id=p_participant_id and sl.profile_id=p_authorising_profile_id and sl.status='active') then raise exception 'participant_consent_authority_required'; end if;
  else
    select * into v_authority from public.representative_authorities ra where ra.id=p_representative_authority_id and ra.organisation_id=p_organisation_id and ra.participant_id=p_participant_id and ra.representative_profile_id=p_authorising_profile_id and ra.status='active' and ra.effective_from <= pg_catalog.now() and (ra.effective_until is null or ra.effective_until > pg_catalog.now()) for update;
    if v_authority.id is null or not (p_scope_categories <@ v_authority.scope_categories) or p_effective_from < v_authority.effective_from or (v_authority.effective_until is not null and p_effective_until > v_authority.effective_until) then raise exception 'representative_consent_authority_required'; end if;
  end if;
  insert into public.participant_consent_evidence(organisation_id,participant_id,recipient_profile_id,authorising_profile_id,consent_basis,purpose,scope_categories,evidence_reference,effective_from,effective_until,representative_authority_id,authority_scope_snapshot,authority_effective_from,authority_effective_until,created_by)
  values(p_organisation_id,p_participant_id,p_recipient_profile_id,p_authorising_profile_id,p_consent_basis,pg_catalog.btrim(p_purpose),p_scope_categories,pg_catalog.btrim(p_evidence_reference),p_effective_from,p_effective_until,p_representative_authority_id,v_authority.scope_categories,v_authority.effective_from,v_authority.effective_until,auth.uid()) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'consent.created','participant_consent_evidence',v_row.id,pg_catalog.jsonb_build_object('participant_id',p_participant_id,'recipient_profile_id',p_recipient_profile_id,'consent_basis',p_consent_basis,'purpose',p_purpose,'scope_categories',p_scope_categories,'effective_until',p_effective_until));
  v_outcome := pg_catalog.jsonb_build_object('consent_id',v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'consent_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_record_consent(text,uuid,uuid,uuid,uuid,text,text[],text,uuid,text,timestamptz,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_record_consent(text,uuid,uuid,uuid,uuid,text,text[],text,uuid,text,timestamptz,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_record_consent(text,uuid,uuid,uuid,uuid,text,text[],text,uuid,text,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_create_grant(
  p_command_id text, p_organisation_id uuid, p_consent_id uuid,
  p_effective_from timestamptz, p_effective_until timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_row public.external_disclosure_grants%rowtype; v_consent public.participant_consent_evidence%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_create_grant',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  select * into v_consent from public.participant_consent_evidence where id=p_consent_id and organisation_id=p_organisation_id and status='active' and effective_from <= pg_catalog.now() and effective_until > pg_catalog.now() for update;
  if v_consent.id is null then raise exception 'consent_record_not_current'; end if;
  if p_effective_until <= p_effective_from or p_effective_from < v_consent.effective_from or p_effective_until > v_consent.effective_until then raise exception 'grant_dates_outside_consent'; end if;
  if not exists(select 1 from public.organisation_memberships m where m.organisation_id=p_organisation_id and m.profile_id=v_consent.recipient_profile_id and public.membership_has_role(m.id,'external')) then raise exception 'external_recipient_membership_required'; end if;
  if v_consent.consent_basis='participant' and not exists(select 1 from public.participant_self_links sl where sl.organisation_id=p_organisation_id and sl.participant_id=v_consent.participant_id and sl.profile_id=v_consent.authorising_profile_id and sl.status='active') then raise exception 'participant_consent_authority_required'; end if;
  if v_consent.consent_basis='authorised_representative' and not exists(select 1 from public.representative_authorities ra where ra.id=v_consent.representative_authority_id and ra.status='active' and ra.effective_from <= pg_catalog.now() and (ra.effective_until is null or ra.effective_until > pg_catalog.now())) then raise exception 'representative_consent_authority_required'; end if;
  insert into public.external_disclosure_grants(organisation_id,participant_id,recipient_profile_id,purpose,scope_categories,issuer,issuer_profile_id,consent_basis,consent_reference,evidence_reference,effective_from,effective_until,consent_record_id)
  values(p_organisation_id,v_consent.participant_id,v_consent.recipient_profile_id,v_consent.purpose,v_consent.scope_categories,'Provider admin',auth.uid(),v_consent.consent_basis,p_consent_id::text,v_consent.evidence_reference,p_effective_from,p_effective_until,p_consent_id) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'external_grant.created','external_grant',v_row.id,pg_catalog.jsonb_build_object('participant_id',v_consent.participant_id,'recipient_profile_id',v_consent.recipient_profile_id,'purpose',v_consent.purpose,'scope_categories',v_consent.scope_categories,'effective_until',p_effective_until,'consent_id',p_consent_id));
  v_outcome := pg_catalog.jsonb_build_object('grant_id',v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'grant_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_create_grant(text,uuid,uuid,timestamptz,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_create_grant(text,uuid,uuid,timestamptz,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_create_grant(text,uuid,uuid,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_revoke_grant(
  p_command_id text, p_organisation_id uuid, p_grant_id uuid, p_reason text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_row public.external_disclosure_grants%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_revoke_grant',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  select * into v_row from public.external_disclosure_grants where id=p_grant_id and organisation_id=p_organisation_id for update;
  if v_row.id is null then raise exception 'grant_not_found'; end if;
  update public.external_disclosure_grants set status='revoked',withdrawn_at=pg_catalog.now(),withdrawn_by=auth.uid(),withdrawn_reason=pg_catalog.btrim(p_reason) where id=p_grant_id;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'external_grant.revoked','external_grant',p_grant_id,pg_catalog.jsonb_build_object('reason',p_reason));
  v_outcome := pg_catalog.jsonb_build_object('grant_id',p_grant_id,'status','revoked');
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'grant_id',p_grant_id,'grant_status','revoked');
end; $$;
revoke all on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) from public;
revoke all on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) from anon;
grant execute on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.cmd_admin_set_availability(
  p_command_id text, p_organisation_id uuid, p_worker_membership uuid,
  p_available_from timestamptz, p_available_until timestamptz, p_note text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_row public.worker_availability%rowtype; v_reserved record; v_outcome jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_set_availability',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if p_available_until <= p_available_from then raise exception 'availability_dates_invalid'; end if;
  if not exists(select 1 from public.organisation_memberships m where m.id=p_worker_membership and m.organisation_id=p_organisation_id and public.membership_has_role(m.id,'worker')) then raise exception 'invalid_target_worker'; end if;
  insert into public.worker_availability(organisation_id,membership_id,available_during,note)
  values(p_organisation_id,p_worker_membership,pg_catalog.tstzrange(p_available_from,p_available_until,'[)'),nullif(pg_catalog.btrim(p_note),'')) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'worker_availability.created','worker_availability',v_row.id,pg_catalog.jsonb_build_object('membership_id',p_worker_membership,'from',p_available_from,'until',p_available_until));
  v_outcome := pg_catalog.jsonb_build_object('availability_id',v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'availability_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
revoke all on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) from anon;
grant execute on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

create or replace function public.cmd_admin_create_shift(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_worker_membership uuid, p_scheduled_start timestamptz, p_scheduled_end timestamptz,
  p_reason text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_membership uuid; v_shift public.shifts%rowtype; v_assignment public.shift_assignments%rowtype; v_reserved record; v_outcome jsonb; v_warnings jsonb := '[]'::jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_reserved from public.reserve_admin_command(p_command_id,'admin_create_shift',p_organisation_id,v_membership,p_payload);
  if not v_reserved.is_new then return pg_catalog.jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_reserved.receipt_id,'outcome',v_reserved.outcome); end if;
  if p_scheduled_end <= p_scheduled_start then raise exception 'shift_dates_invalid'; end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if not exists(select 1 from public.organisation_memberships m where m.id=p_worker_membership and m.organisation_id=p_organisation_id and public.membership_has_role(m.id,'worker')) then raise exception 'invalid_target_worker'; end if;
  if exists(select 1 from public.shift_assignments sa join public.shifts s on s.id=sa.shift_id where sa.membership_id=p_worker_membership and sa.withdrawn_at is null and (sa.effective_until is null or sa.effective_until > p_scheduled_start) and s.scheduled_start < p_scheduled_end and s.scheduled_end > p_scheduled_start and s.state not in ('cancelled','cancelled_needs_review')) then v_warnings := v_warnings || jsonb_build_array('worker_overlap'); end if;
  if not exists(select 1 from public.worker_availability wa where wa.membership_id=p_worker_membership and wa.available_during @> p_scheduled_start and wa.available_during @> (p_scheduled_end - interval '1 second')) then v_warnings := v_warnings || jsonb_build_array('outside_published_availability'); end if;
  insert into public.shifts(organisation_id,participant_id,scheduled_start,scheduled_end,state,version) values(p_organisation_id,p_participant_id,p_scheduled_start,p_scheduled_end,'scheduled',1) returning * into v_shift;
  insert into public.shift_assignments(shift_id,organisation_id,membership_id,effective_from,assigned_by,reassignment_reason) values(v_shift.id,p_organisation_id,p_worker_membership,pg_catalog.now(),auth.uid(),nullif(pg_catalog.btrim(p_reason),'')) returning * into v_assignment;
  perform public.record_shift_audit(p_organisation_id,v_shift.id,v_membership,'created','shift.created',pg_catalog.jsonb_build_object('assignment_id',v_assignment.id,'warnings',v_warnings,'reason',p_reason));
  v_outcome := pg_catalog.jsonb_build_object('shift_id',v_shift.id,'assignment_id',v_assignment.id,'warnings',v_warnings);
  perform public.finalize_admin_command(v_reserved.receipt_id,v_outcome);
  return pg_catalog.jsonb_build_object('status','accepted','receipt_id',v_reserved.receipt_id,'shift_id',v_shift.id,'assignment_id',v_assignment.id,'warnings',v_warnings);
end; $$;
revoke all on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
revoke all on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from anon;
grant execute on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

-- Admin/scheduler may read the append-only audit timeline for their tenant.
alter table public.audit_log enable row level security;
drop policy if exists audit_log_select_admin_scheduler on public.audit_log;
create policy audit_log_select_admin_scheduler on public.audit_log for select to authenticated
using (organisation_id = public.current_active_organisation_id() and public.current_user_membership_role() in ('admin','scheduler'));
