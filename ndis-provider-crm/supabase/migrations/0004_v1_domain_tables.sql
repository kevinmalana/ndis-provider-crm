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
--                                            disclosure grant — participants
--                                            do NOT need a grant to use
--                                            their own portal.
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
--   * command_receipts                     — idempotency + audit summary for
--                                            every sensitive command.
--   * evidence_review_queue                — preserves rejected / conflicting
--                                            evidence for supervisor review.
--
-- Out of scope here: photos, audio, biometrics, GPS, billing, claims,
-- messaging, marketplace, and any automatic hard-purge worker.
--
-- All tables use soft-delete (deleted_at) where it makes sense (organisational
-- records); domain rows are kept append-only by version/parent chains.

set search_path = public;

------------------------------------------------------------------------
-- helper: shared enums (text-typed for cheap evolvability)
------------------------------------------------------------------------
-- Phase: we use text + check constraints rather than pg enums because we
-- expect the list to grow during pilot. Each enum-style field groups its
-- values inside the table definition comments.

------------------------------------------------------------------------
-- participants
------------------------------------------------------------------------
-- One row per participant receiving services from the organisation. The
-- record itself is not a person; it is a provider's record of a person.
-- Subsequent authority/consent/self-link/grants are separate rows.

create table if not exists public.participants (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  -- Display fields. v1 names support first-name + last-initial only and
  -- addresses by free-text "location hint" plus a separate full-address
  -- record in a later ticket.
  first_name      text not null,
  last_initial    text,
  -- Workmanship guards: trimming happens at write time so lookups are
  -- whitespace-independent. last_initial is a single character or empty.
  archived_at     timestamptz,
  created_by      uuid references public.global_profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint participants_last_initial_shape
    check (last_initial is null or length(last_initial) <= 3)
);

create index if not exists participants_org_idx
  on public.participants (organisation_id)
  where archived_at is null;

create unique index if not exists participants_org_natural_key
  on public.participants (organisation_id, lower(first_name), lower(coalesce(last_initial, '')))
  where archived_at is null;

create trigger participants_set_updated_at
  before update on public.participants
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- participant_self_links
------------------------------------------------------------------------
-- Links a participant record to a global profile of the actual person.
-- Distinct from a workforce membership: a participant self-link has no
-- role and is not implied by any internal role. Withdrawal ends portal
-- access without deleting history.

create table if not exists public.participant_self_links (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  participant_id  uuid not null references public.participants (id) on delete cascade,
  profile_id      uuid not null references public.global_profiles (id) on delete cascade,
  status          text not null default 'active'
                    check (status in ('active','withdrawn')),
  linked_at       timestamptz not null default now(),
  withdrawn_at    timestamptz,
  withdrawn_by    uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason text,
  evidence_reference text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One active self-link per (participant, profile). Withdrawn history is
  -- preserved by allowing multiple withdrawn rows in the future.
  unique (participant_id, profile_id)
);

create index if not exists participant_self_links_participant_idx
  on public.participant_self_links (participant_id)
  where status = 'active';

create index if not exists participant_self_links_profile_idx
  on public.participant_self_links (profile_id)
  where status = 'active';

create trigger participant_self_links_set_updated_at
  before update on public.participant_self_links
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- representative_authorities
------------------------------------------------------------------------
-- Versioned: amendment/withdrawal creates a successor row with
-- predecessor_id set. The current authoritative row is the one with no
-- successor. authority_type is intentionally a free-text label rather
-- than an enum (see personas & stories S4.1: plan nominee, correspondence
-- nominee, guardian, attorney, informal supporter are NOT interchangeable
-- labels and may grow).
--
-- scope_categories lists the record categories the representative may
-- view ('upcoming_visits', 'service_summary', 'critical_information',
-- 'access_requests', etc.).
--
-- effective_from / effective_until bound the time window. withdrawal_at
-- plus superseded_by close the chain.

create table if not exists public.representative_authorities (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references public.organisations (id) on delete restrict,
  participant_id     uuid not null references public.participants (id) on delete restrict,
  representative_profile_id uuid not null references public.global_profiles (id) on delete restrict,
  authority_type     text not null,
  scope_categories   text[] not null default '{}',
  evidence_reference text,
  issuer             text,
  issuer_profile_id  uuid references public.global_profiles (id) on delete set null,
  effective_from     timestamptz not null default now(),
  effective_until    timestamptz,
  status             text not null default 'active'
                       check (status in ('active','superseded','revoked','disputed')),
  superseded_by      uuid references public.representative_authorities (id) on delete set null,
  withdrawn_at       timestamptz,
  withdrawn_by       uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint representative_scope_not_empty
    check (cardinality(scope_categories) >= 1)
);

create index if not exists representative_authorities_representative_idx
  on public.representative_authorities (representative_profile_id)
  where status = 'active';

create index if not exists representative_authorities_participant_idx
  on public.representative_authorities (participant_id)
  where status = 'active';

create index if not exists representative_authorities_participant_scope_idx
  on public.representative_authorities (participant_id, status)
  where status = 'active';

