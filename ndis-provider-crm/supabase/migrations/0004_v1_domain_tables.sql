-- 0004_v1_domain_tables.sql
--
-- v1 domain tables for the NDIS Provider CRM.
--
-- Per decision-log/2026-08-06 ("Separate participant, representative,
-- internal, and external access authority") the data model uses distinct
-- rows for:
--
--   * participants                         — provider records of the people
--                                            receiving services.
--   * participant_self_links               — link a participant record to
--                                            the participant's own account.
--                                            Distinct from any external
--                                            disclosure grant.
--   * representative_authorities           — versioned records of nominee,
--                                            correspondence-nominee,
--                                            guardian, attorney, or other
--                                            representative authority.
--   * external_disclosure_grants           — purpose-specific, time-bounded,
--                                            recipient-scoped, category-scoped
--                                            access for external users,
--                                            backed by recorded consent.
--   * worker_availability                  — minimum published availability
--                                            rows for assignments.
--   * shifts + shift_assignments           — provider-scoped shifts with
--                                            versioned, reassignable
--                                            assignment history.
--   * critical_info_cards                  — minimum critical support / safety
--                                            information per participant.
--   * service_summaries + service_summary_versions — immutable text-only
--                                                    service records.
--   * correction_requests + access_requests — formal participant /
--                                              representative requests under
--                                              approved policy. NEVER implicit.
--   * command_receipts                     — scoped idempotency + receipt
--                                            for every sensitive command.
--   * evidence_review_queue                — preserves rejected / conflicting
--                                            evidence for supervisor review.
--   * shift_events                         — append-only chronological feed
--                                            of shift state changes.
--
-- Out of scope: photos, audio, biometrics, GPS, billing, claims,
-- messaging, marketplace, and any automatic hard-purge worker.
--
-- Tenant integrity (fixup finding 4/5/6): every relationship row
-- carries the parent organisation_id, AND composite FKs (or
-- constraints) require the referenced participant / shift / membership
-- to share that organisation_id. Cross-tenant rows are rejected at
-- write time.
--
-- All tables use soft-delete (deleted_at) where it makes sense; domain
-- rows are kept append-only by version / parent chains where required.

set search_path = public;

------------------------------------------------------------------------
-- 1. participants
------------------------------------------------------------------------

create table if not exists public.participants (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  first_name      text not null,
  last_initial    text,
  archived_at     timestamptz,
  created_by      uuid references public.global_profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  constraint participants_last_initial_shape
    check (last_initial is null or length(last_initial) <= 3)
);

create unique index if not exists participants_org_natural_key
  on public.participants (organisation_id, lower(first_name), lower(coalesce(last_initial, '')))
  where archived_at is null;

create index if not exists participants_org_idx
  on public.participants (organisation_id)
  where archived_at is null;

drop trigger if exists participants_set_updated_at on public.participants;
create trigger participants_set_updated_at
  before update on public.participants
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 2. participant_self_links
------------------------------------------------------------------------

create table if not exists public.participant_self_links (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  participant_id    uuid not null references public.participants (id) on delete cascade,
  profile_id        uuid not null references public.global_profiles (id) on delete cascade,
  status            text not null default 'active'
                      check (status in ('active','withdrawn')),
  linked_at         timestamptz not null default now(),
  withdrawn_at      timestamptz,
  withdrawn_by      uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason  text,
  evidence_reference text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (participant_id, profile_id),
  -- Tenant integrity: the linked participant must belong to the same
  -- organisation as the self-link row.
  constraint participant_self_links_tenant_match
    foreign key (organisation_id, participant_id)
    references public.participants (organisation_id, id)
    on delete cascade
);

create index if not exists participant_self_links_participant_idx
  on public.participant_self_links (participant_id)
  where status = 'active';

create index if not exists participant_self_links_profile_idx
  on public.participant_self_links (profile_id)
  where status = 'active';

drop trigger if exists participant_self_links_set_updated_at on public.participant_self_links;
create trigger participant_self_links_set_updated_at
  before update on public.participant_self_links
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 3. representative_authorities
------------------------------------------------------------------------

create table if not exists public.representative_authorities (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null references public.organisations (id) on delete restrict,
  participant_id           uuid not null references public.participants (id) on delete restrict,
  representative_profile_id uuid not null references public.global_profiles (id) on delete restrict,
  authority_type           text not null,
  scope_categories         text[] not null default '{}',
  evidence_reference       text,
  issuer                   text,
  issuer_profile_id        uuid references public.global_profiles (id) on delete set null,
  effective_from           timestamptz not null default now(),
  effective_until          timestamptz,
  status                   text not null default 'active'
                             check (status in ('active','superseded','revoked','disputed')),
  superseded_by            uuid references public.representative_authorities (id) on delete set null,
  withdrawn_at             timestamptz,
  withdrawn_by             uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason         text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint representative_scope_not_empty
    check (cardinality(scope_categories) >= 1),
  -- Tenant integrity.
  constraint representative_authorities_tenant_match
    foreign key (organisation_id, participant_id)
    references public.participants (organisation_id, id)
    on delete restrict
);

create index if not exists representative_authorities_representative_idx
  on public.representative_authorities (representative_profile_id)
  where status = 'active';

create index if not exists representative_authorities_participant_idx
  on public.representative_authorities (participant_id)
  where status = 'active';

drop trigger if exists representative_authorities_set_updated_at on public.representative_authorities;
create trigger representative_authorities_set_updated_at
  before update on public.representative_authorities
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 4. external_disclosure_grants
------------------------------------------------------------------------

create table if not exists public.external_disclosure_grants (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null references public.organisations (id) on delete restrict,
  participant_id      uuid not null references public.participants (id) on delete restrict,
  recipient_profile_id uuid not null references public.global_profiles (id) on delete restrict,
  purpose             text not null,
  scope_categories    text[] not null default '{}',
  issuer              text,
  issuer_profile_id   uuid references public.global_profiles (id) on delete set null,
  consent_basis       text not null check (consent_basis in ('participant','authorised_representative','provider_internal_use')),
  consent_reference   text,
  evidence_reference  text,
  effective_from      timestamptz not null default now(),
  effective_until     timestamptz not null,
  status              text not null default 'active'
                        check (status in ('active','superseded','revoked','expired')),
  superseded_by       uuid references public.external_disclosure_grants (id) on delete set null,
  withdrawn_at        timestamptz,
  withdrawn_by        uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint external_grants_scope_not_empty
    check (cardinality(scope_categories) >= 1),
  constraint external_grants_window_valid
    check (effective_until > effective_from),
  constraint external_grants_tenant_match
    foreign key (organisation_id, participant_id)
    references public.participants (organisation_id, id)
    on delete restrict
);

create index if not exists external_grants_recipient_idx
  on public.external_disclosure_grants (recipient_profile_id)
  where status = 'active';

create index if not exists external_grants_participant_idx
  on public.external_disclosure_grants (participant_id)
  where status = 'active';

drop trigger if exists external_disclosure_grants_set_updated_at on public.external_disclosure_grants;
create trigger external_disclosure_grants_set_updated_at
  before update on public.external_disclosure_grants
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 5. worker_availability
------------------------------------------------------------------------

create table if not exists public.worker_availability (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  membership_id   uuid not null references public.organisation_memberships (id) on delete cascade,
  available_during tstzrange not null,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint worker_availability_tenant_match
    foreign key (organisation_id, membership_id)
    references public.organisation_memberships (organisation_id, id)
    on delete cascade
);

create index if not exists worker_availability_membership_idx
  on public.worker_availability (membership_id);

create index if not exists worker_availability_during_idx
  on public.worker_availability using gist (available_during);

drop trigger if exists worker_availability_set_updated_at on public.worker_availability;
create trigger worker_availability_set_updated_at
  before update on public.worker_availability
  for each row execute function public.set_updated_at();

create or replace function public.check_availability_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role
  from public.organisation_memberships
  where id = new.membership_id;
  if v_role is null or v_role <> 'worker' then
    raise exception 'worker_availability requires worker membership'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists worker_availability_role_check on public.worker_availability;
create trigger worker_availability_role_check
  before insert or update on public.worker_availability
  for each row execute function public.check_availability_role();

------------------------------------------------------------------------
-- 6. shifts
------------------------------------------------------------------------

create table if not exists public.shifts (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  participant_id  uuid not null references public.participants (id) on delete restrict,
  scheduled_start timestamptz not null,
  scheduled_end   timestamptz not null,
  state           text not null default 'scheduled'
                    check (state in (
                      'scheduled',
                      'in_transit',
                      'started',
                      'ended_summary_required',
                      'submitted_local',
                      'syncing',
                      'finalised',
                      'needs_review',
                      'cancelled',
                      'cancelled_needs_review',
                      'corrected'
                    )),
  version         bigint not null default 1,
  cancellation_reason text,
  cancelled_at    timestamptz,
  cancelled_by    uuid references public.global_profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint shifts_window_valid
    check (scheduled_end > scheduled_start),
  unique (organisation_id, id),
  constraint shifts_tenant_match
    foreign key (organisation_id, participant_id)
    references public.participants (organisation_id, id)
    on delete restrict
);

create index if not exists shifts_org_state_idx
  on public.shifts (organisation_id, state);

create index if not exists shifts_participant_idx
  on public.shifts (participant_id, scheduled_start desc);

create index if not exists shifts_org_schedule_idx
  on public.shifts (organisation_id, scheduled_start);

drop trigger if exists shifts_set_updated_at on public.shifts;
create trigger shifts_set_updated_at
  before update on public.shifts
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 7. shift_assignments
------------------------------------------------------------------------

create table if not exists public.shift_assignments (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts (id) on delete cascade,
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  membership_id   uuid not null references public.organisation_memberships (id) on delete restrict,
  effective_from  timestamptz not null default now(),
  effective_until timestamptz,
  withdrawn_at    timestamptz,
  reassignment_reason text,
  assigned_by     uuid references public.global_profiles (id) on delete set null,
  superseded_by   uuid references public.shift_assignments (id) on delete set null,
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Tenant integrity on (org, shift) and (org, membership).
  constraint shift_assignments_shift_tenant_match
    foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id)
    on delete cascade,
  constraint shift_assignments_membership_tenant_match
    foreign key (organisation_id, membership_id)
    references public.organisation_memberships (organisation_id, id)
    on delete restrict
);

