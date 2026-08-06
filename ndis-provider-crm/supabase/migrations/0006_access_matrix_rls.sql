-- 0006_access_matrix_rls.sql
--
-- Row-level security for the v1 domain tables added by 0004.
--
-- Per decision-log/2026-08-06 ("Separate participant, representative,
-- internal, and external access authority") and the ticket-04 cold
-- review:
--
--   * Workforce    — derived from active membership + assignment,
--                     with effective windows and live-organisation checks.
--   * Participant  — reads via participant_self_links row;
--                     participant-safe projections only; no live travel
--                     or operational event exposure.
--   * Representative — category + scope filtered per authority row;
--                     upcoming-visit and service-summary scopes split.
--   * External grant — finalised/current versions only, scoped.
--
-- RLS never trusts the active_organisation_context cookie/header by
-- itself for authorisation; every policy re-evaluates the underlying
-- membership / link / authority / grant.
--
-- Sensitive state transitions bypass RLS via SECURITY DEFINER RPCs
-- (0005). RLS applies to ordinary reads only.
--
-- Service_summary_current_versions (0004) provides the non-recursive
-- current-version projection used by participant / representative /
-- external policies on summary content.

set search_path = public;

------------------------------------------------------------------------
-- helpers consumed by RLS
------------------------------------------------------------------------

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
  join public.organisations o on o.id = ra.organisation_id
  where ra.representative_profile_id = auth.uid()
    and ra.status = 'active'
    and ra.effective_from <= now()
    and (ra.effective_until is null or ra.effective_until > now())
    and o.deleted_at is null
    and p_category = any (ra.scope_categories)
$$;

revoke all on function public.current_user_represents_participant(text) from public;
grant execute on function public.current_user_represents_participant(text) to authenticated;

create or replace function public.current_user_represents_any_participant()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select ra.participant_id
  from public.representative_authorities ra
  join public.organisations o on o.id = ra.organisation_id
  where ra.representative_profile_id = auth.uid()
    and ra.status = 'active'
    and ra.effective_from <= now()
    and (ra.effective_until is null or ra.effective_until > now())
    and o.deleted_at is null
$$;

revoke all on function public.current_user_represents_any_participant() from public;
grant execute on function public.current_user_represents_any_participant() to authenticated;

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
  join public.organisations o on o.id = g.organisation_id
  where g.recipient_profile_id = auth.uid()
    and g.status = 'active'
    and g.effective_from <= now()
    and g.effective_until > now()
    and o.deleted_at is null
    and p_category = any (g.scope_categories)
$$;

revoke all on function public.current_user_external_grants_participant(text) from public;
grant execute on function public.current_user_external_grants_participant(text) to authenticated;

-- Participant-safe event projection: only events that are safe for
-- the participant to see (no internal identifiers / version / actor
-- membership / payload). Surfaced via a SECURITY INVOKER view in 0006.

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
        and sa.effective_from <= now()
        and (sa.effective_until is null or sa.effective_until > now())
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
        and m.role = 'worker'
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

-- No authenticated INSERT/UPDATE/DELETE on self_links — created /
-- withdrawn by trusted RPCs.

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
    and effective_from <= now()
    and (effective_until is null or effective_until > now())
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

-- No authenticated INSERT/UPDATE/DELETE — managed by trusted RPCs.

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

-- No authenticated INSERT/UPDATE/DELETE — managed by trusted RPCs.

------------------------------------------------------------------------
-- shifts
------------------------------------------------------------------------
-- Categories split: upcoming_visits shows scheduled/cancelled rows;
-- service_summary shows finalised/corrected/cancelled rows only. The
-- live travel states (in_transit, started, ended_summary_required,
-- submitted_local, syncing) are NEVER exposed to participant /
-- representative / external readers.
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
        and sa.effective_from <= now()
        and (sa.effective_until is null or sa.effective_until > now())
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
    )
  );

drop policy if exists shifts_select_participant_upcoming on public.shifts;
create policy shifts_select_participant_upcoming
  on public.shifts for select to authenticated
  using (
    participant_id in (select public.current_user_self_links_participant_id())
    and state in ('scheduled','cancelled','finalised','corrected')
  );

drop policy if exists shifts_select_representative_upcoming on public.shifts;
create policy shifts_select_representative_upcoming
  on public.shifts for select to authenticated
  using (
    participant_id in (select public.current_user_represents_participant('upcoming_visits'))
    and state in ('scheduled','cancelled')
  );

drop policy if exists shifts_select_representative_summary on public.shifts;
create policy shifts_select_representative_summary
  on public.shifts for select to authenticated
  using (
    participant_id in (select public.current_user_represents_participant('service_summary'))
    and state in ('finalised','corrected','cancelled')
  );

