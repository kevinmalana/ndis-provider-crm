-- 0008_admin_workspace_rpcs.sql
--
-- Ticket 05: narrow, transactional commands for the synthetic-only admin
-- workspace.  No authenticated client is granted direct write access to the
-- domain tables; all sensitive changes below validate the active membership,
-- write the record, and append an audit entry in one transaction.

set search_path = public;

alter table public.command_receipts drop constraint if exists command_receipts_command_type_check;
alter table public.command_receipts add constraint command_receipts_command_type_check check (command_type in (
  'on_my_way','start_shift','end_shift','submit_summary','finalise_summary',
  'cancel_shift','reassign_shift','resolve_conflict','request_correction',
  'request_access','apply_correction','accept_invitation',
  'admin_invite','admin_create_participant','admin_set_authority',
  'admin_create_grant','admin_revoke_grant','admin_set_availability',
  'admin_create_shift','admin_update_critical_info','admin_link_self'
));

create or replace function public.admin_context(p_organisation_id uuid)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_membership uuid;
begin
  select m.id into v_membership
  from public.organisation_memberships m
  where m.organisation_id = p_organisation_id
    and m.profile_id = auth.uid()
    and m.role in ('admin','scheduler')
    and m.status = 'active'
    and m.effective_from <= now()
    and (m.effective_until is null or m.effective_until > now())
  limit 1;
  if v_membership is null then
    raise exception 'admin_or_scheduler_required' using errcode = '42501';
  end if;
  return v_membership;
end;
$$;
revoke all on function public.admin_context(uuid) from public;
grant execute on function public.admin_context(uuid) to authenticated;