create index if not exists shift_assignments_shift_idx
  on public.shift_assignments (shift_id);

create index if not exists shift_assignments_membership_idx
  on public.shift_assignments (membership_id);

drop trigger if exists shift_assignments_set_updated_at on public.shift_assignments;
create trigger shift_assignments_set_updated_at
  before update on public.shift_assignments
  for each row execute function public.set_updated_at();

-- Assignment-aware worker scope helper. This is defined after the
-- assignment table exists because PostgreSQL resolves SQL-function table
-- references at CREATE FUNCTION time.
create or replace function public.user_is_assigned(
  p_shift_id uuid,
  p_required_role text default 'worker'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shift_assignments sa
    join public.organisation_memberships m on m.id = sa.membership_id
    join public.organisations o on o.id = sa.organisation_id
    where sa.shift_id = p_shift_id
      and sa.withdrawn_at is null
      and sa.effective_from <= now()
      and (sa.effective_until is null or sa.effective_until > now())
      and m.profile_id = auth.uid()
      and m.status = 'active'
      and m.effective_from <= now()
      and (m.effective_until is null or m.effective_until > now())
      and (m.role = p_required_role
           or public.membership_has_role(m.id, p_required_role))
      and o.deleted_at is null
  )
$$;

revoke all on function public.user_is_assigned(uuid, text) from public;
grant execute on function public.user_is_assigned(uuid, text) to authenticated;

