-- 0007_synthetic_seed_rpc.sql
--
-- A single service-only transaction for the deterministic development seed.
-- The caller supplies an already-created dedicated `.synthetic` worker
-- membership; this function never selects an arbitrary real worker and never
-- creates auth identities. Any exception aborts the complete transaction.

set search_path = public;

create or replace function public.seed_synthetic_demo(
  p_worker_membership_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.organisation_memberships;
  v_worker_email text;
  v_participant_id uuid;
  v_shift_id uuid;
  v_assignment_id uuid;
  v_card_id uuid;
  v_availability_id uuid;
  v_authority_id uuid;
  v_grant_id uuid;
  v_names text[] := array['Test Alpha', 'Test Beta', 'Test Gamma'];
  v_initials text[] := array['S', 'S', 'S'];
  v_count integer := 0;
  i integer;
begin
  if coalesce(auth.role(), 'anon') <> 'service_role' then
    raise exception 'synthetic_seed_service_role_required' using errcode = '42501';
  end if;

  select m.* into v_membership
  from public.organisation_memberships m
  join public.organisations o on o.id = m.organisation_id
  where m.id = p_worker_membership_id
    and m.role = 'worker'
    and m.status = 'active'
    and m.effective_from <= now()
    and (m.effective_until is null or m.effective_until > now())
    and o.deleted_at is null
  for update;

  if v_membership.id is null then
    raise exception 'synthetic_seed_worker_membership_invalid' using errcode = '22023';
  end if;

  select gp.email into v_worker_email
  from public.global_profiles gp
  where gp.id = v_membership.profile_id
    and gp.deleted_at is null;

  if v_worker_email is null or v_worker_email not like '%.synthetic' then
    raise exception 'synthetic_seed_requires_dedicated_identity' using errcode = '22023';
  end if;

  for i in 1..array_length(v_names, 1) loop
    v_participant_id := md5('ndis.synthetic.participant:' || v_membership.organisation_id::text || ':' || i::text)::uuid;
    v_shift_id := md5('ndis.synthetic.shift:' || v_membership.organisation_id::text || ':' || i::text)::uuid;
    v_assignment_id := md5('ndis.synthetic.assignment:' || v_membership.organisation_id::text || ':' || i::text)::uuid;
    v_card_id := md5('ndis.synthetic.card:' || v_membership.organisation_id::text || ':' || i::text)::uuid;
    v_authority_id := md5('ndis.synthetic.authority:' || v_membership.organisation_id::text || ':' || i::text)::uuid;
    v_grant_id := md5('ndis.synthetic.grant:' || v_membership.organisation_id::text || ':' || i::text)::uuid;

    insert into public.participants (id, organisation_id, first_name, last_initial, created_by)
    values (v_participant_id, v_membership.organisation_id, v_names[i], v_initials[i], v_membership.profile_id)
    on conflict (id) do update set first_name = excluded.first_name,
      last_initial = excluded.last_initial, archived_at = null, updated_at = now();

    insert into public.shifts (
      id, organisation_id, participant_id, scheduled_start, scheduled_end, state, version
    ) values (
      v_shift_id, v_membership.organisation_id, v_participant_id,
      date_trunc('day', now()) + interval '1 day' + interval '9 hours',
      date_trunc('day', now()) + interval '1 day' + interval '10 hours',
      'scheduled', 1
    )
    on conflict (id) do update set scheduled_start = excluded.scheduled_start,
      scheduled_end = excluded.scheduled_end, state = 'scheduled', version = 1,
      cancellation_reason = null, cancelled_at = null, cancelled_by = null,
      updated_at = now();

    insert into public.shift_assignments (
      id, shift_id, organisation_id, membership_id, assigned_by,
      effective_from, effective_until, withdrawn_at, superseded_by
    ) values (
      v_assignment_id, v_shift_id, v_membership.organisation_id,
      v_membership.id, v_membership.profile_id, now(), null, null, null
    ) on conflict (id) do update set effective_from = excluded.effective_from,
      effective_until = null, withdrawn_at = null, superseded_by = null,
      updated_at = now();

    insert into public.critical_info_cards (
      id, organisation_id, participant_id, content_text, owner_profile_id,
      reviewed_at, review_due_at, status
    ) values (
      v_card_id, v_membership.organisation_id, v_participant_id,
      'Synthetic card: no real information.', v_membership.profile_id,
      now(), date_trunc('day', now()) + interval '30 days' + interval '9 hours', 'active'
    ) on conflict (id) do update set content_text = excluded.content_text,
      review_due_at = excluded.review_due_at, status = 'active', updated_at = now();

    v_availability_id := md5('ndis.synthetic.availability:' || v_membership.organisation_id::text)::uuid;
    insert into public.worker_availability (
      id, organisation_id, membership_id, available_during, note
    ) values (
      v_availability_id, v_membership.organisation_id, v_membership.id,
      tstzrange(date_trunc('day', now()), date_trunc('day', now()) + interval '14 days', '[)'),
      'Synthetic availability window.'
    ) on conflict (id) do update set available_during = excluded.available_during,
      note = excluded.note, updated_at = now();

    insert into public.representative_authorities (
      id, organisation_id, participant_id, representative_profile_id,
      authority_type, scope_categories, effective_from, evidence_reference
    ) values (
      v_authority_id, v_membership.organisation_id, v_participant_id,
      v_membership.profile_id, 'plan_nominee', array['upcoming_visits','service_summary'],
      now(), 'synthetic-no-evidence'
    ) on conflict (id) do update set status = 'active', effective_until = null,
      scope_categories = excluded.scope_categories, updated_at = now();

    insert into public.external_disclosure_grants (
      id, organisation_id, participant_id, recipient_profile_id, purpose,
      scope_categories, consent_basis, consent_reference, effective_from, effective_until
    ) values (
      v_grant_id, v_membership.organisation_id, v_participant_id,
      v_membership.profile_id, 'support_coordination_review', array['service_summary'],
      'provider_internal_use', 'synthetic-no-consent', now(), now() + interval '30 days'
    ) on conflict (id) do update set status = 'active', effective_until = now() + interval '30 days',
      updated_at = now();

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'status', 'seeded',
    'organisation_id', v_membership.organisation_id,
    'worker_membership_id', v_membership.id,
    'participants', v_count,
    'deterministic', true,
    'transactional', true
  );
end;
$$;

revoke all on function public.seed_synthetic_demo(uuid) from public;
grant execute on function public.seed_synthetic_demo(uuid) to service_role;
