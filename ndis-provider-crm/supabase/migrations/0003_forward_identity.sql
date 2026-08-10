-- 0003_forward_identity.sql
--
-- Forward identity migration from
--   public.profiles(id, organisation_id, role, ...)
-- to
--   public.global_profiles(id, full_name, email, ...)
--   public.organisation_memberships(organisation_id, profile_id, role, status, ...)
--   public.active_organisation_context(profile_id, organisation_id, ...)
--
-- Per decision-log/2026-08-06 · "Forward identity migration, enrolled offline
-- devices, and retention-policy reset":
--
--   * Preserve auth.users identities (no row is dropped from public.profiles).
--   * Preserve invitation history (no row is dropped from public.invitations).
--   * Preserve audit history (no row is dropped from public.audit_log).
--   * Existing single-organisation rows are migrated forward into a global
--     profile plus one membership per row.
--   * Acceptance moves to a token-bound RPC (cmd_accept_invitation); the
--     AFTER INSERT trigger becomes a fallback for the first sign-in only
--     and no longer matches by email alone.
--   * Old profiles rows become a non-authoritative shadow. They remain
--     addressable by id for rollback checks; authenticated mutation is
--     revoked; legacy org / invitation / audit authorisation that
--     trusted `profiles.role` / `profiles.organisation_id` is replaced.
--
-- Idempotency: every object uses `create or replace` / `drop if exists`
-- patterns, so a re-run is safe and produces the same end state.
--
-- Test plan (local pglite):
--   * Apply 0001 → 0002 → 0003 against the test harness (with stub
--     auth.users + auth.uid()).
--   * Verify: a synthetic pre-migration profile becomes exactly one
--     global_profiles row + exactly one organisation_memberships row,
--     even when the existing audit_log has rows pointing at the legacy
--     profile id (FK repointed only AFTER backfill).
--   * Verify: handle_new_user still creates the missing membership when
--     no token-bound acceptance is possible.
--   * Verify: legacy profile authenticated mutation is denied.

set search_path = public;

------------------------------------------------------------------------
-- 1. global_profiles — display-only identity, 1:1 with auth.users
------------------------------------------------------------------------
-- No organisation, no role. Soft-delete semantics carried over from the
-- legacy profile row so the audit trail and existing helpers keep working.

create table if not exists public.global_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  email       text,
  phone       text,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists global_profiles_email_unique
  on public.global_profiles (lower(email))
  where deleted_at is null and email is not null;

create index if not exists global_profiles_deleted_at_idx
  on public.global_profiles (deleted_at);

drop trigger if exists global_profiles_set_updated_at on public.global_profiles;
create trigger global_profiles_set_updated_at
  before update on public.global_profiles
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 2. organisation_memberships — link a global user to one provider
------------------------------------------------------------------------
-- One row per (organisation, profile). Roles are attached per membership.
-- Multiple active memberships in different orgs allowed; multiple
-- active role rows for the same (org, profile) disallowed — every role
-- is a distinct membership row.

create table if not exists public.organisation_memberships (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  profile_id      uuid not null references public.global_profiles (id) on delete cascade,
  role            text not null check (role in ('admin','scheduler','worker','participant','external','nominee')),
  status          text not null default 'active'
                    check (status in ('active','suspended','withdrawn')),
  effective_from  timestamptz not null default now(),
  effective_until timestamptz,
  withdrawn_at    timestamptz,
  withdrawn_by    uuid references public.global_profiles (id) on delete set null,
  withdrawn_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, profile_id)
);

-- A user has one membership row per organisation. Additional authorities
-- are modelled independently so role changes do not create parallel tenant
-- identities or ambiguous LIMIT 1 role selection.
create table if not exists public.organisation_membership_roles (
  id             uuid primary key default gen_random_uuid(),
  membership_id  uuid not null references public.organisation_memberships (id) on delete cascade,
  role           text not null check (role in ('admin','scheduler','worker','participant','external','nominee')),
  status         text not null default 'active' check (status in ('active','suspended','withdrawn')),
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  created_at     timestamptz not null default now(),
  unique (membership_id, role)
);