------------------------------------------------------------------------
-- 8. critical_info_cards
------------------------------------------------------------------------

create table if not exists public.critical_info_cards (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  participant_id    uuid not null references public.participants (id) on delete cascade,
  version           bigint not null default 1,
  content_text      text not null,
  owner_profile_id  uuid references public.global_profiles (id) on delete set null,
  reviewed_at       timestamptz not null default now(),
  review_due_at     timestamptz not null,
  superseded_by     uuid references public.critical_info_cards (id) on delete set null,
  status            text not null default 'active'
                      check (status in ('active','superseded')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint critical_info_cards_tenant_match
    foreign key (organisation_id, participant_id)
    references public.participants (organisation_id, id)
    on delete cascade
);

create index if not exists critical_info_cards_participant_idx
  on public.critical_info_cards (participant_id)
  where status = 'active';

------------------------------------------------------------------------
-- 9. service_summaries (header) + service_summary_versions (immutable)
------------------------------------------------------------------------
-- service_summary_versions is the append-only history. The current
-- version is identified by the absence of a successor (no row in
-- service_summary_versions has superseded_by = this id AND this row's
-- is_correction / superseded_by state). The header carries the
-- denormalised pointer to the current version row for fast reads,
-- and RLS uses a non-recursive CURRENT-VERSION PROJECTION in 0006.

create table if not exists public.service_summaries (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  shift_id          uuid not null,
  current_version_id uuid,
  finalised_at      timestamptz,
  has_correction    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organisation_id, id),
  constraint service_summaries_shift_tenant_match
    foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id)
    on delete restrict,
  constraint service_summaries_one_per_shift unique (shift_id)
);