create or replace function public.record_admin_command(
  p_command_id text,
  p_command_type text,
  p_organisation_id uuid,
  p_actor_membership uuid,
  p_payload jsonb,
  p_outcome jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_receipt public.command_receipts%rowtype;
begin
  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    actor_profile_id, claimed_at, completed_at, status, outcome, payload
  ) values (
    p_command_id, p_command_type, p_organisation_id, p_actor_membership,
    auth.uid(), now(), now(), 'accepted', coalesce(p_outcome, '{}'::jsonb),
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (organisation_id, actor_membership_id, command_type, command_id)
  do update set server_received_at = public.command_receipts.server_received_at
  returning * into v_receipt;
  if v_receipt.outcome is distinct from coalesce(p_outcome, '{}'::jsonb)
     and v_receipt.command_id = p_command_id then
    return jsonb_build_object('status','duplicate_returned','duplicate',true,'receipt_id',v_receipt.id,'outcome',v_receipt.outcome);
  end if;
  return jsonb_build_object('status','accepted','receipt_id',v_receipt.id,'outcome',p_outcome);
end;
$$;
revoke all on function public.record_admin_command(text,text,uuid,uuid,jsonb,jsonb) from public;

create or replace function public.cmd_admin_invite(
  p_command_id text, p_organisation_id uuid, p_email text, p_role text,
  p_expires_at timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_actor_role text; v_inv public.invitations%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select role into v_actor_role from public.organisation_memberships where id=v_membership;
  if p_role not in ('admin','scheduler','worker','participant','external','nominee') then raise exception 'invalid_invitation_role'; end if;
  if v_actor_role = 'scheduler' and p_role not in ('worker','participant','nominee') then raise exception 'scheduler_invite_role_not_allowed' using errcode = '42501'; end if;
  if p_expires_at <= now() then raise exception 'invitation_expiry_required'; end if;
  insert into public.invitations (organisation_id,email,role,token,expires_at,issued_by)
  values (p_organisation_id, lower(trim(p_email)), p_role, encode(gen_random_bytes(24),'hex'), p_expires_at, auth.uid())
  returning * into v_inv;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (p_organisation_id,auth.uid(),'invitation.issued','invitation',v_inv.id,jsonb_build_object('role',p_role,'expires_at',p_expires_at));
  v_receipt := public.record_admin_command(p_command_id,'admin_invite',p_organisation_id,v_membership,p_payload,jsonb_build_object('invitation_id',v_inv.id,'role',p_role));
  return v_receipt || jsonb_build_object('invitation_id',v_inv.id,'email',v_inv.email,'role',v_inv.role,'expires_at',v_inv.expires_at);
end; $$;
revoke all on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) from public;
grant execute on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_link_participant(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_profile_id uuid, p_evidence_reference text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_row public.participant_self_links%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if nullif(trim(p_evidence_reference),'') is null then raise exception 'self_link_evidence_required'; end if;
  if not exists(select 1 from public.global_profiles where id=p_profile_id) then raise exception 'profile_not_found'; end if;
  insert into public.participant_self_links(organisation_id,participant_id,profile_id,status,evidence_reference)
  values(p_organisation_id,p_participant_id,p_profile_id,'active',trim(p_evidence_reference)) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'participant_self_link.created','participant_self_link',v_row.id,jsonb_build_object('participant_id',p_participant_id,'profile_id',p_profile_id));
  v_receipt := public.record_admin_command(p_command_id,'admin_link_self',p_organisation_id,v_membership,p_payload,jsonb_build_object('self_link_id',v_row.id));
  return v_receipt || jsonb_build_object('self_link_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) from public;
grant execute on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.cmd_admin_create_participant(
  p_command_id text, p_organisation_id uuid, p_first_name text,
  p_last_initial text, p_critical_content text, p_review_due_at timestamptz,
  p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_participant public.participants%rowtype; v_card public.critical_info_cards%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if length(trim(p_first_name)) < 2 then raise exception 'participant_name_required'; end if;
  if p_review_due_at <= now() then raise exception 'review_due_must_be_future'; end if;
  insert into public.participants(organisation_id,first_name,last_initial,created_by)
  values(p_organisation_id,trim(p_first_name),nullif(upper(trim(p_last_initial)),''),auth.uid()) returning * into v_participant;
  insert into public.critical_info_cards(organisation_id,participant_id,content_text,owner_profile_id,reviewed_at,review_due_at)
  values(p_organisation_id,v_participant.id,trim(p_critical_content),auth.uid(),now(),p_review_due_at) returning * into v_card;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'participant.created','participant',v_participant.id,jsonb_build_object('critical_info_card_id',v_card.id,'review_due_at',p_review_due_at));
  v_receipt := public.record_admin_command(p_command_id,'admin_create_participant',p_organisation_id,v_membership,p_payload,jsonb_build_object('participant_id',v_participant.id,'critical_info_card_id',v_card.id));
  return v_receipt || jsonb_build_object('participant_id',v_participant.id,'critical_info_card_id',v_card.id);
end; $$;
revoke all on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) from public;
grant execute on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_update_critical_info(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_critical_content text, p_review_due_at timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_old public.critical_info_cards%rowtype; v_new public.critical_info_cards%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if p_review_due_at <= now() then raise exception 'review_due_must_be_future'; end if;
  select * into v_old from public.critical_info_cards where organisation_id=p_organisation_id and participant_id=p_participant_id and status='active' for update;
  if v_old.id is null then raise exception 'critical_info_not_found'; end if;
  insert into public.critical_info_cards(organisation_id,participant_id,version,content_text,owner_profile_id,reviewed_at,review_due_at,status)
  values(p_organisation_id,p_participant_id,v_old.version+1,trim(p_critical_content),auth.uid(),now(),p_review_due_at,'active') returning * into v_new;
  update public.critical_info_cards set status='superseded',superseded_by=v_new.id where id=v_old.id;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'critical_info.updated','participant',p_participant_id,jsonb_build_object('previous_card_id',v_old.id,'critical_info_card_id',v_new.id));
  v_receipt := public.record_admin_command(p_command_id,'admin_update_critical_info',p_organisation_id,v_membership,p_payload,jsonb_build_object('critical_info_card_id',v_new.id,'previous_card_id',v_old.id));
  return v_receipt || jsonb_build_object('critical_info_card_id',v_new.id,'previous_card_id',v_old.id);
end; $$;
revoke all on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) from public;
grant execute on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_set_authority(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_representative_profile_id uuid, p_authority_type text, p_scope_categories text[],
  p_evidence_reference text, p_issuer text, p_effective_from timestamptz,
  p_effective_until timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_row public.representative_authorities%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if p_effective_until is not null and p_effective_until <= p_effective_from then raise exception 'authority_dates_invalid'; end if;
  if nullif(trim(p_evidence_reference),'') is null then raise exception 'authority_evidence_required'; end if;
  insert into public.representative_authorities(organisation_id,participant_id,representative_profile_id,authority_type,scope_categories,evidence_reference,issuer,issuer_profile_id,effective_from,effective_until)
  values(p_organisation_id,p_participant_id,p_representative_profile_id,trim(p_authority_type),p_scope_categories,trim(p_evidence_reference),nullif(trim(p_issuer),''),auth.uid(),p_effective_from,p_effective_until) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'representative_authority.created','representative_authority',v_row.id,jsonb_build_object('participant_id',p_participant_id,'scope_categories',p_scope_categories,'effective_until',p_effective_until));
  v_receipt := public.record_admin_command(p_command_id,'admin_set_authority',p_organisation_id,v_membership,p_payload,jsonb_build_object('authority_id',v_row.id));
  return v_receipt || jsonb_build_object('authority_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) from public;
grant execute on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_create_grant(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_recipient_profile_id uuid, p_purpose text, p_scope_categories text[],
  p_consent_basis text, p_consent_reference text, p_evidence_reference text,
  p_effective_from timestamptz, p_effective_until timestamptz, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_row public.external_disclosure_grants%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if p_effective_until <= p_effective_from or p_effective_until <= now() then raise exception 'grant_dates_invalid'; end if;
  if p_consent_basis not in ('participant','authorised_representative') then raise exception 'grant_requires_consent_basis'; end if;
  if nullif(trim(p_evidence_reference),'') is null or nullif(trim(p_consent_reference),'') is null then raise exception 'grant_evidence_required'; end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  insert into public.external_disclosure_grants(organisation_id,participant_id,recipient_profile_id,purpose,scope_categories,issuer,issuer_profile_id,consent_basis,consent_reference,evidence_reference,effective_from,effective_until)
  values(p_organisation_id,p_participant_id,p_recipient_profile_id,trim(p_purpose),p_scope_categories,'Provider admin',auth.uid(),p_consent_basis,p_consent_reference,p_evidence_reference,p_effective_from,p_effective_until) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values(p_organisation_id,auth.uid(),'external_grant.created','external_grant',v_row.id,jsonb_build_object('participant_id',p_participant_id,'recipient_profile_id',p_recipient_profile_id,'purpose',p_purpose,'scope_categories',p_scope_categories,'effective_until',p_effective_until));
  v_receipt := public.record_admin_command(p_command_id,'admin_create_grant',p_organisation_id,v_membership,p_payload,jsonb_build_object('grant_id',v_row.id));
  return v_receipt || jsonb_build_object('grant_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_create_grant(text,uuid,uuid,uuid,text,text[],text,text,text,timestamptz,timestamptz,jsonb) from public;
grant execute on function public.cmd_admin_create_grant(text,uuid,uuid,uuid,text,text[],text,text,text,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_revoke_grant(
  p_command_id text, p_organisation_id uuid, p_grant_id uuid, p_reason text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_row public.external_disclosure_grants%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  select * into v_row from public.external_disclosure_grants where id=p_grant_id and organisation_id=p_organisation_id for update;
  if v_row.id is null then raise exception 'grant_not_found'; end if;
  update public.external_disclosure_grants set status='revoked',withdrawn_at=now(),withdrawn_by=auth.uid(),withdrawn_reason=trim(p_reason) where id=p_grant_id;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'external_grant.revoked','external_grant',p_grant_id,jsonb_build_object('reason',p_reason));
  v_receipt := public.record_admin_command(p_command_id,'admin_revoke_grant',p_organisation_id,v_membership,p_payload,jsonb_build_object('grant_id',p_grant_id,'reason',p_reason));
  return v_receipt || jsonb_build_object('grant_id',p_grant_id,'status','revoked');
end; $$;
revoke all on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) from public;
grant execute on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.cmd_admin_set_availability(
  p_command_id text, p_organisation_id uuid, p_worker_membership uuid,
  p_available_from timestamptz, p_available_until timestamptz, p_note text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_row public.worker_availability%rowtype; v_receipt jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if p_available_until <= p_available_from then raise exception 'availability_dates_invalid'; end if;
  if not exists(select 1 from public.organisation_memberships where id=p_worker_membership and organisation_id=p_organisation_id and role='worker' and status='active') then raise exception 'invalid_target_worker'; end if;
  insert into public.worker_availability(organisation_id,membership_id,available_during,note)
  values(p_organisation_id,p_worker_membership,tstzrange(p_available_from,p_available_until,'[)'),nullif(trim(p_note),'')) returning * into v_row;
  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata) values(p_organisation_id,auth.uid(),'worker_availability.created','worker_availability',v_row.id,jsonb_build_object('membership_id',p_worker_membership,'from',p_available_from,'until',p_available_until));
  v_receipt := public.record_admin_command(p_command_id,'admin_set_availability',p_organisation_id,v_membership,p_payload,jsonb_build_object('availability_id',v_row.id));
  return v_receipt || jsonb_build_object('availability_id',v_row.id);
end; $$;
revoke all on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
grant execute on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

create or replace function public.cmd_admin_create_shift(
  p_command_id text, p_organisation_id uuid, p_participant_id uuid,
  p_worker_membership uuid, p_scheduled_start timestamptz, p_scheduled_end timestamptz,
  p_reason text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_membership uuid; v_shift public.shifts%rowtype; v_assignment public.shift_assignments%rowtype; v_receipt jsonb; v_warnings jsonb := '[]'::jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  if p_scheduled_end <= p_scheduled_start then raise exception 'shift_dates_invalid'; end if;
  if not exists(select 1 from public.participants where id=p_participant_id and organisation_id=p_organisation_id and archived_at is null) then raise exception 'participant_not_found'; end if;
  if not exists(select 1 from public.organisation_memberships where id=p_worker_membership and organisation_id=p_organisation_id and role='worker' and status='active') then raise exception 'invalid_target_worker'; end if;
  if exists(select 1 from public.shift_assignments sa join public.shifts s on s.id=sa.shift_id where sa.membership_id=p_worker_membership and sa.withdrawn_at is null and (sa.effective_until is null or sa.effective_until > p_scheduled_start) and s.scheduled_start < p_scheduled_end and s.scheduled_end > p_scheduled_start and s.state not in ('cancelled','cancelled_needs_review')) then v_warnings := v_warnings || jsonb_build_array('worker_overlap'); end if;
  if not exists(select 1 from public.worker_availability wa where wa.membership_id=p_worker_membership and wa.available_during @> p_scheduled_start and wa.available_during @> (p_scheduled_end - interval '1 second')) then v_warnings := v_warnings || jsonb_build_array('outside_published_availability'); end if;
  insert into public.shifts(organisation_id,participant_id,scheduled_start,scheduled_end,state,version) values(p_organisation_id,p_participant_id,p_scheduled_start,p_scheduled_end,'scheduled',1) returning * into v_shift;
  insert into public.shift_assignments(shift_id,organisation_id,membership_id,effective_from,assigned_by,reassignment_reason) values(v_shift.id,p_organisation_id,p_worker_membership,now(),auth.uid(),nullif(trim(p_reason),'')) returning * into v_assignment;
  perform public.record_shift_audit(p_organisation_id,v_shift.id,v_membership,'reassigned','shift.created',jsonb_build_object('assignment_id',v_assignment.id,'warnings',v_warnings,'reason',p_reason));
  v_receipt := public.record_admin_command(p_command_id,'admin_create_shift',p_organisation_id,v_membership,p_payload,jsonb_build_object('shift_id',v_shift.id,'assignment_id',v_assignment.id,'warnings',v_warnings));
  return v_receipt || jsonb_build_object('shift_id',v_shift.id,'assignment_id',v_assignment.id,'warnings',v_warnings);
end; $$;
revoke all on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
grant execute on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

-- Admin/scheduler may read the append-only audit timeline for their tenant.
alter table public.audit_log enable row level security;
drop policy if exists audit_log_select_admin_scheduler on public.audit_log;
create policy audit_log_select_admin_scheduler on public.audit_log for select to authenticated
using (organisation_id = public.current_active_organisation_id() and public.current_user_membership_role() in ('admin','scheduler'));