create trigger representative_authorities_set_updated_at
  before update on public.representative_authorities
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- external_disclosure_grants
------------------------------------------------------------------------
-- Versioned like representative_authorities. scope_categories lists the
-- record categories the external user may view (grants are category-
-- scoped, not blanket). purpose is required.

create table if not exists public.external_disclosure_grants (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references public.organisations (id) on delete restrict,
  participant_id     uuid not null references public.participants (id) on delete restrict,
  recipient_profile_id uuid not null references public.global_profiles (id) on delete restrict,
  purpose            text not null,
  scope_categories   text[] not null default '{}',
  issuer             text,
  issuer_profile_id  uuid references public.global_profiles (id) on delete set null,
  consent_basis      text not null check (consent_basis in ('participant','authorised_representative','provider_internal_use')),
  consent_reference  text,
  evidence_reference text,
  effective_from     timestamptz not null default now(),
  effective_until    timestamptz not null,
  status             text not null default 'active'
                       check (status in ('active','superseded','revoked','expired')),
  superseded_by      uuid references public.external_disclosure_grants (id) on delete set null,
  withdrawn_at       timestamptz,
  withdrawn_by       uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint external_grants_scope_not_empty
    check (cardinality(scope_categories) >= 1),
  constraint external_grants_window_valid
    check (effective_until > effective_from)
);

create index if not exists external_grants_recipient_idx
  on public.external_disclosure_grants (recipient_profile_id)
  where status = 'active';

create index if not exists external_grants_participant_idx
  on public.external_disclosure_grants (participant_id)
  where status = 'active';

create trigger external_disclosure_grants_set_updated_at
  before update on public.external_disclosure_grants
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- worker_availability
------------------------------------------------------------------------
-- Published availability windows that controllers consult before
-- assignment. Stored as tstzrange for first-class overlap reasoning.

create table if not exists public.worker_availability (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  membership_id   uuid not null references public.organisation_memberships (id) on delete cascade,
  available_during tstzrange not null,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- The role is enforced by the trigger below, not by a check constraint
  -- here; the trigger can consult organisation_memberships.role which a
  -- plain CHECK cannot do cross-table.
  check (membership_id is not null)
);

create index if not exists worker_availability_membership_idx
  on public.worker_availability (membership_id);

create index if not exists worker_availability_during_idx
  on public.worker_availability using gist (available_during);

create trigger worker_availability_set_updated_at
  before update on public.worker_availability
  for each row execute function public.set_updated_at();

create or replace function public.check_availability_role()
returns trigger
language plpgsql
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

create trigger worker_availability_role_check
  before insert or update on public.worker_availability
  for each row execute function public.check_availability_role();

------------------------------------------------------------------------
-- shifts
------------------------------------------------------------------------
-- v1 state model:
--   scheduled, in_transit, started, ended_summary_required,
--   submitted_local, syncing, finalised, needs_review, cancelled,
--   cancelled_needs_review, corrected
--
-- version increments on every state change. concurrent commands bump
-- version; client carries expected_version and stale requests are
-- rejected with a conflict (preserved on evidence_review_queue).

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
    check (scheduled_end > scheduled_start)
);

create index if not exists shifts_org_state_idx
  on public.shifts (organisation_id, state);

create index if not exists shifts_participant_idx
  on public.shifts (participant_id, scheduled_start desc);

create index if not exists shifts_org_schedule_idx
  on public.shifts (organisation_id, scheduled_start);

create trigger shifts_set_updated_at
  before update on public.shifts
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- shift_assignments
------------------------------------------------------------------------
-- Versioned assignment history. New (re)assignment inserts a new row
-- and marks the previous active row withdrawn via superseded_by. RLS
-- consumes only the row whose (effective_from, effective_until_withdrawn)
-- brackets the worker lookup time AND membership status is active.

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
  updated_at      timestamptz not null default now()
);

create index if not exists shift_assignments_shift_active_idx
  on public.shift_assignments (shift_id)
  where withdrawn_at is null;

create index if not exists shift_assignments_membership_idx
  on public.shift_assignments (membership_id)
  where withdrawn_at is null;

create trigger shift_assignments_set_updated_at
  before update on public.shift_assignments
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- critical_info_cards
------------------------------------------------------------------------
-- Versioned minimum critical support / safety information per participant.
-- reviewed_at and review_due_at drive the missing-or-stale warning
-- in the worker flow.

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
  updated_at        timestamptz not null default now()
);

create index if not exists critical_info_cards_participant_idx
  on public.critical_info_cards (participant_id)
  where status = 'active';

------------------------------------------------------------------------
-- service_summaries (header) + service_summary_versions (immutable)
------------------------------------------------------------------------
-- Each shift has at most one finalised summary at a time. Corrections
-- insert a new version row; original remains immutable. status of the
-- header reflects visibility/acceptance state.
--
-- submission state is distinct from shift state (the header is the
-- record; the shift carries the lifecycle).