create index if not exists service_summaries_shift_idx
  on public.service_summaries (shift_id);

drop trigger if exists service_summaries_set_updated_at on public.service_summaries;
create trigger service_summaries_set_updated_at
  before update on public.service_summaries
  for each row execute function public.set_updated_at();

create table if not exists public.service_summary_versions (
  id                  uuid primary key default gen_random_uuid(),
  summary_id          uuid not null references public.service_summaries (id) on delete cascade,
  version_number      integer not null,
  activities          text[] not null default '{}',
  summary_text        text not null,
  audience_categories text[] not null default '{}',
  author_membership_id uuid not null references public.organisation_memberships (id) on delete restrict,
  is_correction       boolean not null default false,
  correction_reason   text,
  superseded_by       uuid references public.service_summary_versions (id) on delete set null,
  created_at          timestamptz not null default now(),
  unique (summary_id, version_number)
);

create index if not exists service_summary_versions_summary_idx
  on public.service_summary_versions (summary_id);

-- After both tables exist, add the deferred FK from header to version.
do $$
begin
  begin
    alter table public.service_summaries
      add constraint service_summaries_current_version_fk
      foreign key (current_version_id)
      references public.service_summary_versions (id)
      deferrable initially deferred;
  exception when duplicate_object then null;
  end;
end$$;

-- Mark every service_summary_versions row immutable: an UPDATE may not
-- change summary_text / activities / audience / author once written.
create or replace function public.service_summary_versions_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.summary_id <> old.summary_id
    or new.summary_text <> old.summary_text
    or new.activities <> old.activities
    or new.audience_categories <> old.audience_categories
    or new.author_membership_id <> old.author_membership_id
    or new.version_number <> old.version_number
  then
    raise exception 'service_summary_versions_immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists service_summary_versions_immutable_trg on public.service_summary_versions;
create trigger service_summary_versions_immutable_trg
  before update on public.service_summary_versions
  for each row execute function public.service_summary_versions_immutable();

------------------------------------------------------------------------
-- 10. command_receipts (scoped idempotency)
------------------------------------------------------------------------
-- The unique key is (organisation_id, actor_membership_id, command_type,
-- command_id). The lookup function takes all four so RPCs cannot
-- accidentally return another actor's receipt and cannot collide on a
-- different command type.