insert into public.organisation_membership_roles (membership_id, role, status, effective_from)
select id, role, status, effective_from
from public.organisation_memberships
on conflict (membership_id, role) do nothing;

create index if not exists organisation_membership_roles_lookup_idx
  on public.organisation_membership_roles (membership_id, status, role);

create index if not exists organisation_memberships_org_idx
  on public.organisation_memberships (organisation_id);

create index if not exists organisation_memberships_profile_idx
  on public.organisation_memberships (profile_id);

create index if not exists organisation_memberships_role_idx
  on public.organisation_memberships (organisation_id, role);

create index if not exists organisation_memberships_active_lookup_idx
  on public.organisation_memberships (profile_id, organisation_id)
  where status = 'active'
    and effective_until is null;

drop trigger if exists organisation_memberships_set_updated_at on public.organisation_memberships;
create trigger organisation_memberships_set_updated_at
  before update on public.organisation_memberships
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 3. active_organisation_context — user-chosen membership context
------------------------------------------------------------------------
-- The active context is NEVER used as authorisation by itself; RLS still
-- checks the (org, role) tuple against active membership. The context
-- exists so navigation, command scoping, and visible chrome can show a
-- single provider/participant.

create table if not exists public.active_organisation_context (
  profile_id      uuid primary key references public.global_profiles (id) on delete cascade,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  updated_at      timestamptz not null default now()
);

drop trigger if exists active_organisation_context_set_updated_at on public.active_organisation_context;
create trigger active_organisation_context_set_updated_at
  before update on public.active_organisation_context
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 4. Backfill (must run BEFORE repointing audit FK to global_profiles)
------------------------------------------------------------------------
-- Forward-migrate every existing public.profiles row into a global_profile
-- plus one membership. Idempotent: re-running re-uses existing rows.

create or replace function public.forward_migrate_legacy_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 4a. global_profiles backfill from legacy profiles.
  insert into public.global_profiles (id, full_name, email, deleted_at, created_at, updated_at)
  select
    p.id,
    p.full_name,
    p.email,
    p.deleted_at,
    p.created_at,
    p.updated_at
  from public.profiles p
  on conflict (id) do update
    set full_name = coalesce(public.global_profiles.full_name, excluded.full_name),
        email     = coalesce(public.global_profiles.email, excluded.email),
        updated_at = now();

  -- 4b. organisation_memberships backfill. Withdrawn legacy profiles
  -- produce withdrawn memberships; active legacy profiles produce
  -- active memberships. effective_from = legacy created_at.
  insert into public.organisation_memberships (
    organisation_id, profile_id, role, status, effective_from
  )
  select
    p.organisation_id,
    p.id,
    p.role,
    case when p.deleted_at is null then 'active' else 'withdrawn' end,
    coalesce(p.created_at, now())
  from public.profiles p
  on conflict do nothing;

  -- 4c. Seed active_organisation_context for users with no explicit choice
  -- but at least one active membership. Use the most-recently-active
  -- legacy profile.organisation_id; fall back to the newest active
  -- membership when no non-deleted legacy profile exists.
  insert into public.active_organisation_context (profile_id, organisation_id)
  select p.id, p.organisation_id
  from public.profiles p
  where p.deleted_at is null
    and not exists (
      select 1 from public.active_organisation_context a
      where a.profile_id = p.id
    )
  on conflict (profile_id) do nothing;

  insert into public.active_organisation_context (profile_id, organisation_id)
  select m.profile_id, m.organisation_id
  from public.organisation_memberships m
  where m.status = 'active'
    and not exists (
      select 1 from public.active_organisation_context a
      where a.profile_id = m.profile_id
    )
  on conflict (profile_id) do nothing;
end;
$$;

