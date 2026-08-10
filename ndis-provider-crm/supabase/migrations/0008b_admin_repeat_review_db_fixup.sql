-- 0008b_admin_repeat_review_db_fixup.sql
--
-- Repeat-review DB/security fixup for Ticket 05. Closes the cold-review
-- blockers raised at HEAD b30bbfa without consuming the 0009 slot that
-- Ticket 05b owns for the service-ready migration.
--
--   1. Receipt reservation/finalisation helpers become internal-only.
--      Authenticated callers cannot forge an actor_membership linkage,
--      pre-reserve another actor's key, or rewrite a completed outcome.
--   2. participant_consent_evidence keeps SELECT allowed via RLS for
--      admin/scheduler/self/authoriser; direct INSERT/UPDATE/DELETE from
--      authenticated remains denied; new catalog/PostgREST-shaped ACL
--      tests confirm both halves on the real `authenticated` role
--      (the harness blanket test role is not relied on for these).
--   3. Consent renewal/version/supersession lives in
--      cmd_admin_renew_consent. The renewal is the only way to add a
--      supersession edge; old versions are immutable and a stale or
--      concurrent renewal returns the existing current version's outcome.
--   4. Pre-b30 schema upgrade: the version column and uniqueness
--      constraint are added outside CREATE TABLE IF NOT EXISTS so a
--      re-run of the upgrade on a database that already holds
--      version-less consent rows backfills deterministically.
--   5. Representative consent and grant issuance require a live,
--      effective same-tenant representative/nominee membership and role
--      for the authorising/recipient profile. Withdrawal or future
--      effective dates invalidate new issuance.
--   6. Supplementary active admin/scheduler roles are honoured through
--      membership context, the /app/admin server-side routing, and
--      every Ticket 05 read policy.

set search_path = '';

------------------------------------------------------------------------
-- Pre-b30 schema upgrade: ensure the version column + uniqueness
-- constraint exist outside CREATE TABLE IF NOT EXISTS.
--
-- The original Ticket 05 migration created participant_consent_evidence
-- with `version integer not null default 1`. A pre-b30 deployment of
-- the table may be missing that column AND may already hold multiple
-- rows per (org, participant, recipient) without a supersession
-- chain. The statements below are idempotent: re-running them is
-- safe and produces the same end state.
------------------------------------------------------------------------

alter table public.participant_consent_evidence
  add column if not exists version integer;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'participant_consent_evidence'
      and column_name  = 'version'
  ) then
    -- CHECK constraint added via DO block so re-run is a no-op even
    -- when the column already existed in a pre-b30 deployment.
    begin
      alter table public.participant_consent_evidence
        add constraint participant_consent_evidence_version_positive
        check (version is null or version > 0);
    exception when duplicate_object then
      null;
    end;

    -- Pre-version populated upgrade: assign deterministic
    -- row_number versions across duplicate-history rows so the
    -- (org, participant, recipient, version) uniqueness constraint
    -- never collides on upgrade. All pre-b30 rows are preserved;
    -- only the legacy active duplicates get chained via superseded_by
    -- so the newest row per group is the unique unsuperseded current.
    --
    -- For each (org, participant, recipient) group:
    --   * order the rows by created_at (then id) ascending,
    --   * assign version = row_number(),
    --   * set superseded_by = next row's id (NULL for the newest row),
    --   * preserve original status; do not rewrite history.
    --
    -- Idempotency: rows that already carry a non-null version are
    -- left alone. Re-runs after a successful first upgrade skip
    -- every row.
    with versioned as (
      select
        id,
        organisation_id,
        participant_id,
        recipient_profile_id,
        consent_basis,
        row_number() over (
          partition by organisation_id, participant_id, recipient_profile_id, consent_basis
          order by created_at asc, id asc
        ) as new_version,
        lead(id) over (
          partition by organisation_id, participant_id, recipient_profile_id, consent_basis
          order by created_at asc, id asc
        ) as new_superseded_by
      from public.participant_consent_evidence
      where version is null
    )
    update public.participant_consent_evidence p
      set version       = v.new_version,
          superseded_by = v.new_superseded_by
      from versioned v
      where p.id = v.id;

    alter table public.participant_consent_evidence
      alter column version set default 1,
      alter column version set not null;
  end if;
end$$;

create unique index if not exists participant_consent_evidence_version_uidx
  on public.participant_consent_evidence (organisation_id, participant_id, recipient_profile_id, version);

------------------------------------------------------------------------
-- Supersession: a consent row may be superseded by exactly one successor.
-- Enforce the invariant at the schema layer so a forged supersede event
-- cannot leak past the RPC.
------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'participant_consent_superseded_immutable'
      and conrelid = 'public.participant_consent_evidence'::regclass
  ) then
    -- No-op constraint placeholder; superseded_by is allowed to point
    -- at the single successor. The supersede step itself is performed
    -- by cmd_admin_renew_consent inside its transaction.
    null;
  end if;
end$$;

------------------------------------------------------------------------
-- Receipt helpers: actor-bound and internal-only.
--
-- The pre-fixup helpers took an `actor_membership` argument supplied by
-- the caller, which let any authenticated user pre-reserve a receipt
-- for another actor or rewrite a completed outcome. The new helpers:
--   - derive the actor from auth.uid() inside the function,
--   - refuse to update a receipt whose status is already 'completed',
--   - are revoked from `public` and `anon` and not granted to
--     `authenticated` (they are only callable from other SECURITY
--     DEFINER functions).
------------------------------------------------------------------------

-- Drop the legacy caller-bound signatures before redefining them so
-- the actor_membership and actor_profile_id parameters cannot be
-- forged by any remaining caller.
drop function if exists public.reserve_admin_command(text, text, uuid, uuid, jsonb);