create table if not exists public.command_receipts (
  id                uuid primary key default gen_random_uuid(),
  command_id        text not null,
  command_type      text not null check (command_type in (
                      'on_my_way',
                      'start_shift',
                      'end_shift',
                      'submit_summary',
                      'finalise_summary',
                      'resolve_conflict',
                      'request_correction',
                      'apply_correction',
                      'accept_invitation'
                    )),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  actor_membership_id uuid not null references public.organisation_memberships (id) on delete restrict,
  subject_shift_id  uuid references public.shifts (id) on delete set null,
  subject_review_id uuid,
  subject_request_id uuid,
  subject_invitation_id uuid references public.invitations (id) on delete set null,
  expected_version  bigint,
  claimed_at        timestamptz not null,
  client_tz         text,
  server_received_at timestamptz not null default now(),
  completed_at      timestamptz,
  status            text not null check (status in (
                      'accepted', 'rejected', 'conflict_preserved', 'duplicate_returned'
                    )),
  outcome           jsonb not null default '{}'::jsonb,
  payload           jsonb not null default '{}'::jsonb,
  unique (organisation_id, actor_membership_id, command_type, command_id)
);

create index if not exists command_receipts_org_idx
  on public.command_receipts (organisation_id, server_received_at desc);

create index if not exists command_receipts_shift_idx
  on public.command_receipts (subject_shift_id);

create index if not exists command_receipts_status_idx
  on public.command_receipts (status);

create index if not exists command_receipts_receipt_lookup_idx
  on public.command_receipts (organisation_id, actor_membership_id, command_type, command_id);

------------------------------------------------------------------------
-- 11. evidence_review_queue (preserves rejected/conflicting evidence)
------------------------------------------------------------------------

create table if not exists public.evidence_review_queue (
  id                uuid primary key default gen_random_uuid(),
  receipt_id        uuid not null references public.command_receipts (id) on delete cascade,
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  state             text not null default 'pending'
                      check (state in (
                        'pending',
                        'accepted_exception',
                        'rejected_with_reason',
                        'needs_more_info'
                      )),
  original_payload  jsonb not null,
  conflicting_context jsonb not null default '{}'::jsonb,
  decision_reason   text,
  decided_by        uuid references public.global_profiles (id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (receipt_id),
  -- Decided reviews are immutable: the supervisor decision is one-way.
  constraint evidence_review_queue_decision_immutable
    check (
      (state = 'pending' and decided_by is null and decided_at is null)
      or
      (state <> 'pending' and decided_by is not null and decided_at is not null)
    )
);

create index if not exists evidence_review_queue_org_idx
  on public.evidence_review_queue (organisation_id, state);

drop trigger if exists evidence_review_queue_set_updated_at on public.evidence_review_queue;
create trigger evidence_review_queue_set_updated_at
  before update on public.evidence_review_queue
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 12. correction_requests — pending, audited
------------------------------------------------------------------------

create table if not exists public.correction_requests (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  summary_id        uuid references public.service_summaries (id) on delete set null,
  shift_id          uuid references public.shifts (id) on delete set null,
  requester_kind    text not null check (requester_kind in
                      ('workforce','participant_self','representative')),
  requester_profile_id uuid not null references public.global_profiles (id) on delete restrict,
  reason            text not null,
  requested_changes text,
  status            text not null default 'pending'
                      check (status in ('pending','approved','rejected','withdrawn')),
  decided_by        uuid references public.global_profiles (id) on delete set null,
  decided_at        timestamptz,
  decision_reason   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Tenant integrity on (org, shift) and (org, summary).
  constraint correction_requests_shift_tenant_match
    foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id)
    on delete restrict,
  constraint correction_requests_summary_tenant_match
    foreign key (organisation_id, summary_id)
    references public.service_summaries (organisation_id, id)
    on delete restrict,
  -- Decided requests are immutable.
  constraint correction_requests_decided_immutable
    check (
      (status = 'pending' and decided_by is null and decided_at is null)
      or
      (status <> 'pending' and decided_by is not null and decided_at is not null)
    )
);

