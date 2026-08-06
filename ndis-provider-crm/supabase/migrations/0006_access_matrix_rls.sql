-- 0006_access_matrix_rls.sql
--
-- Row-level security for the v1 domain tables added by 0004.
--
-- Per decision-log/2026-08-06 ("Separate participant, representative,
-- internal, and external access authority"):
--
--   * Provider workforce    → derived from active membership in the row's
--                             organisation PLUS shift assignment (for
--                             shifts) or admin/scheduler override.
--   * Participant self-link → reads the participant record via the
--                             participant_self_links row; does NOT need a
--                             workforce membership.
--   * Representative        → reads via current, unexpired, unwithdrawn
--                             representative_authorities row whose scope
--                             covers the record category.
--   * External grant        → reads via current, unexpired, unwithdrawn
--                             external_disclosure_grants row whose scope
--                             covers the record category.
--
-- RLS never trusts the active_organisation_context cookie/header by
-- itself for authorisation; it always re-evaluates the user's membership
-- and relevant assignment/self-link/authority/grant.
--
-- Sensitive state transitions bypass RLS via SECURITY DEFINER RPCs
-- (0005). RLS applies to ordinary reads only.

set search_path = public;

------------------------------------------------------------------------
-- helpers consumed by RLS
------------------------------------------------------------------------

-- Currently-signed-in user has an active self-link for the participant.
create or replace function public.current_user_self_links_participant_id()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select psl.participant_id
  from public.participant_self_links psl
  where psl.profile_id = auth.uid()
    and psl.status = 'active'
$$;

revoke all on function public.current_user_self_links_participant_id() from public;
grant execute on function public.current_user_self_links_participant_id() to authenticated;

-- Currently-signed-in user has an active representative authority for the
-- participant whose categories list `p_category`. Returns the participant_id.
create or replace function public.current_user_represents_participant(
  p_category text
)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select ra.participant_id
  from public.representative_authorities ra
  where ra.representative_profile_id = auth.uid()
    and ra.status = 'active'
    and ra.effective_from <= now()
    and (ra.effective_until is null or ra.effective_until > now())
    and p_category = any (ra.scope_categories)
$$;

revoke all on function public.current_user_represents_participant(text) from public;
grant execute on function public.current_user_represents_participant(text) to authenticated;

-- Currently-signed-in user has ANY active, in-window representative
-- authority for the participant (regardless of scope_categories).
-- Used for the participants identity read — a representative may know
-- who their principal is. Category-scoped record reads use the
-- parameterised variant above.
create or replace function public.current_user_represents_any_participant()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select ra.participant_id
  from public.representative_authorities ra
  where ra.representative_profile_id = auth.uid()
    and ra.status = 'active'
    and ra.effective_from <= now()
    and (ra.effective_until is null or ra.effective_until > now())
$$;

revoke all on function public.current_user_represents_any_participant() from public;
grant execute on function public.current_user_represents_any_participant() to authenticated;

-- Currently-signed-in user has an active external grant covering this
-- participant and the named category.
create or replace function public.current_user_external_grants_participant(
  p_category text
)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select g.participant_id
  from public.external_disclosure_grants g
  where g.recipient_profile_id = auth.uid()
    and g.status = 'active'
    and g.effective_from <= now()
    and g.effective_until > now()
    and p_category = any (g.scope_categories)
$$;

revoke all on function public.current_user_external_grants_participant(text) from public;
grant execute on function public.current_user_external_grants_participant(text) to authenticated;

------------------------------------------------------------------------
-- participants
------------------------------------------------------------------------
alter table public.participants enable row level security;

drop policy if exists participants_admin_scheduler_all on public.participants;
create policy participants_admin_scheduler_all
  on public.participants for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists participants_worker_assigned on public.participants;
create policy participants_worker_assigned
  on public.participants for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and exists (
      select 1
      from public.shift_assignments sa
      join public.organisation_memberships m on m.id = sa.membership_id
      where sa.withdrawn_at is null
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and sa.shift_id in (
          select s.id from public.shifts s where s.participant_id = public.participants.id
        )
    )
  );

drop policy if exists participants_self_link on public.participants;
create policy participants_self_link
  on public.participants for select to authenticated
  using (
    id in (select public.current_user_self_links_participant_id())
  );

drop policy if exists participants_representative on public.participants;
create policy participants_representative
  on public.participants for select to authenticated
  using (
    id in (select public.current_user_represents_any_participant())
  );

drop policy if exists participants_external on public.participants;
create policy participants_external
  on public.participants for select to authenticated
  using (
    id in (select public.current_user_external_grants_participant('participants'))
  );