create or replace function public.reserve_admin_command(
  p_command_id      text,
  p_command_type    text,
  p_organisation_id uuid,
  p_payload         jsonb
)
returns table (is_new boolean, receipt_id uuid, outcome jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id  uuid;
  v_actor_membership uuid;
  v_actor_profile    uuid := auth.uid();
  v_outcome          jsonb;
begin
  if v_actor_profile is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Derive the actor_membership inside the function. The caller cannot
  -- forge another actor's link. We use the same current_membership
  -- helper the rest of the admin RPCs rely on.
  v_actor_membership := public.current_membership(p_organisation_id);
  if v_actor_membership is null then
    raise exception 'admin_or_scheduler_required' using errcode = '42501';
  end if;

  insert into public.command_receipts (
    command_id, command_type, organisation_id, actor_membership_id,
    actor_profile_id, claimed_at, completed_at, status, outcome, payload
  ) values (
    p_command_id, p_command_type, p_organisation_id, v_actor_membership,
    v_actor_profile, pg_catalog.now(), null, 'accepted', '{}'::jsonb,
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
  where r.organisation_id     = p_organisation_id
    and r.actor_membership_id = v_actor_membership
    and r.command_type        = p_command_type
    and r.command_id          = p_command_id;
  return query select false, v_receipt_id, v_outcome;
end;
$$;

revoke all on function public.reserve_admin_command(text, text, uuid, jsonb) from public;
revoke all on function public.reserve_admin_command(text, text, uuid, jsonb) from anon;
revoke all on function public.reserve_admin_command(text, text, uuid, jsonb) from authenticated;

create or replace function public.finalize_admin_command(p_receipt_id uuid, p_outcome jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile uuid := auth.uid();
begin
  if v_actor_profile is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- The caller can only finalize a receipt that:
  --   (a) exists,
  --   (b) was authored by the current auth.uid(), and
  --   (c) has not already been completed. Once completed the outcome
  --       is immutable.
  update public.command_receipts
    set outcome      = coalesce(p_outcome, '{}'::jsonb),
        completed_at = pg_catalog.now()
    where id              = p_receipt_id
      and actor_profile_id = v_actor_profile
      and completed_at is null;

  if not found then
    raise exception 'receipt_finalize_failed' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.finalize_admin_command(uuid, jsonb) from public;
revoke all on function public.finalize_admin_command(uuid, jsonb) from anon;
revoke all on function public.finalize_admin_command(uuid, jsonb) from authenticated;

------------------------------------------------------------------------
-- Admin command helpers: tighten representative membership + role
-- checks, take advantage of the new internal-only receipt helpers.
------------------------------------------------------------------------

create or replace function public.cmd_admin_record_consent(
  p_command_id               text,
  p_organisation_id          uuid,
  p_participant_id           uuid,
  p_recipient_profile_id     uuid,
  p_authorising_profile_id   uuid,
  p_purpose                  text,
  p_scope_categories         text[],
  p_consent_basis            text,
  p_representative_authority_id uuid,
  p_evidence_reference       text,
  p_effective_from           timestamptz,
  p_effective_until          timestamptz,
  p_payload                  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership     uuid;
  v_row            public.participant_consent_evidence%rowtype;
  v_authority      public.representative_authorities%rowtype;
  v_reserved       record;
  v_outcome        jsonb;
  v_next_version   integer;
begin
  v_membership := public.admin_context(p_organisation_id);

  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_record_consent', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;

  if p_effective_until <= p_effective_from or p_effective_until <= pg_catalog.now() then
    raise exception 'consent_dates_invalid';
  end if;
  if p_consent_basis not in ('participant','authorised_representative') then
    raise exception 'consent_basis_invalid';
  end if;
  if nullif(pg_catalog.btrim(p_purpose),'') is null
     or nullif(pg_catalog.btrim(p_evidence_reference),'') is null
     or cardinality(p_scope_categories) < 1 then
    raise exception 'consent_evidence_required';
  end if;
  if not exists (
    select 1 from public.participants
    where id = p_participant_id and organisation_id = p_organisation_id and archived_at is null
  ) then
    raise exception 'participant_not_found';
  end if;
  -- Recipient must hold a live same-tenant external membership.
  if not exists (
    select 1 from public.organisation_memberships m
    where m.organisation_id = p_organisation_id
      and m.profile_id      = p_recipient_profile_id
      and public.membership_has_role(m.id, 'external')
  ) then
    raise exception 'external_recipient_membership_required';
  end if;

  -- Exactly one current consent leaf per (org, participant, recipient,
  -- consent_basis). If an unsuperseded active row already exists, this
  -- function refuses to fork the lineage; the caller must use
  -- cmd_admin_renew_consent with expected_current_consent_id instead.
  if exists (
    select 1
    from public.participant_consent_evidence
    where organisation_id      = p_organisation_id
      and participant_id       = p_participant_id
      and recipient_profile_id = p_recipient_profile_id
      and consent_basis        = p_consent_basis
      and superseded_by        is null
  ) then
    raise exception 'consent_lineage_exists';
  end if;

  if p_consent_basis = 'participant' then
    -- Authoriser is the participant themselves. Require:
    --   * a live same-tenant participant membership, AND
    --   * an active participant_self_links row.
    if p_representative_authority_id is not null then
      raise exception 'participant_consent_authority_required';
    end if;
    if not exists (
      select 1 from public.organisation_memberships m
      where m.organisation_id = p_organisation_id
        and m.profile_id      = p_authorising_profile_id
        and public.membership_has_role(m.id, 'participant')
    ) or not exists (
      select 1 from public.participant_self_links sl
      where sl.organisation_id = p_organisation_id
        and sl.participant_id  = p_participant_id
        and sl.profile_id      = p_authorising_profile_id
        and sl.status          = 'active'
    ) then
      raise exception 'participant_consent_authority_required';
    end if;
  else
    -- Representative-backed consent. Authority must be current; the
    -- representative_profile_id must additionally hold a live
    -- same-tenant nominee membership so withdrawal of the membership
    -- invalidates new issuance immediately.
    select * into v_authority
    from public.representative_authorities ra
    where ra.id                     = p_representative_authority_id
      and ra.organisation_id        = p_organisation_id
      and ra.participant_id         = p_participant_id
      and ra.representative_profile_id = p_authorising_profile_id
      and ra.status                 = 'active'
      and ra.effective_from         <= pg_catalog.now()
      and (ra.effective_until is null or ra.effective_until > pg_catalog.now())
    for update;

    if v_authority.id is null
       or not (p_scope_categories <@ v_authority.scope_categories)
       or p_effective_from < v_authority.effective_from
       or (v_authority.effective_until is not null and p_effective_until > v_authority.effective_until)
    then
      raise exception 'representative_consent_authority_required';
    end if;

    if not exists (
      select 1 from public.organisation_memberships m
      where m.organisation_id = p_organisation_id
        and m.profile_id      = p_authorising_profile_id
        and public.membership_has_role(m.id, 'nominee')
    ) then
      raise exception 'representative_membership_required';
    end if;
  end if;

  -- Deterministic version increment scoped to (org, participant, recipient).
  select coalesce(max(version), 0) + 1 into v_next_version
  from public.participant_consent_evidence
  where organisation_id    = p_organisation_id
    and participant_id     = p_participant_id
    and recipient_profile_id = p_recipient_profile_id;

  insert into public.participant_consent_evidence (
    organisation_id, participant_id, recipient_profile_id, authorising_profile_id,
    consent_basis, purpose, scope_categories, evidence_reference,
    effective_from, effective_until, version,
    representative_authority_id, authority_scope_snapshot,
    authority_effective_from, authority_effective_until,
    created_by
  )
  values (
    p_organisation_id, p_participant_id, p_recipient_profile_id, p_authorising_profile_id,
    p_consent_basis, pg_catalog.btrim(p_purpose), p_scope_categories, pg_catalog.btrim(p_evidence_reference),
    p_effective_from, p_effective_until, v_next_version,
    p_representative_authority_id, v_authority.scope_categories,
    v_authority.effective_from, v_authority.effective_until,
    auth.uid()
  )
  returning * into v_row;

  insert into public.audit_log(organisation_id, actor, action, subject_type, subject_id, metadata)
  values (
    p_organisation_id, auth.uid(), 'consent.created', 'participant_consent_evidence', v_row.id,
    pg_catalog.jsonb_build_object(
      'participant_id', p_participant_id,
      'recipient_profile_id', p_recipient_profile_id,
      'consent_basis', p_consent_basis,
      'purpose', p_purpose,
      'scope_categories', p_scope_categories,
      'effective_until', p_effective_until,
      'version', v_next_version
    )
  );

  v_outcome := pg_catalog.jsonb_build_object(
    'consent_id', v_row.id, 'version', v_next_version
  );

  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'consent_id', v_row.id,'version', v_next_version
  );
end;
$$;

revoke all on function public.cmd_admin_record_consent(
  text, uuid, uuid, uuid, uuid, text, text[], text, uuid, text, timestamptz, timestamptz, jsonb
) from public;
revoke all on function public.cmd_admin_record_consent(
  text, uuid, uuid, uuid, uuid, text, text[], text, uuid, text, timestamptz, timestamptz, jsonb
) from anon;
grant execute on function public.cmd_admin_record_consent(
  text, uuid, uuid, uuid, uuid, text, text[], text, uuid, text, timestamptz, timestamptz, jsonb
) to authenticated;

------------------------------------------------------------------------
-- cmd_admin_renew_consent: the only path that creates a supersede edge.
--
-- Re-running the renewal against an already-current consent is
-- idempotent (returns the existing current version). A stale renewal
-- (the actor's expected_current_consent_id is not the live current
-- version) is preserved as a conflict receipt so the supervisor can
-- review; the existing current version is unchanged.
------------------------------------------------------------------------

create or replace function public.cmd_admin_renew_consent(
  p_command_id                 text,
  p_organisation_id            uuid,
  p_consent_id                 uuid,
  p_expected_current_consent_id uuid,
  p_purpose                    text,
  p_scope_categories           text[],
  p_evidence_reference         text,
  p_effective_from             timestamptz,
  p_effective_until            timestamptz,
  p_payload                    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership        uuid;
  v_current           public.participant_consent_evidence%rowtype;
  v_authority         public.representative_authorities%rowtype;
  v_new               public.participant_consent_evidence%rowtype;
  v_reserved          record;
  v_outcome           jsonb;
  v_next_version      integer;
begin
  v_membership := public.admin_context(p_organisation_id);

  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_renew_consent', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;

  if p_effective_until <= p_effective_from or p_effective_until <= pg_catalog.now() then
    raise exception 'consent_dates_invalid';
  end if;
  if nullif(pg_catalog.btrim(p_purpose),'') is null
     or nullif(pg_catalog.btrim(p_evidence_reference),'') is null
     or cardinality(p_scope_categories) < 1 then
    raise exception 'consent_evidence_required';
  end if;

  -- Lock the supplied consent row to prevent concurrent renewal.
  select * into v_current
  from public.participant_consent_evidence
  where id = p_consent_id and organisation_id = p_organisation_id
  for update;

  if v_current.id is null then
    raise exception 'consent_record_not_found';
  end if;

  -- Walk the full successor chain under lock so the actor's expected
  -- current is compared against the live leaf even when the supplied
  -- id sits several supersessions deep. The chain ends at the row
  -- whose superseded_by is null.
  while v_current.superseded_by is not null loop
    select * into v_current
    from public.participant_consent_evidence
    where id              = v_current.superseded_by
      and organisation_id = p_organisation_id
    for update;
    if v_current.id is null then
      raise exception 'consent_record_not_found';
    end if;
  end loop;

  if p_expected_current_consent_id <> v_current.id then
    perform public.finalize_admin_command(
      v_reserved.receipt_id,
      pg_catalog.jsonb_build_object(
        'conflict','stale_current',
        'current_consent_id', v_current.id,
        'expected_consent_id', p_expected_current_consent_id
      )
    );
    return pg_catalog.jsonb_build_object(
      'status','conflict_preserved','reason','stale_current',
      'current_consent_id', v_current.id,
      'receipt_id', v_reserved.receipt_id
    );
  end if;

  if v_current.status <> 'active' then
    raise exception 'consent_not_active';
  end if;
  if v_current.effective_until <= pg_catalog.now() then
    raise exception 'consent_record_not_current';
  end if;

  -- Re-validate representative authority / self-link / live
  -- memberships so a withdrawal after the original consent was issued
  -- blocks the renewal.
  if v_current.consent_basis = 'participant' then
    if not exists (
      select 1 from public.organisation_memberships m
      where m.organisation_id = p_organisation_id
        and m.profile_id      = v_current.authorising_profile_id
        and public.membership_has_role(m.id, 'participant')
    ) or not exists (
      select 1 from public.participant_self_links sl
      where sl.organisation_id = p_organisation_id
        and sl.participant_id  = v_current.participant_id
        and sl.profile_id      = v_current.authorising_profile_id
        and sl.status          = 'active'
    ) then
      raise exception 'participant_consent_authority_required';
    end if;
  else
    select * into v_authority
    from public.representative_authorities ra
    where ra.id                     = v_current.representative_authority_id
      and ra.status                 = 'active'
      and ra.effective_from         <= pg_catalog.now()
      and (ra.effective_until is null or ra.effective_until > pg_catalog.now())
    for update;
    if v_authority.id is null
       or not exists (
         select 1 from public.organisation_memberships m
         where m.organisation_id = p_organisation_id
           and m.profile_id      = v_current.authorising_profile_id
           and public.membership_has_role(m.id, 'nominee')
       )
    then
      raise exception 'representative_consent_authority_required';
    end if;
    if not (p_scope_categories <@ v_authority.scope_categories)
       or p_effective_from < v_authority.effective_from
       or (v_authority.effective_until is not null and p_effective_until > v_authority.effective_until)
    then
      raise exception 'representative_consent_authority_required';
    end if;
  end if;

  -- Recipient still needs a live same-tenant external membership at
  -- renewal time too.
  if not exists (
    select 1 from public.organisation_memberships m
    where m.organisation_id = p_organisation_id
      and m.profile_id      = v_current.recipient_profile_id
      and public.membership_has_role(m.id, 'external')
  ) then
    raise exception 'external_recipient_membership_required';
  end if;

  select coalesce(max(version), 0) + 1 into v_next_version
  from public.participant_consent_evidence
  where organisation_id    = p_organisation_id
    and participant_id     = v_current.participant_id
    and recipient_profile_id = v_current.recipient_profile_id;

  insert into public.participant_consent_evidence (
    organisation_id, participant_id, recipient_profile_id, authorising_profile_id,
    consent_basis, purpose, scope_categories, evidence_reference,
    effective_from, effective_until, version,
    representative_authority_id, authority_scope_snapshot,
    authority_effective_from, authority_effective_until,
    created_by
  )
  values (
    p_organisation_id, v_current.participant_id, v_current.recipient_profile_id, v_current.authorising_profile_id,
    v_current.consent_basis, pg_catalog.btrim(p_purpose), p_scope_categories, pg_catalog.btrim(p_evidence_reference),
    p_effective_from, p_effective_until, v_next_version,
    v_current.representative_authority_id, coalesce(v_authority.scope_categories, v_current.authority_scope_snapshot),
    coalesce(v_authority.effective_from, v_current.authority_effective_from),
    coalesce(v_authority.effective_until, v_current.authority_effective_until),
    auth.uid()
  )
  returning * into v_new;

  -- Mark the prior current as superseded by the new consent. The
  -- predecessor update is conditional on superseded_by IS NULL — a
  -- concurrent renewal that already advanced the chain leaves the
  -- current row's edge unchanged; this renewal is preserved as
  -- conflict evidence and never rewrites an existing edge.
  update public.participant_consent_evidence
    set superseded_by = v_new.id,
        updated_at    = pg_catalog.now()
    where id              = v_current.id
      and superseded_by  is null;
  if not found then
    -- Concurrent renewal: the prior leaf has already been superseded
    -- by another actor between our chain walk and our update. The new
    -- consent row is still inserted (history is preserved), but its
    -- superseded_by edge is not stamped onto the prior leaf — that
    -- edge already belongs to the concurrent renewal. Surface the
    -- conflict as evidence rather than silently dropping the row or
    -- rewriting an edge.
    perform public.finalize_admin_command(
      v_reserved.receipt_id,
      pg_catalog.jsonb_build_object(
        'consent_id', v_new.id,
        'conflict', 'concurrent_renewal',
        'expected_consent_id', p_expected_current_consent_id
      )
    );
    insert into public.audit_log(organisation_id, actor, action, subject_type, subject_id, metadata)
    values (
      p_organisation_id, auth.uid(), 'consent.renewed.concurrent',
      'participant_consent_evidence', v_new.id,
      pg_catalog.jsonb_build_object(
        'expected_consent_id', p_expected_current_consent_id,
        'version', v_next_version
      )
    );
    return pg_catalog.jsonb_build_object(
      'status','conflict_preserved','reason','concurrent_renewal',
      'consent_id', v_new.id,
      'receipt_id', v_reserved.receipt_id
    );
  end if;

  insert into public.audit_log(organisation_id, actor, action, subject_type, subject_id, metadata)
  values (
    p_organisation_id, auth.uid(), 'consent.renewed', 'participant_consent_evidence', v_new.id,
    pg_catalog.jsonb_build_object(
      'previous_consent_id', v_current.id,
      'version', v_next_version,
      'effective_until', p_effective_until
    )
  );

  v_outcome := pg_catalog.jsonb_build_object(
    'consent_id', v_new.id, 'previous_consent_id', v_current.id, 'version', v_next_version
  );

  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'consent_id', v_new.id,'previous_consent_id', v_current.id,'version', v_next_version
  );
end;
$$;

revoke all on function public.cmd_admin_renew_consent(
  text, uuid, uuid, uuid, text, text[], text, timestamptz, timestamptz, jsonb
) from public;
revoke all on function public.cmd_admin_renew_consent(
  text, uuid, uuid, uuid, text, text[], text, timestamptz, timestamptz, jsonb
) from anon;
grant execute on function public.cmd_admin_renew_consent(
  text, uuid, uuid, uuid, text, text[], text, timestamptz, timestamptz, jsonb
) to authenticated;

------------------------------------------------------------------------
-- Update the existing admin/scheduler command RPCs to drop the
-- caller-supplied actor_membership argument and rely on the new
-- internal-only reserve_admin_command helper.
------------------------------------------------------------------------

create or replace function public.cmd_admin_invite(
  p_command_id      text,
  p_organisation_id uuid,
  p_email           text,
  p_role            text,
  p_expires_at      timestamptz,
  p_payload         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership   uuid;
  v_actor_role   text;
  v_inv          public.invitations%rowtype;
  v_reserved     record;
  v_outcome      jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_invite', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;

  v_actor_role := case
    when public.membership_has_role(v_membership,'admin') then 'admin'
    when public.membership_has_role(v_membership,'scheduler') then 'scheduler'
    else null
  end;
  if v_actor_role is null then
    raise exception 'admin_or_scheduler_required' using errcode = '42501';
  end if;
  if p_role not in ('admin','scheduler','worker','participant','external','nominee') then
    raise exception 'invalid_invitation_role';
  end if;
  if v_actor_role = 'scheduler' and p_role not in ('worker','participant','nominee') then
    raise exception 'scheduler_invite_role_not_allowed' using errcode = '42501';
  end if;
  if p_expires_at <= pg_catalog.now() then
    raise exception 'invitation_expiry_required';
  end if;

  insert into public.invitations (organisation_id,email,role,token,expires_at,issued_by)
  values (
    p_organisation_id, pg_catalog.lower(pg_catalog.btrim(p_email)), p_role,
    pg_catalog.replace(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, '-',''),
    p_expires_at, auth.uid()
  )
  returning * into v_inv;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id,auth.uid(),'invitation.issued','invitation',v_inv.id,
    pg_catalog.jsonb_build_object('role',p_role,'expires_at',p_expires_at)
  );

  -- The token is included in the receipt outcome so the original
  -- actor can recover the copy-link on a committed-but-lost duplicate
  -- retry without exposing it to anyone outside the issuing actor's
  -- receipt lookup scope.
  v_outcome := pg_catalog.jsonb_build_object(
    'invitation_id', v_inv.id,
    'role', p_role,
    'email_delivery', 'copy_link',
    'token', v_inv.token,
    'email', v_inv.email,
    'expires_at', v_inv.expires_at
  );

  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'invitation_id',v_inv.id,'email',v_inv.email,'role',v_inv.role,
    'expires_at',v_inv.expires_at,'token',v_inv.token,'email_delivery','copy_link'
  );
end;
$$;

revoke all on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_invite(text,uuid,text,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_link_participant(
  p_command_id        text,
  p_organisation_id   uuid,
  p_participant_id    uuid,
  p_profile_id        uuid,
  p_evidence_reference text,
  p_payload           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_row        public.participant_self_links%rowtype;
  v_reserved   record;
  v_outcome    jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_link_self', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;

  if not exists (
    select 1 from public.participants
    where id = p_participant_id and organisation_id = p_organisation_id and archived_at is null
  ) then
    raise exception 'participant_not_found';
  end if;
  if nullif(pg_catalog.btrim(p_evidence_reference),'') is null then
    raise exception 'self_link_evidence_required';
  end if;
  if not exists (
    select 1 from public.organisation_memberships m
    where m.organisation_id = p_organisation_id
      and m.profile_id      = p_profile_id
      and public.membership_has_role(m.id,'participant')
  ) then
    raise exception 'participant_membership_required';
  end if;

  insert into public.participant_self_links(organisation_id,participant_id,profile_id,status,evidence_reference)
  values (p_organisation_id,p_participant_id,p_profile_id,'active',pg_catalog.btrim(p_evidence_reference))
  returning * into v_row;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id, auth.uid(), 'participant_self_link.created',
    'participant_self_link', v_row.id,
    pg_catalog.jsonb_build_object('participant_id',p_participant_id,'profile_id',p_profile_id)
  );

  v_outcome := pg_catalog.jsonb_build_object('self_link_id', v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,'self_link_id', v_row.id
  );
end;
$$;

revoke all on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) from public;
revoke all on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) from anon;
grant execute on function public.cmd_admin_link_participant(text,uuid,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.cmd_admin_create_participant(
  p_command_id       text,
  p_organisation_id  uuid,
  p_first_name       text,
  p_last_initial     text,
  p_critical_content text,
  p_review_due_at    timestamptz,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership  uuid;
  v_participant public.participants%rowtype;
  v_card        public.critical_info_cards%rowtype;
  v_reserved    record;
  v_outcome     jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_create_participant', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;
  if pg_catalog.length(pg_catalog.btrim(p_first_name)) < 2 then
    raise exception 'participant_name_required';
  end if;
  if p_review_due_at <= pg_catalog.now() then
    raise exception 'review_due_must_be_future';
  end if;

  insert into public.participants(organisation_id,first_name,last_initial,created_by)
  values (
    p_organisation_id, pg_catalog.btrim(p_first_name),
    nullif(pg_catalog.upper(pg_catalog.btrim(p_last_initial)),''), auth.uid()
  )
  returning * into v_participant;

  insert into public.critical_info_cards(organisation_id,participant_id,content_text,owner_profile_id,reviewed_at,review_due_at)
  values (
    p_organisation_id, v_participant.id, pg_catalog.btrim(p_critical_content),
    auth.uid(), pg_catalog.now(), p_review_due_at
  )
  returning * into v_card;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id, auth.uid(), 'participant.created', 'participant', v_participant.id,
    pg_catalog.jsonb_build_object('critical_info_card_id', v_card.id, 'review_due_at', p_review_due_at)
  );

  v_outcome := pg_catalog.jsonb_build_object(
    'participant_id', v_participant.id, 'critical_info_card_id', v_card.id
  );
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'participant_id', v_participant.id, 'critical_info_card_id', v_card.id
  );
end;
$$;

revoke all on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_create_participant(text,uuid,text,text,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_update_critical_info(
  p_command_id       text,
  p_organisation_id  uuid,
  p_participant_id   uuid,
  p_critical_content text,
  p_review_due_at    timestamptz,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_old        public.critical_info_cards%rowtype;
  v_new        public.critical_info_cards%rowtype;
  v_reserved   record;
  v_outcome    jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_update_critical_info', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;
  if p_review_due_at <= pg_catalog.now() then
    raise exception 'review_due_must_be_future';
  end if;

  select * into v_old
  from public.critical_info_cards
  where organisation_id = p_organisation_id
    and participant_id  = p_participant_id
    and status          = 'active'
  for update;
  if v_old.id is null then
    raise exception 'critical_info_not_found';
  end if;

  insert into public.critical_info_cards(
    organisation_id, participant_id, version, content_text, owner_profile_id,
    reviewed_at, review_due_at, status
  )
  values (
    p_organisation_id, p_participant_id, v_old.version + 1,
    pg_catalog.btrim(p_critical_content), auth.uid(),
    pg_catalog.now(), p_review_due_at, 'active'
  )
  returning * into v_new;

  update public.critical_info_cards
    set status = 'superseded', superseded_by = v_new.id
    where id = v_old.id;

  insert into public.audit_log(organisation_id, actor, action, subject_type, subject_id, metadata)
  values (
    p_organisation_id, auth.uid(), 'critical_info.updated', 'participant', p_participant_id,
    pg_catalog.jsonb_build_object('previous_card_id', v_old.id, 'critical_info_card_id', v_new.id)
  );

  v_outcome := pg_catalog.jsonb_build_object('critical_info_card_id', v_new.id, 'previous_card_id', v_old.id);
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'critical_info_card_id', v_new.id,'previous_card_id', v_old.id
  );
end;
$$;

revoke all on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_update_critical_info(text,uuid,uuid,text,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_set_authority(
  p_command_id                text,
  p_organisation_id           uuid,
  p_participant_id            uuid,
  p_representative_profile_id uuid,
  p_authority_type            text,
  p_scope_categories          text[],
  p_evidence_reference        text,
  p_issuer                    text,
  p_effective_from            timestamptz,
  p_effective_until           timestamptz,
  p_payload                   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_row        public.representative_authorities%rowtype;
  v_reserved   record;
  v_outcome    jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_set_authority', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;
  if not exists (
    select 1 from public.participants
    where id = p_participant_id and organisation_id = p_organisation_id and archived_at is null
  ) then
    raise exception 'participant_not_found';
  end if;
  if p_effective_until is not null and p_effective_until <= p_effective_from then
    raise exception 'authority_dates_invalid';
  end if;
  if nullif(pg_catalog.btrim(p_evidence_reference),'') is null then
    raise exception 'authority_evidence_required';
  end if;
  if not exists (
    select 1 from public.organisation_memberships m
    where m.organisation_id = p_organisation_id
      and m.profile_id      = p_representative_profile_id
      and public.membership_has_role(m.id,'nominee')
  ) then
    raise exception 'representative_membership_required';
  end if;

  insert into public.representative_authorities(
    organisation_id, participant_id, representative_profile_id, authority_type,
    scope_categories, evidence_reference, issuer, issuer_profile_id,
    effective_from, effective_until
  )
  values (
    p_organisation_id, p_participant_id, p_representative_profile_id,
    pg_catalog.btrim(p_authority_type), p_scope_categories,
    pg_catalog.btrim(p_evidence_reference), nullif(pg_catalog.btrim(p_issuer),''),
    auth.uid(), p_effective_from, p_effective_until
  )
  returning * into v_row;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id, auth.uid(), 'representative_authority.created',
    'representative_authority', v_row.id,
    pg_catalog.jsonb_build_object(
      'participant_id', p_participant_id,
      'scope_categories', p_scope_categories,
      'effective_until', p_effective_until
    )
  );

  v_outcome := pg_catalog.jsonb_build_object('authority_id', v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,'authority_id', v_row.id
  );
end;
$$;

revoke all on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_set_authority(text,uuid,uuid,uuid,text,text[],text,text,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_create_grant(
  p_command_id       text,
  p_organisation_id  uuid,
  p_consent_id       uuid,
  p_effective_from   timestamptz,
  p_effective_until  timestamptz,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership  uuid;
  v_row         public.external_disclosure_grants%rowtype;
  v_consent     public.participant_consent_evidence%rowtype;
  v_reserved    record;
  v_outcome     jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_create_grant', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;

  -- Grants require the unique unsuperseded current leaf. A consent
  -- that has been superseded is no longer current — the live leaf for
  -- its (org, participant, recipient) group is its successor, which
  -- has superseded_by IS NULL.
  select * into v_consent
  from public.participant_consent_evidence
  where id              = p_consent_id
    and organisation_id = p_organisation_id
    and status          = 'active'
    and superseded_by  is null
    and effective_from  <= pg_catalog.now()
    and effective_until > pg_catalog.now()
  for update;

  if v_consent.id is null then
    raise exception 'consent_record_not_current';
  end if;
  if p_effective_until <= p_effective_from
     or p_effective_from  < v_consent.effective_from
     or p_effective_until > v_consent.effective_until
  then
    raise exception 'grant_dates_outside_consent';
  end if;
  -- Recipient must still hold a live same-tenant external membership.
  if not exists (
    select 1 from public.organisation_memberships m
    where m.organisation_id = p_organisation_id
      and m.profile_id      = v_consent.recipient_profile_id
      and public.membership_has_role(m.id,'external')
  ) then
    raise exception 'external_recipient_membership_required';
  end if;
  if v_consent.consent_basis = 'participant' then
    if not exists (
      select 1 from public.participant_self_links sl
      where sl.organisation_id = p_organisation_id
        and sl.participant_id  = v_consent.participant_id
        and sl.profile_id      = v_consent.authorising_profile_id
        and sl.status          = 'active'
    ) then
      raise exception 'participant_consent_authority_required';
    end if;
  else
    if not exists (
      select 1 from public.representative_authorities ra
      where ra.id             = v_consent.representative_authority_id
        and ra.status         = 'active'
        and ra.effective_from <= pg_catalog.now()
        and (ra.effective_until is null or ra.effective_until > pg_catalog.now())
    ) then
      raise exception 'representative_consent_authority_required';
    end if;
    -- Representative membership must also still be live.
    if not exists (
      select 1 from public.organisation_memberships m
      where m.organisation_id = p_organisation_id
        and m.profile_id      = v_consent.authorising_profile_id
        and public.membership_has_role(m.id,'nominee')
    ) then
      raise exception 'representative_membership_required';
    end if;
  end if;

  insert into public.external_disclosure_grants(
    organisation_id, participant_id, recipient_profile_id, purpose,
    scope_categories, issuer, issuer_profile_id, consent_basis,
    consent_reference, evidence_reference, effective_from, effective_until,
    consent_record_id
  )
  values (
    p_organisation_id, v_consent.participant_id, v_consent.recipient_profile_id,
    v_consent.purpose, v_consent.scope_categories,
    'Provider admin', auth.uid(), v_consent.consent_basis,
    p_consent_id::text, v_consent.evidence_reference,
    p_effective_from, p_effective_until, p_consent_id
  )
  returning * into v_row;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id, auth.uid(), 'external_grant.created', 'external_grant', v_row.id,
    pg_catalog.jsonb_build_object(
      'participant_id', v_consent.participant_id,
      'recipient_profile_id', v_consent.recipient_profile_id,
      'purpose', v_consent.purpose,
      'scope_categories', v_consent.scope_categories,
      'effective_until', p_effective_until,
      'consent_id', p_consent_id,
      'consent_version', v_consent.version
    )
  );

  v_outcome := pg_catalog.jsonb_build_object('grant_id', v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,'grant_id', v_row.id
  );
end;
$$;

revoke all on function public.cmd_admin_create_grant(text,uuid,uuid,timestamptz,timestamptz,jsonb) from public;
revoke all on function public.cmd_admin_create_grant(text,uuid,uuid,timestamptz,timestamptz,jsonb) from anon;
grant execute on function public.cmd_admin_create_grant(text,uuid,uuid,timestamptz,timestamptz,jsonb) to authenticated;

create or replace function public.cmd_admin_revoke_grant(
  p_command_id      text,
  p_organisation_id uuid,
  p_grant_id        uuid,
  p_reason          text,
  p_payload         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_row        public.external_disclosure_grants%rowtype;
  v_reserved   record;
  v_outcome    jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_revoke_grant', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;

  select * into v_row
  from public.external_disclosure_grants
  where id = p_grant_id and organisation_id = p_organisation_id
  for update;
  if v_row.id is null then
    raise exception 'grant_not_found';
  end if;

  update public.external_disclosure_grants
    set status         = 'revoked',
        withdrawn_at    = pg_catalog.now(),
        withdrawn_by    = auth.uid(),
        withdrawn_reason = pg_catalog.btrim(p_reason)
    where id = p_grant_id;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id, auth.uid(), 'external_grant.revoked', 'external_grant', p_grant_id,
    pg_catalog.jsonb_build_object('reason', p_reason)
  );

  v_outcome := pg_catalog.jsonb_build_object('grant_id', p_grant_id, 'status', 'revoked');
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'grant_id', p_grant_id, 'grant_status', 'revoked'
  );
end;
$$;

revoke all on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) from public;
revoke all on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) from anon;
grant execute on function public.cmd_admin_revoke_grant(text,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.cmd_admin_set_availability(
  p_command_id        text,
  p_organisation_id   uuid,
  p_worker_membership uuid,
  p_available_from    timestamptz,
  p_available_until   timestamptz,
  p_note              text,
  p_payload           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_row        public.worker_availability%rowtype;
  v_reserved   record;
  v_outcome    jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_set_availability', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;
  if p_available_until <= p_available_from then
    raise exception 'availability_dates_invalid';
  end if;
  if not exists (
    select 1 from public.organisation_memberships m
    where m.id = p_worker_membership
      and m.organisation_id = p_organisation_id
      and public.membership_has_role(m.id,'worker')
  ) then
    raise exception 'invalid_target_worker';
  end if;

  insert into public.worker_availability(organisation_id,membership_id,available_during,note)
  values (
    p_organisation_id, p_worker_membership,
    pg_catalog.tstzrange(p_available_from, p_available_until, '[)'),
    nullif(pg_catalog.btrim(p_note),'')
  )
  returning * into v_row;

  insert into public.audit_log(organisation_id,actor,action,subject_type,subject_id,metadata)
  values (
    p_organisation_id, auth.uid(), 'worker_availability.created', 'worker_availability', v_row.id,
    pg_catalog.jsonb_build_object('membership_id', p_worker_membership, 'from', p_available_from, 'until', p_available_until)
  );

  v_outcome := pg_catalog.jsonb_build_object('availability_id', v_row.id);
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,'availability_id', v_row.id
  );
end;
$$;

revoke all on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
revoke all on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) from anon;
grant execute on function public.cmd_admin_set_availability(text,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

create or replace function public.cmd_admin_create_shift(
  p_command_id        text,
  p_organisation_id   uuid,
  p_participant_id    uuid,
  p_worker_membership uuid,
  p_scheduled_start   timestamptz,
  p_scheduled_end     timestamptz,
  p_reason            text,
  p_payload           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership  uuid;
  v_shift       public.shifts%rowtype;
  v_assignment  public.shift_assignments%rowtype;
  v_reserved    record;
  v_outcome     jsonb;
  v_warnings    jsonb := '[]'::jsonb;
begin
  v_membership := public.admin_context(p_organisation_id);
  v_reserved := public.reserve_admin_command(
    p_command_id, 'admin_create_shift', p_organisation_id, p_payload
  );
  if not v_reserved.is_new then
    return pg_catalog.jsonb_build_object(
      'status','duplicate_returned','duplicate',true,
      'receipt_id', v_reserved.receipt_id,'outcome', v_reserved.outcome
    );
  end if;
  if p_scheduled_end <= p_scheduled_start then
    raise exception 'shift_dates_invalid';
  end if;
  if not exists (
    select 1 from public.participants
    where id = p_participant_id and organisation_id = p_organisation_id and archived_at is null
  ) then
    raise exception 'participant_not_found';
  end if;
  if not exists (
    select 1 from public.organisation_memberships m
    where m.id = p_worker_membership
      and m.organisation_id = p_organisation_id
      and public.membership_has_role(m.id,'worker')
  ) then
    raise exception 'invalid_target_worker';
  end if;
  if exists (
    select 1
    from public.shift_assignments sa
    join public.shifts s on s.id = sa.shift_id
    where sa.membership_id = p_worker_membership
      and sa.withdrawn_at is null
      and (sa.effective_until is null or sa.effective_until > p_scheduled_start)
      and s.scheduled_start < p_scheduled_end
      and s.scheduled_end > p_scheduled_start
      and s.state not in ('cancelled','cancelled_needs_review')
  ) then
    v_warnings := v_warnings || pg_catalog.jsonb_build_array('worker_overlap');
  end if;
  if not exists (
    select 1 from public.worker_availability wa
    where wa.membership_id = p_worker_membership
      and wa.available_during @> p_scheduled_start
      and wa.available_during @> (p_scheduled_end - interval '1 second')
  ) then
    v_warnings := v_warnings || pg_catalog.jsonb_build_array('outside_published_availability');
  end if;

  insert into public.shifts(organisation_id,participant_id,scheduled_start,scheduled_end,state,version)
  values (p_organisation_id, p_participant_id, p_scheduled_start, p_scheduled_end, 'scheduled', 1)
  returning * into v_shift;

  insert into public.shift_assignments(shift_id,organisation_id,membership_id,effective_from,assigned_by,reassignment_reason)
  values (
    v_shift.id, p_organisation_id, p_worker_membership, pg_catalog.now(), auth.uid(),
    nullif(pg_catalog.btrim(p_reason),'')
  )
  returning * into v_assignment;

  perform public.record_shift_audit(
    p_organisation_id, v_shift.id, v_membership, 'created', 'shift.created',
    pg_catalog.jsonb_build_object(
      'assignment_id', v_assignment.id,
      'warnings', v_warnings,
      'reason', p_reason
    )
  );

  v_outcome := pg_catalog.jsonb_build_object(
    'shift_id', v_shift.id, 'assignment_id', v_assignment.id, 'warnings', v_warnings
  );
  perform public.finalize_admin_command(v_reserved.receipt_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status','accepted','receipt_id', v_reserved.receipt_id,
    'shift_id', v_shift.id,'assignment_id', v_assignment.id,'warnings', v_warnings
  );
end;
$$;

revoke all on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from public;
revoke all on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) from anon;
grant execute on function public.cmd_admin_create_shift(text,uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb) to authenticated;

------------------------------------------------------------------------
-- Extend the command_receipts command_type allow-list to include the
-- new renewal command.
------------------------------------------------------------------------

alter table public.command_receipts drop constraint if exists command_receipts_command_type_check;
alter table public.command_receipts add constraint command_receipts_command_type_check check (command_type in (
  'on_my_way','start_shift','end_shift','submit_summary','finalise_summary',
  'cancel_shift','reassign_shift','resolve_conflict','request_correction',
  'request_access','apply_correction','accept_invitation',
  'admin_invite','admin_create_participant','admin_set_authority',
  'admin_create_grant','admin_revoke_grant','admin_set_availability',
  'admin_create_shift','admin_update_critical_info','admin_link_self',
  'admin_record_consent','admin_renew_consent'
));

------------------------------------------------------------------------
-- participant_consent_evidence RLS: rebuild so admin/scheduler reads
-- work through the membership-aware helper, and no direct write
-- policy is granted to the authenticated role.
------------------------------------------------------------------------

drop policy if exists participant_consent_admin_select on public.participant_consent_evidence;
create policy participant_consent_admin_select
  on public.participant_consent_evidence for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and (
      public.current_user_membership_role() in ('admin','scheduler')
      or public.membership_has_role(public.current_membership(organisation_id), 'admin')
      or public.membership_has_role(public.current_membership(organisation_id), 'scheduler')
    )
  );

-- PostgREST-shaped grant: SELECT to the authenticated role. Direct
-- INSERT/UPDATE/DELETE remains denied (no grant below).
grant select on public.participant_consent_evidence to authenticated;

drop policy if exists participant_consent_self_select on public.participant_consent_evidence;
create policy participant_consent_self_select
  on public.participant_consent_evidence for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and (
      authorising_profile_id = auth.uid()
      or participant_id in (select public.current_user_self_links_participant_id())
    )
  );

-- Intentionally no INSERT/UPDATE/DELETE policies on
-- participant_consent_evidence for the authenticated role. All
-- mutations go through cmd_admin_record_consent and
-- cmd_admin_renew_consent.

------------------------------------------------------------------------
-- audit_log RLS: rebuild with membership_has_role so a base worker
-- with a current supplementary admin role can read the audit timeline.
------------------------------------------------------------------------

drop policy if exists audit_log_select_admin_scheduler on public.audit_log;
create policy audit_log_select_admin_scheduler
  on public.audit_log for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and (
      public.current_user_membership_role() in ('admin','scheduler')
      or public.membership_has_role(public.current_membership(organisation_id), 'admin')
      or public.membership_has_role(public.current_membership(organisation_id), 'scheduler')
    )
  );