create index if not exists correction_requests_org_status_idx
  on public.correction_requests (organisation_id, status);

drop trigger if exists correction_requests_set_updated_at on public.correction_requests;
create trigger correction_requests_set_updated_at
  before update on public.correction_requests
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 13. access_requests — formal access / correction requests
------------------------------------------------------------------------

create table if not exists public.access_requests (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  requester_profile_id uuid not null references public.global_profiles (id) on delete restrict,
  participant_id    uuid references public.participants (id) on delete set null,
  scope_categories  text[] not null default '{}',
  reason            text not null,
  requested_at      timestamptz not null default now(),
  status            text not null default 'pending'
                      check (status in ('pending','approved','rejected','withdrawn')),
  decision_reason   text,
  decided_by        uuid references public.global_profiles (id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint access_requests_scope_not_empty
    check (cardinality(scope_categories) >= 1),
  constraint access_requests_tenant_match
    foreign key (organisation_id, participant_id)
    references public.participants (organisation_id, id)
    on delete restrict,
  constraint access_requests_decided_immutable
    check (
      (status = 'pending' and decided_by is null and decided_at is null)
      or
      (status <> 'pending' and decided_by is not null and decided_at is not null)
    )
);

create index if not exists access_requests_org_status_idx
  on public.access_requests (organisation_id, status);

drop trigger if exists access_requests_set_updated_at on public.access_requests;
create trigger access_requests_set_updated_at
  before update on public.access_requests
  for each row execute function public.set_updated_at();

-- Receipt subjects are declared after command_receipts; attach their
-- referential constraints once all relations exist.
do $$
begin
  begin
    alter table public.command_receipts
      add constraint command_receipts_review_fk
      foreign key (subject_review_id)
      references public.evidence_review_queue (id)
      on delete set null;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.command_receipts
      add constraint command_receipts_request_fk
      foreign key (subject_request_id)
      references public.correction_requests (id)
      on delete set null;
  exception when duplicate_object then null;
  end;
end;
$$;

------------------------------------------------------------------------
-- 14. shift_events — append-only chronological feed
------------------------------------------------------------------------

create table if not exists public.shift_events (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  shift_id          uuid not null references public.shifts (id) on delete cascade,
  event_type        text not null check (event_type in (
                      'on_my_way',
                      'start',
                      'end',
                      'summary_submitted',
                      'summary_finalised',
                      'cancelled',
                      'reassigned',
                      'corrected',
                      'conflicted',
                      'resolved'
                    )),
  occurred_at       timestamptz not null default now(),
  actor_membership_id uuid references public.organisation_memberships (id) on delete set null,
  payload           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  constraint shift_events_shift_tenant_match
    foreign key (organisation_id, shift_id)
    references public.shifts (organisation_id, id)
    on delete cascade
);

create index if not exists shift_events_shift_idx
  on public.shift_events (shift_id, occurred_at);

------------------------------------------------------------------------
-- 15. Non-recursive CURRENT-VERSION projection
------------------------------------------------------------------------
-- A SECURITY INVOKER view used by participant-safe readers. The view
-- only shows rows that have no successor (`superseded_by is null`)
-- AND belongs to a shift whose state is finalised / corrected /
-- cancelled (i.e. never an in-flight draft). RLS in 0006 binds the
-- view to its underlying table policies through inheritance rules +
-- explicit WITH (security_invoker) on the view.

create or replace view public.service_summary_current_versions
with (security_invoker) as
select v.*
from public.service_summary_versions v
join public.service_summaries s on s.id = v.summary_id
join public.shifts sh on sh.id = s.shift_id
where v.superseded_by is null
  and sh.state in ('finalised','corrected','cancelled');

comment on view public.service_summary_current_versions is
  'Participant-safe projection: only the current (non-superseded) version of finalised / corrected / cancelled shifts. Used by representative, external-grant and participant-self readers so RLS stays non-recursive.';