create table if not exists public.service_summaries (
  id                uuid primary key default gen_random_uuid(),
  shift_id          uuid not null references public.shifts (id) on delete restrict,
  current_version_id uuid,
  finalised_at      timestamptz,
  has_correction    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint service_summaries_one_per_shift unique (shift_id)
);

create index if not exists service_summaries_shift_idx
  on public.service_summaries (shift_id);

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

-- Forward reference resolution: service_summaries.current_version_id
-- references service_summary_versions. We have to relax it now and add
-- the constraint in this same file, but after both tables exist.
alter table public.service_summaries
  drop constraint if exists service_summaries_current_version_fk;
alter table public.service_summaries
  add constraint service_summaries_current_version_fk
  foreign key (current_version_id)
  references public.service_summary_versions (id)
  deferrable initially deferred;

------------------------------------------------------------------------
-- command_receipts — idempotency + record of every sensitive command
------------------------------------------------------------------------
-- Each sensitive command (On my way, Start, End, submit_summary,
-- finalise_summary, resolve_conflict, request_correction, apply_correction)
-- is recorded here keyed by command_id. A repeat submission with the
-- same command_id returns the existing outcome verbatim.
--
-- This table holds the receipt and the *last server-known payload*.
-- Detailed transitions additionally append rows to audit_log in the
-- same transaction (per decision-log "Direct Supabase RPC for sensitive
-- state transitions").

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
                      'apply_correction'
                    )),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  actor_membership_id uuid not null references public.organisation_memberships (id) on delete restrict,
  subject_shift_id  uuid references public.shifts (id) on delete set null,
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
  unique (command_id)
);

create index if not exists command_receipts_org_idx
  on public.command_receipts (organisation_id, server_received_at desc);

create index if not exists command_receipts_shift_idx
  on public.command_receipts (subject_shift_id);

create index if not exists command_receipts_status_idx
  on public.command_receipts (status);

------------------------------------------------------------------------
-- evidence_review_queue — preserves rejected/conflicting evidence
------------------------------------------------------------------------
-- Per decision-log "Evidence-preserving worker lifecycle..." — a server
-- rejection or conflict never deletes evidence. The original command +
-- context is preserved here so a supervisor can accept-as-exception,
-- request more info, or reject with a reason.

create table if not exists public.evidence_review_queue (
  id                uuid primary key default gen_random_uuid(),
  receipt_id        uuid not null references public.command_receipts (id) on delete cascade,
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  state             text not null default 'pending'
                      check (state in ('pending','accepted_exception','rejected_with_reason','needs_more_info')),
  original_payload  jsonb not null,
  conflicting_context jsonb not null default '{}'::jsonb,
  decision_reason   text,
  decided_by        uuid references public.global_profiles (id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (receipt_id)
);

create index if not exists evidence_review_queue_org_idx
  on public.evidence_review_queue (organisation_id, state);

create trigger evidence_review_queue_set_updated_at
  before update on public.evidence_review_queue
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- correction_requests — explicit, pending, audited
------------------------------------------------------------------------
-- Per stories S1.7 and S3.3: a participant / representative / worker
-- may *request* a correction. The actual correction is produced by an
-- authorised supervisor (apply_correction RPC). The request itself is
-- a pending record, NEVER a silent mutation.

create table if not exists public.correction_requests (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  summary_id        uuid references public.service_summaries (id) on delete set null,
  shift_id          uuid references public.shifts (id) on delete set null,
  requested_by      uuid not null references public.global_profiles (id) on delete restrict,
  reason            text not null,
  requested_changes text,
  status            text not null default 'pending'
                      check (status in ('pending','approved','rejected','withdrawn')),
  decided_by        uuid references public.global_profiles (id) on delete set null,
  decided_at        timestamptz,
  decision_reason   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists correction_requests_org_status_idx
  on public.correction_requests (organisation_id, status);

create trigger correction_requests_set_updated_at
  before update on public.correction_requests
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- access_requests — formal participant access / correction requests
------------------------------------------------------------------------
-- Distinct from correction_requests: handled under approved human policy.
-- Records the request, scope, submitted time, status, and decision.
-- Never silently alters a grant or historical record.

create table if not exists public.access_requests (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations (id) on delete restrict,
  requester         uuid not null references public.global_profiles (id) on delete restrict,
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
    check (cardinality(scope_categories) >= 1)
);

create index if not exists access_requests_org_status_idx
  on public.access_requests (organisation_id, status);

create trigger access_requests_set_updated_at
  before update on public.access_requests
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- shift_events — append-only chronological feed of shift state changes
------------------------------------------------------------------------
-- Distinct from audit_log: this is the participant-visible event log a
-- shift is built from. audit_log is the privileged admin trail.
-- Both are populated by the transactional RPCs in migration 0005.

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
  created_at        timestamptz not null default now()
);

create index if not exists shift_events_shift_idx
  on public.shift_events (shift_id, occurred_at);

-- RLS on shift_events is set in 0006; here we just create the structure.
alter table public.shift_events enable row level security;