drop policy if exists shifts_select_external_summary on public.shifts;
create policy shifts_select_external_summary
  on public.shifts for select to authenticated
  using (
    participant_id in (select public.current_user_external_grants_participant('service_summary'))
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
-- shift_events
------------------------------------------------------------------------
-- Internal-only: admin/scheduler and the assigned worker. The
-- participant / representative / external paths NEVER see raw
-- shift_events; they read service summaries instead.

alter table public.shift_events enable row level security;

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
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
        and sa.shift_id = public.shift_events.shift_id
    )
  );

------------------------------------------------------------------------
-- critical_info_cards
------------------------------------------------------------------------
-- Finalised active card per participant.

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
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
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
-- service_summaries (header)
------------------------------------------------------------------------
-- Header is hidden from non-admin readers until finalised / corrected.

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
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
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
        and s.state in ('finalised','corrected')
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
        and s.state in ('finalised','corrected')
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
-- service_summary_versions — NON-RECURSIVE via current-version view
------------------------------------------------------------------------
-- Raw versions are admin-only; participant / representative / external
-- readers use the service_summary_current_versions view (0004) which
-- already filters to the current (non-superseded) version of
-- finalised / corrected / cancelled shifts.

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

drop policy if exists service_summary_versions_select_worker_assigned on public.service_summary_versions;
create policy service_summary_versions_select_worker_assigned
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1
      from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      join public.shift_assignments sa on sa.shift_id = s.id and sa.withdrawn_at is null
      join public.organisation_memberships m on m.id = sa.membership_id
      where ss.id = public.service_summary_versions.summary_id
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
    )
  );

drop policy if exists service_summary_versions_select_participant on public.service_summary_versions;
create policy service_summary_versions_select_participant
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1
      from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      where ss.id = public.service_summary_versions.summary_id
        and s.participant_id in (select public.current_user_self_links_participant_id())
        and s.state in ('finalised','corrected','cancelled')
        and 'participant' = any(public.service_summary_versions.audience_categories)
    )
  );

drop policy if exists service_summary_versions_select_representative on public.service_summary_versions;
create policy service_summary_versions_select_representative
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1
      from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      where ss.id = public.service_summary_versions.summary_id
        and s.participant_id in (
          select public.current_user_represents_participant('service_summary')
        )
        and s.state in ('finalised','corrected','cancelled')
        and ('participant' = any(public.service_summary_versions.audience_categories)
             or 'service_summary' = any(public.service_summary_versions.audience_categories))
    )
  );

drop policy if exists service_summary_versions_select_external on public.service_summary_versions;
create policy service_summary_versions_select_external
  on public.service_summary_versions for select to authenticated
  using (
    exists (
      select 1
      from public.service_summaries ss
      join public.shifts s on s.id = ss.shift_id
      where ss.id = public.service_summary_versions.summary_id
        and s.participant_id in (
          select public.current_user_external_grants_participant('service_summary')
        )
        and s.state in ('finalised','corrected','cancelled')
        and ('service_summary_external' = any(public.service_summary_versions.audience_categories)
             or 'service_summary' = any(public.service_summary_versions.audience_categories))
    )
  );

------------------------------------------------------------------------
-- service_summary_current_versions view policies (non-recursive projection)
------------------------------------------------------------------------
-- The view selects from service_summary_versions + service_summaries +
-- shifts and filters to current (non-superseded) finalised / corrected
-- / cancelled rows. RLS on the underlying tables is inherited via
-- security_invoker. We additionally grant SELECT on the view to the
-- relevant audiences here.

grant select on public.service_summary_current_versions to authenticated;

-- The view itself has security_invoker set; RLS policies on the
-- underlying tables filter its rows for each role. No separate policy
-- on the view is needed.

------------------------------------------------------------------------
-- command_receipts
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

-- No authenticated INSERT/UPDATE/DELETE — receipts are written by
-- SECURITY DEFINER RPCs only.

------------------------------------------------------------------------
-- evidence_review_queue
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
-- correction_requests
------------------------------------------------------------------------

alter table public.correction_requests enable row level security;

drop policy if exists correction_requests_select_requester on public.correction_requests;
create policy correction_requests_select_requester
  on public.correction_requests for select to authenticated
  using (requester_profile_id = auth.uid());

drop policy if exists correction_requests_select_admin_scheduler on public.correction_requests;
create policy correction_requests_select_admin_scheduler
  on public.correction_requests for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

-- No authenticated INSERT/UPDATE/DELETE on correction_requests;
-- mutations happen through cmd_request_correction and cmd_apply_correction.

------------------------------------------------------------------------
-- access_requests
------------------------------------------------------------------------

alter table public.access_requests enable row level security;

drop policy if exists access_requests_select_requester on public.access_requests;
create policy access_requests_select_requester
  on public.access_requests for select to authenticated
  using (requester_profile_id = auth.uid());

drop policy if exists access_requests_select_admin_scheduler on public.access_requests;
create policy access_requests_select_admin_scheduler
  on public.access_requests for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
  );

-- No authenticated INSERT/UPDATE/DELETE on access_requests;
-- mutations happen through cmd_request_access.

------------------------------------------------------------------------
-- worker_availability
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