-- INSERT/UPDATE/DELETE on participants is intentionally restricted.
-- Mutations go through trusted server code paths in later tickets.
-- For 0006 we leave the table locked down for non-service-role principals.

------------------------------------------------------------------------
-- participant_self_links
------------------------------------------------------------------------
alter table public.participant_self_links enable row level security;

drop policy if exists participant_self_links_select_self on public.participant_self_links;
create policy participant_self_links_select_self
  on public.participant_self_links for select to authenticated
  using (profile_id = auth.uid());

drop policy if exists participant_self_links_select_admin on public.participant_self_links;
create policy participant_self_links_select_admin
  on public.participant_self_links for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() = 'admin'
  );

------------------------------------------------------------------------
-- representative_authorities
------------------------------------------------------------------------
alter table public.representative_authorities enable row level security;

drop policy if exists representative_authorities_select_representative on public.representative_authorities;
create policy representative_authorities_select_representative
  on public.representative_authorities for select to authenticated
  using (
    representative_profile_id = auth.uid()
    and status = 'active'
  );

drop policy if exists representative_authorities_select_participant_self on public.representative_authorities;
create policy representative_authorities_select_participant_self
  on public.representative_authorities for select to authenticated
  using (
    participant_id in (select public.current_user_self_links_participant_id())
    and status = 'active'
  );

drop policy if exists representative_authorities_select_org_admin on public.representative_authorities;
create policy representative_authorities_select_org_admin
  on public.representative_authorities for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

------------------------------------------------------------------------
-- external_disclosure_grants
------------------------------------------------------------------------
alter table public.external_disclosure_grants enable row level security;

drop policy if exists external_grants_select_recipient on public.external_disclosure_grants;
create policy external_grants_select_recipient
  on public.external_disclosure_grants for select to authenticated
  using (
    recipient_profile_id = auth.uid()
    and status = 'active'
    and effective_until > now()
  );

drop policy if exists external_grants_select_participant_self on public.external_disclosure_grants;
create policy external_grants_select_participant_self
  on public.external_disclosure_grants for select to authenticated
  using (
    participant_id in (select public.current_user_self_links_participant_id())
    and status = 'active'
  );

drop policy if exists external_grants_select_org_admin on public.external_disclosure_grants;
create policy external_grants_select_org_admin
  on public.external_disclosure_grants for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

------------------------------------------------------------------------
-- shifts (read-only for assigned workers; admin/scheduler see all in org)
------------------------------------------------------------------------
alter table public.shifts enable row level security;

drop policy if exists shifts_select_admin_scheduler on public.shifts;
create policy shifts_select_admin_scheduler
  on public.shifts for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists shifts_select_assigned_worker on public.shifts;
create policy shifts_select_assigned_worker
  on public.shifts for select to authenticated
  using (
    exists (
      select 1
      from public.shift_assignments sa
      join public.organisation_memberships m on m.id = sa.membership_id
      where sa.shift_id = public.shifts.id
        and sa.withdrawn_at is null
        and m.profile_id = auth.uid()
        and m.status = 'active'
    )
  );

drop policy if exists shifts_select_participant_self on public.shifts;
create policy shifts_select_participant_self
  on public.shifts for select to authenticated
  using (
    participant_id in (select public.current_user_self_links_participant_id())
    and state in (
      'scheduled','in_transit','started','ended_summary_required',
      'finalised','corrected','cancelled'
    )
  );

drop policy if exists shifts_select_representative on public.shifts;
create policy shifts_select_representative
  on public.shifts for select to authenticated
  using (
    participant_id in (
      select public.current_user_represents_participant('upcoming_visits')
      union
      select public.current_user_represents_participant('service_summary')
    )
    and state in (
      'scheduled','in_transit','started','ended_summary_required',
      'finalised','corrected','cancelled'
    )
  );

drop policy if exists shifts_select_external on public.shifts;
create policy shifts_select_external
  on public.shifts for select to authenticated
  using (
    participant_id in (
      select public.current_user_external_grants_participant('upcoming_visits')
      union
      select public.current_user_external_grants_participant('service_summary')
    )
    and state in ('finalised','corrected','cancelled')
  );

------------------------------------------------------------------------
-- shift_assignments
------------------------------------------------------------------------
alter table public.shift_assignments enable row level security;

drop policy if exists shift_assignments_select_admin_scheduler on public.shift_assignments;
create policy shift_assignments_select_admin_scheduler
  on public.shift_assignments for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists shift_assignments_select_worker_self on public.shift_assignments;
create policy shift_assignments_select_worker_self
  on public.shift_assignments for select to authenticated
  using (
    exists (
      select 1 from public.organisation_memberships m
      where m.id = public.shift_assignments.membership_id
        and m.profile_id = auth.uid()
    )
  );