select public.forward_migrate_legacy_profiles();

revoke all on function public.forward_migrate_legacy_profiles() from public;
grant execute on function public.forward_migrate_legacy_profiles() to service_role;

------------------------------------------------------------------------
-- 5. Repoint audit_log FK (now safe: global_profiles is populated)
------------------------------------------------------------------------
-- The existing audit_log.actor FK points at public.profiles (the legacy
-- single-org table). Drop the legacy FK and add a new FK to
-- global_profiles. Existing rows that referenced auth.users.id (which
-- equals global_profiles.id) continue to satisfy the new constraint.
--
-- If an existing row has an actor uuid that has no matching global_profile
-- (rare — would only happen if audit was written by a process outside
-- the trigger pipeline), the FK add will fail. We surface that as a
-- NOT VALID FK so the constraint exists for new writes while still
-- allowing the migration to apply; a separate statement validates the
-- existing rows once they've been remediated.

do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'audit_log'
      and constraint_name = 'audit_log_actor_fkey'
  ) then
    alter table public.audit_log drop constraint audit_log_actor_fkey;
  end if;
exception when others then
  raise notice 'audit_log FK drop skipped: %', sqlerrm;
end$$;

do $$
begin
  begin
    alter table public.audit_log
      add constraint audit_log_actor_fkey
      foreign key (actor) references public.global_profiles (id) on delete set null
      not valid;
  exception when duplicate_object then
    null;
  end;
end$$;

------------------------------------------------------------------------
-- 6. handle_new_user: still creates a profile + membership for the
-- FIRST sign-in of an auth user who already has a matching invitation,
-- but ONLY when the matching invitation is unambiguous (token-bound
-- acceptance handled in cmd_accept_invitation; this trigger is the
-- safety net for sign-ins that did not go through the invitation flow).
------------------------------------------------------------------------
-- The trigger no longer picks "newest matching invitation by email":
-- instead it leaves acceptance to cmd_accept_invitation and only creates
-- the global_profile shell if absent. Membership creation is left to
-- the RPC.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Ensure the global_profiles shell exists. Memberships are created
  -- explicitly via cmd_accept_invitation.
  insert into public.global_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Trigger was created in 0001; we replaced the function body above. No
-- need to recreate the trigger (create trigger if not exists below is
-- idempotent for a trigger that already exists with the same name).

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'on_auth_user_created'
  ) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end$$;

------------------------------------------------------------------------
-- 7. Token-bound invitation acceptance RPC
------------------------------------------------------------------------
-- Public RPC, called by /invite/[token]/confirm AFTER the user has
-- signed in. Locks the invitation row, validates it, and creates the
-- matching membership (and reactivates / re-creates a global_profile
-- shell if needed). Atomic. Idempotent on retry of the same token +
-- profile.

create or replace function public.cmd_accept_invitation(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_inv      public.invitations;
  v_org_alive boolean;
  v_membership_id uuid;
  v_existing_status text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Lock the invitation row.
  select * into v_inv
  from public.invitations
  where token = p_token
  for update;

  if v_inv.id is null then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'invitation_already_accepted' using errcode = 'P0001';
  end if;

  if v_inv.revoked_at is not null then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  end if;

  if v_inv.expires_at <= now() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  end if;

  select (o.deleted_at is null)
    into v_org_alive
  from public.organisations o
  where o.id = v_inv.organisation_id;

  if v_org_alive is null or v_org_alive = false then
    raise exception 'inviting_organisation_unavailable'
      using errcode = 'P0001';
  end if;

  -- Ensure a global_profile shell exists for this auth user.
  insert into public.global_profiles (id, email)
  values (v_uid, (select email from auth.users where id = v_uid))
  on conflict (id) do nothing;

  -- Create or reuse the single membership row for this organisation.
  insert into public.organisation_memberships (
    organisation_id, profile_id, role, status, effective_from
  )
  values (
    v_inv.organisation_id, v_uid, v_inv.role, 'active', now()
  )
  on conflict (organisation_id, profile_id) do update
    set status = case when public.organisation_memberships.status = 'withdrawn'
                      then 'active' else public.organisation_memberships.status end,
        effective_until = case when public.organisation_memberships.status = 'withdrawn'
                               then null else public.organisation_memberships.effective_until end,
        updated_at = now()
  returning id into v_membership_id;

  -- Grant the invited role separately. Existing memberships may accept a
  -- second role without creating a second tenant membership row.
  insert into public.organisation_membership_roles (membership_id, role, status)
  values (v_membership_id, v_inv.role, 'active')
  on conflict (membership_id, role) do update set status = 'active', effective_until = null;

  -- Seed active_organisation_context if the user has none yet.
  insert into public.active_organisation_context (profile_id, organisation_id)
  values (v_uid, v_inv.organisation_id)
  on conflict (profile_id) do nothing;

  -- Mark the invitation consumed.
  update public.invitations
    set accepted_at = now()
    where id = v_inv.id
      and accepted_at is null;

  -- Audit the acceptance.
  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    v_inv.organisation_id, v_uid, 'invitation.accepted',
    'invitation', v_inv.id,
    jsonb_build_object('email', v_inv.email, 'role', v_inv.role)
  );

  return jsonb_build_object(
    'status','accepted',
    'membership_id', v_membership_id,
    'organisation_id', v_inv.organisation_id,
    'role', v_inv.role
  );
end;
$$;

revoke all on function public.cmd_accept_invitation(text) from public;
grant execute on function public.cmd_accept_invitation(text) to authenticated;

------------------------------------------------------------------------
-- 8. Helpers (membership-aware, all enforcement goes through these)
------------------------------------------------------------------------

-- Current active membership row for the caller, in the named org.
-- Takes live-organisation + effective-period into account. Returns
-- exactly one row (the caller may hold multiple memberships but only
-- the one matching the active context is "current").
create or replace function public.current_membership(
  p_organisation_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.organisation_memberships m
  join public.active_organisation_context a on a.profile_id = m.profile_id
  join public.organisations o on o.id = m.organisation_id
  where m.profile_id = auth.uid()
    and m.organisation_id = p_organisation_id
    and m.status = 'active'
    and m.effective_from <= now()
    and (m.effective_until is null or m.effective_until > now())
    and o.deleted_at is null
  limit 1
$$;

revoke all on function public.current_membership(uuid) from public;
grant execute on function public.current_membership(uuid) to authenticated;

-- Active memberships the caller holds in any organisation (any status,
-- any role). RLS-equivalent safety via SECURITY DEFINER.
create or replace function public.user_memberships()
returns setof public.organisation_memberships
language sql
stable
security definer
set search_path = public
as $$
  select m.*
  from public.organisation_memberships m
  where m.profile_id = auth.uid()
    and m.status = 'active'
    and m.effective_from <= now()
    and (m.effective_until is null or m.effective_until > now())
$$;

revoke all on function public.user_memberships() from public;
grant execute on function public.user_memberships() to authenticated;

-- Current role in the active org (single text, no LIMIT 1 ambiguity).
create or replace function public.current_user_membership_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select r.role
      from public.organisation_membership_roles r
      where r.membership_id = m.id
        and r.status = 'active'
        and r.effective_from <= now()
        and (r.effective_until is null or r.effective_until > now())
      order by case r.role when 'admin' then 1 when 'scheduler' then 2 else 3 end
      limit 1
    ), m.role
  )
  from public.organisation_memberships m
  join public.active_organisation_context a on a.profile_id = m.profile_id
  join public.organisations o on o.id = m.organisation_id
  where m.profile_id = auth.uid()
    and m.organisation_id = a.organisation_id
    and m.status = 'active'
    and m.effective_from <= now()
    and (m.effective_until is null or m.effective_until > now())
    and o.deleted_at is null
$$;