------------------------------------------------------------------------
-- shift_events — read allowed for people allowed to read the shift
------------------------------------------------------------------------

drop policy if exists shift_events_select_admin_scheduler on public.shift_events;
create policy shift_events_select_admin_scheduler
  on public.shift_events for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists shift_events_select_worker_self on public.shift_events;
create policy shift_events_select_worker_self
  on public.shift_events for select to authenticated
  using (
    exists (
      select 1
      from public.organisation_memberships m
      join public.shift_assignments sa
        on sa.membership_id = m.id and sa.withdrawn_at is null
      where m.profile_id = auth.uid()
        and m.status = 'active'
        and sa.shift_id = public.shift_events.shift_id
    )
  );

drop policy if exists shift_events_select_participant_self on public.shift_events;
create policy shift_events_select_participant_self
  on public.shift_events for select to authenticated
  using (
    shift_id in (
      select s.id from public.shifts s
      where s.participant_id in (select public.current_user_self_links_participant_id())
    )
    and event_type in ('start','end','summary_submitted','summary_finalised','corrected','reassigned')
  );

------------------------------------------------------------------------
-- critical_info_cards — workforce reads the current version
------------------------------------------------------------------------
alter table public.critical_info_cards enable row level security;

drop policy if exists critical_info_cards_select_admin_scheduler on public.critical_info_cards;
create policy critical_info_cards_select_admin_scheduler
  on public.critical_info_cards for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists critical_info_cards_select_worker_assigned on public.critical_info_cards;
create policy critical_info_cards_select_worker_assigned
  on public.critical_info_cards for select to authenticated
  using (
    status = 'active'
    and exists (
      select 1
      from public.shifts s
      join public.shift_assignments sa on sa.shift_id = s.id and sa.withdrawn_at is null
      join public.organisation_memberships m on m.id = sa.membership_id
      where m.profile_id = auth.uid()
        and m.status = 'active'
        and s.participant_id = public.critical_info_cards.participant_id
    )
  );

drop policy if exists critical_info_cards_select_participant_self on public.critical_info_cards;
create policy critical_info_cards_select_participant_self
  on public.critical_info_cards for select to authenticated
  using (
    participant_id in (select public.current_user_self_links_participant_id())
    and status = 'active'
  );

------------------------------------------------------------------------
-- service_summaries — workforce current version; participant current; external grant-scoped
------------------------------------------------------------------------
alter table public.service_summaries enable row level security;

drop policy if exists service_summaries_select_admin_scheduler on public.service_summaries;
create policy service_summaries_select_admin_scheduler
  on public.service_summaries for select to authenticated
  using (
    exists (
      select 1 from public.shifts s
      where s.id = public.service_summaries.shift_id
        and s.organisation_id = public.current_active_organisation_id()
        and public.current_user_membership_role() in ('admin','scheduler')
    )
  );

drop policy if exists service_summaries_select_worker_assigned on public.service_summaries;
create policy service_summaries_select_worker_assigned
  on public.service_summaries for select to authenticated
  using (
    exists (
      select 1
      from public.shifts s
      join public.shift_assignments sa on sa.shift_id = s.id and sa.withdrawn_at is null
      join public.organisation_memberships m on m.id = sa.membership_id
      where s.id = public.service_summaries.shift_id
        and m.profile_id = auth.uid()
        and m.status = 'active'
    )
  );

drop policy if exists service_summaries_select_participant_self on public.service_summaries;
create policy service_summaries_select_participant_self
  on public.service_summaries for select to authenticated
  using (
    exists (
      select 1 from public.shifts s
      where s.id = public.service_summaries.shift_id
        and s.participant_id in (select public.current_user_self_links_participant_id())
    )
  );

drop policy if exists service_summaries_select_representative on public.service_summaries;
create policy service_summaries_select_representative
  on public.service_summaries for select to authenticated
  using (
    exists (
      select 1 from public.shifts s
      where s.id = public.service_summaries.shift_id
        and s.participant_id in (
          select public.current_user_represents_participant('service_summary')
        )
    )
  );

drop policy if exists service_summaries_select_external on public.service_summaries;
create policy service_summaries_select_external
  on public.service_summaries for select to authenticated
  using (
    exists (
      select 1 from public.shifts s
      where s.id = public.service_summaries.shift_id
        and s.participant_id in (
          select public.current_user_external_grants_participant('service_summary')
        )
        and s.state in ('finalised','corrected')
    )
  );

------------------------------------------------------------------------
-- service_summary_versions (immutable history)
------------------------------------------------------------------------
alter table public.service_summary_versions enable row level security;