revoke all on function public.current_user_membership_role() from public;
grant execute on function public.current_user_membership_role() to authenticated;

-- Active organisation id for the caller, or null.
create or replace function public.current_active_organisation_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.organisation_id
  from public.active_organisation_context a
  join public.organisations o on o.id = a.organisation_id
  where a.profile_id = auth.uid()
    and o.deleted_at is null
$$;

revoke all on function public.current_active_organisation_id() from public;
grant execute on function public.current_active_organisation_id() to authenticated;

create or replace function public.membership_has_role(
  p_membership_id uuid,
  p_role text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_memberships m
    left join public.organisation_membership_roles r
      on r.membership_id = m.id and r.role = p_role
      and r.status = 'active'
      and r.effective_from <= now()
      and (r.effective_until is null or r.effective_until > now())
    where m.id = p_membership_id
      and m.status = 'active'
      and m.effective_from <= now()
      and (m.effective_until is null or m.effective_until > now())
      and (r.id is not null or not exists (
        select 1 from public.organisation_membership_roles r2 where r2.membership_id = m.id
      ) and m.role = p_role)
  )
$$;

revoke all on function public.membership_has_role(uuid, text) from public;
grant execute on function public.membership_has_role(uuid, text) to authenticated;

-- Has the caller an active membership in the given org? Optional role
-- filter. Takes effective window + live organisation into account.
create or replace function public.user_has_membership(
  p_organisation_id uuid,
  p_role            text default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_memberships m
    join public.organisations o on o.id = m.organisation_id
    where m.organisation_id = p_organisation_id
      and m.profile_id = auth.uid()
      and m.status = 'active'
      and m.effective_from <= now()
      and (m.effective_until is null or m.effective_until > now())
      and o.deleted_at is null
      and (p_role is null or m.role = p_role
           or public.membership_has_role(m.id, p_role))
  )
$$;

revoke all on function public.user_has_membership(uuid, text) from public;
grant execute on function public.user_has_membership(uuid, text) to authenticated;

------------------------------------------------------------------------
-- 9. Remove the legacy self-mutation path on public.profiles
------------------------------------------------------------------------
-- 0002 created profiles_update_own on public.profiles. That policy
-- allowed a worker to UPDATE their own role + organisation_id. Drop
-- it. Authenticated users may not mutate legacy profiles from the
-- client any more; legacy profiles become a non-authoritative shadow.

drop policy if exists profiles_update_own on public.profiles;

-- Replace the legacy organisation/invitation/audit policies that
-- trusted profiles.organisation_id / profiles.role. Those legacy
-- tables are still readable to the same extent the new RLS would
-- allow via global_profiles / organisation_memberships. New code
-- never trusts legacy column values for authorisation.

drop policy if exists organisations_select_member on public.organisations;
create policy organisations_select_member
  on public.organisations for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1
      from public.organisation_memberships m
      where m.organisation_id = public.organisations.id
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
    )
  );

drop policy if exists profiles_select_own_org on public.profiles;
-- No replacement: legacy profile rows are an audit-only shadow.
-- Authorised callers can read global_profiles via its own policies.

drop policy if exists invitations_select_admin_or_scheduler on public.invitations;
create policy invitations_select_admin_or_scheduler
  on public.invitations for select to authenticated
  using (
    exists (
      select 1
      from public.organisation_memberships m
      join public.organisations o on o.id = m.organisation_id
      where m.organisation_id = public.invitations.organisation_id
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
        and o.deleted_at is null
        and (m.role in ('admin', 'scheduler')
             or public.membership_has_role(m.id, 'admin')
             or public.membership_has_role(m.id, 'scheduler'))
    )
  );

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin
  on public.audit_log for select to authenticated
  using (
    exists (
      select 1
      from public.organisation_memberships m
      join public.organisations o on o.id = m.organisation_id
      where m.organisation_id = public.audit_log.organisation_id
        and m.profile_id = auth.uid()
        and m.status = 'active'
        and m.effective_from <= now()
        and (m.effective_until is null or m.effective_until > now())
        and o.deleted_at is null
        and (m.role = 'admin' or public.membership_has_role(m.id, 'admin'))
    )
  );

------------------------------------------------------------------------
-- 10. RLS on the new tables
------------------------------------------------------------------------

alter table public.global_profiles enable row level security;

drop policy if exists global_profiles_select_self on public.global_profiles;
create policy global_profiles_select_self
  on public.global_profiles for select to authenticated
  using (id = auth.uid());

drop policy if exists global_profiles_select_org_mates on public.global_profiles;
create policy global_profiles_select_org_mates
  on public.global_profiles for select to authenticated
  using (
    exists (
      select 1
      from public.organisation_memberships me
      join public.organisation_memberships them
        on them.organisation_id = me.organisation_id
      where me.profile_id = auth.uid()
        and me.status = 'active'
        and me.effective_from <= now()
        and (me.effective_until is null or me.effective_until > now())
        and them.profile_id = public.global_profiles.id
        and them.status = 'active'
        and them.effective_from <= now()
        and (them.effective_until is null or them.effective_until > now())
    )
  );

drop policy if exists global_profiles_update_self on public.global_profiles;
create policy global_profiles_update_self
  on public.global_profiles for update to authenticated
  using (id = auth.uid() and deleted_at is null)
  with check (id = auth.uid() and deleted_at is null);

alter table public.organisation_memberships enable row level security;

drop policy if exists organisation_memberships_select_self on public.organisation_memberships;
create policy organisation_memberships_select_self
  on public.organisation_memberships for select to authenticated
  using (profile_id = auth.uid());

drop policy if exists organisation_memberships_select_org_admin on public.organisation_memberships;
create policy organisation_memberships_select_org_admin
  on public.organisation_memberships for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() = 'admin'
  );

-- INSERT/UPDATE/DELETE on organisation_memberships intentionally not
-- granted. Memberships are created via cmd_accept_invitation and
-- mutated via trusted RPCs in later tickets. "Deny all" is the
-- invariant.

alter table public.active_organisation_context enable row level security;

drop policy if exists active_organisation_context_select_self on public.active_organisation_context;
create policy active_organisation_context_select_self
  on public.active_organisation_context for select to authenticated
  using (profile_id = auth.uid());

drop policy if exists active_organisation_context_write_self on public.active_organisation_context;
create policy active_organisation_context_write_self
  on public.active_organisation_context for insert to authenticated
  with check (profile_id = auth.uid());

drop policy if exists active_organisation_context_update_self on public.active_organisation_context;
create policy active_organisation_context_update_self
  on public.active_organisation_context for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

drop policy if exists active_organisation_context_delete_self on public.active_organisation_context;
create policy active_organisation_context_delete_self
  on public.active_organisation_context for delete to authenticated
  using (profile_id = auth.uid());

------------------------------------------------------------------------
-- 11. set_active_organisation — RPC that validates membership
------------------------------------------------------------------------

create or replace function public.set_active_organisation(p_organisation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_alive boolean;
begin
  select (o.deleted_at is null)
    into v_org_alive
  from public.organisations o
  where o.id = p_organisation_id;

  if v_org_alive is null or v_org_alive = false then
    raise exception 'organisation_not_available' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.organisation_memberships m
    where m.profile_id = auth.uid()
      and m.organisation_id = p_organisation_id
      and m.status = 'active'
      and m.effective_from <= now()
      and (m.effective_until is null or m.effective_until > now())
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  insert into public.active_organisation_context (profile_id, organisation_id)
  values (auth.uid(), p_organisation_id)
  on conflict (profile_id) do update
    set organisation_id = excluded.organisation_id,
        updated_at = now();
end;
$$;

revoke all on function public.set_active_organisation(uuid) from public;
grant execute on function public.set_active_organisation(uuid) to authenticated;