drop policy if exists service_summary_versions_select_admin_scheduler on public.service_summary_versions;
create policy service_summary_versions_select_admin_scheduler
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1 from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      where ss.id = public.service_summary_versions.summary_id
        and s.organisation_id = public.current_active_organisation_id()
        and public.current_user_membership_role() in ('admin','scheduler')
    )
  );

drop policy if exists service_summary_versions_select_participant_self on public.service_summary_versions;
create policy service_summary_versions_select_participant_self
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1 from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      where ss.id = public.service_summary_versions.summary_id
        and s.participant_id in (select public.current_user_self_links_participant_id())
        and (public.service_summary_versions.version_number = (
          select max(version_number) from public.service_summary_versions v2 where v2.summary_id = public.service_summary_versions.summary_id
        ))
    )
  );

drop policy if exists service_summary_versions_select_external on public.service_summary_versions;
create policy service_summary_versions_select_external
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1 from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      where ss.id = public.service_summary_versions.summary_id
        and s.participant_id in (
          select public.current_user_external_grants_participant('service_summary')
        )
        and s.state in ('finalised','corrected')
    )
  );

------------------------------------------------------------------------
-- command_receipts — only the actor sees their own receipts; admin in
-- the same org see all.
------------------------------------------------------------------------
alter table public.command_receipts enable row level security;

drop policy if exists command_receipts_select_actor on public.command_receipts;
create policy command_receipts_select_actor
  on public.command_receipts for select to authenticated
  using (
    exists (
      select 1
      from public.organisation_memberships m
      where m.id = public.command_receipts.actor_membership_id
        and m.profile_id = auth.uid()
    )
  );

drop policy if exists command_receipts_select_admin_scheduler on public.command_receipts;
create policy command_receipts_select_admin_scheduler
  on public.command_receipts for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

------------------------------------------------------------------------
-- evidence_review_queue — supervisor-only via membership role
------------------------------------------------------------------------
alter table public.evidence_review_queue enable row level security;

drop policy if exists evidence_review_queue_select_admin_scheduler on public.evidence_review_queue;
create policy evidence_review_queue_select_admin_scheduler
  on public.evidence_review_queue for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists evidence_review_queue_select_actor on public.evidence_review_queue;
create policy evidence_review_queue_select_actor
  on public.evidence_review_queue for select to authenticated
  using (
    exists (
      select 1
      from public.command_receipts r
      join public.organisation_memberships m on m.id = r.actor_membership_id
      where r.id = public.evidence_review_queue.receipt_id
        and m.profile_id = auth.uid()
    )
  );

------------------------------------------------------------------------
-- correction_requests — requester self + admin/scheduler
------------------------------------------------------------------------
alter table public.correction_requests enable row level security;

drop policy if exists correction_requests_select_requester on public.correction_requests;
create policy correction_requests_select_requester
  on public.correction_requests for select to authenticated
  using (requested_by = auth.uid());

drop policy if exists correction_requests_select_admin_scheduler on public.correction_requests;
create policy correction_requests_select_admin_scheduler
  on public.correction_requests for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists correction_requests_insert_requester on public.correction_requests;
create policy correction_requests_insert_requester
  on public.correction_requests for insert to authenticated
  with check (
    requested_by = auth.uid()
    and (
      organisation_id = public.current_active_organisation_id()
      or exists (
        select 1 from public.participant_self_links psl
        where psl.profile_id = auth.uid()
          and psl.participant_id = (
            select s.participant_id from public.shifts s where s.id = shift_id
          )
      )
    )
  );

------------------------------------------------------------------------
-- access_requests — requester self + admin/scheduler
------------------------------------------------------------------------
alter table public.access_requests enable row level security;

drop policy if exists access_requests_select_requester on public.access_requests;
create policy access_requests_select_requester
  on public.access_requests for select to authenticated
  using (requester = auth.uid());

drop policy if exists access_requests_select_admin_scheduler on public.access_requests;
create policy access_requests_select_admin_scheduler
  on public.access_requests for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

drop policy if exists access_requests_insert_requester on public.access_requests;
create policy access_requests_insert_requester
  on public.access_requests for insert to authenticated
  with check (requester = auth.uid());

------------------------------------------------------------------------
-- worker_availability — worker self + admin/scheduler
------------------------------------------------------------------------
alter table public.worker_availability enable row level security;

drop policy if exists worker_availability_select_worker on public.worker_availability;
create policy worker_availability_select_worker
  on public.worker_availability for select to authenticated
  using (
    exists (
      select 1 from public.organisation_memberships m
      where m.id = public.worker_availability.membership_id
        and m.profile_id = auth.uid()
    )
  );

drop policy if exists worker_availability_select_admin_scheduler on public.worker_availability;
create policy worker_availability_select_admin_scheduler
  on public.worker_availability for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );
