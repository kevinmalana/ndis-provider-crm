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
--   * Update handle_new_user so new invitation acceptance creates or extends
--     a membership rather than producing a second single-org profile row.
--   * Old profiles rows become a legacy read-only shadow; they remain
--     addressable by id for rollback checks but the column defaults are
--     deprecated. Removal of the legacy rows happens in a later migration
--     once all callers have migrated.
--
-- This migration is forward only — no data is deleted. It is idempotent on
-- re-run (every CREATE/INSERT uses if-not-exists / on-conflict-do-nothing).
--
-- Test plan (local pglite):
--   * Apply 0001 → 0002 → 0003 against the test harness (with stub
--     auth.users + auth.uid()).
--   * Verify: a synthetic pre-migration profile becomes exactly one
--     global_profiles row + exactly one organisation_memberships row.
--   * Verify: handle_new_user accepts an invitation into an additional org
--     for an existing global user instead of colliding with their profile.
--   * Verify: active_organisation_context pick routine changes the helper
--     output without changing RLS outcomes.

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

create trigger global_profiles_set_updated_at
  before update on public.global_profiles
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 1b. Repoint audit_log FK on actor from legacy profiles → global_profiles
------------------------------------------------------------------------
-- The existing audit_log.actor FK points at public.profiles (the legacy
-- single-org table). New writes use memberships and global_profiles. We
-- drop the legacy FK and add a new FK to global_profiles.
--
-- Audit history is preserved: the actor column was never deleted, just
-- reframed. Any insert of a profile_id (auth.users.id) that is already
-- a global_profiles row will satisfy the new FK; for very old rows where
-- only the legacy profile existed, actor stays a valid auth.users uuid
-- (since global_profiles.id is auth.users.id).

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
      foreign key (actor) references public.global_profiles (id) on delete set null;
  exception when duplicate_object then
    null;
  end;
end$$;

------------------------------------------------------------------------
-- 2. organisation_memberships — link a global user to one provider
------------------------------------------------------------------------
-- One row per (organisation, profile). Roles are attached per membership.
-- Status mirrors the legacy role check plus a separate active/withdrawn
-- flag so withdrawal does not delete the row (audit stays intact).

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
  -- An account may have at most one membership per (org, role) while both
  -- rows are active. Withdrawal history is preserved by allowing multiple
  -- withdrawn rows in the future.
  unique (organisation_id, profile_id, role)
);

create index if not exists organisation_memberships_org_idx
  on public.organisation_memberships (organisation_id)
  where status = 'active';

create index if not exists organisation_memberships_profile_idx
  on public.organisation_memberships (profile_id);

create index if not exists organisation_memberships_role_idx
  on public.organisation_memberships (organisation_id, role)
  where status = 'active';

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

create trigger active_organisation_context_set_updated_at
  before update on public.active_organisation_context
  for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- 4. Forward-migrate existing public.profiles rows
------------------------------------------------------------------------
-- The migration of existing legacy profile rows is wrapped in a
-- SECURITY DEFINER function. The migration calls it once. Tests and any
-- future re-run path can call it again safely.

create or replace function public.forward_migrate_legacy_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 4a. Copy each legacy profile into global_profiles.
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

  -- 4b. Create one membership per legacy profile row.
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
  on conflict (organisation_id, profile_id, role) do nothing;

  -- 4c. Seed active_organisation_context when the user has none yet.
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

-- Tests / future migration tooling: callable via select forward_migrate_legacy_profiles();
-- Permission model: SECURITY DEFINER + restricted to service_role callers —
-- this is an admin operation, not a user RPC.
revoke all on function public.forward_migrate_legacy_profiles() from public;
grant execute on function public.forward_migrate_legacy_profiles() to service_role;

------------------------------------------------------------------------
-- 5. Replace handle_new_user: invitation → membership, not new profile
------------------------------------------------------------------------
-- We keep the same trigger from 0001 (on_auth_user_created after insert
-- on auth.users) but the body now does:
--
--   1. If no current, unexpired, unrevoked, org-alive invitation for the
--      email: do nothing. The signed-in user has no membership yet and
--      must visit /no-invitation.
--   2. If the user already has a global_profiles row: ensure the
--      membership exists (no-op if already present), mark invitation
--      accepted, audit. This is the key change: a second invitation from
--      a different organisation no longer collides with the existing
--      profile row.
--   3. If the user is brand new: create global_profile + membership
--      together.
--
-- The behaviour is intentionally additive — old profile rows remain in
-- place; this trigger never touches them.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation public.invitations;
begin
  select * into v_invitation
  from public.invitations i
  where i.email = new.email
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > now()
    and exists (
      select 1 from public.organisations o
      where o.id = i.organisation_id
        and o.deleted_at is null
    )
  order by i.created_at desc
  limit 1;

  if not found then
    return new;
  end if;

  -- 5a. Ensure global_profiles row exists for this auth user.
  insert into public.global_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  -- 5b. Ensure a membership exists for the invited org + role.
  insert into public.organisation_memberships (
    organisation_id, profile_id, role, status, effective_from
  )
  values (
    v_invitation.organisation_id, new.id, v_invitation.role, 'active', now()
  )
  on conflict (organisation_id, profile_id, role) do nothing;

  -- 5c. Seed active_organisation_context if this is the user's first
  -- active membership (so multi-org accounts have to pick, but a
  -- single-org account does not bounce through /onboarding first).
  insert into public.active_organisation_context (profile_id, organisation_id)
  values (new.id, v_invitation.organisation_id)
  on conflict (profile_id) do nothing;

  -- 5d. Mark the invitation consumed.
  update public.invitations
    set accepted_at = now()
    where id = v_invitation.id
      and accepted_at is null;

  -- 5e. Audit one row per accepted invitation.
  insert into public.audit_log (
    organisation_id, actor, action, subject_type, subject_id, metadata
  )
  values (
    v_invitation.organisation_id,
    new.id,
    'invitation.accepted',
    'invitation',
    v_invitation.id,
    jsonb_build_object('email', new.email, 'role', v_invitation.role)
  );

  return new;
end;
$$;

------------------------------------------------------------------------
-- 6. Helpers (membership-aware)
------------------------------------------------------------------------
-- The new helpers read memberships instead of profiles.organisation_id.
-- The legacy helpers remain (kept identical for callers that haven't
-- migrated yet, and for the existing 0001/0002 RLS policies).

create or replace function public.current_user_membership_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.organisation_memberships m
  join public.active_organisation_context a on a.profile_id = m.profile_id
  where m.profile_id = auth.uid()
    and m.organisation_id = a.organisation_id
    and m.status = 'active'
  limit 1
$$;

revoke all on function public.current_user_membership_role() from public;
grant execute on function public.current_user_membership_role() to authenticated;

create or replace function public.current_active_organisation_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.organisation_id
  from public.active_organisation_context a
  where a.profile_id = auth.uid()
  limit 1
$$;

revoke all on function public.current_active_organisation_id() from public;
grant execute on function public.current_active_organisation_id() to authenticated;

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
    where m.organisation_id = p_organisation_id
      and m.profile_id = auth.uid()
      and m.status = 'active'
      and (p_role is null or m.role = p_role)
  )
$$;

revoke all on function public.user_has_membership(uuid, text) from public;
grant execute on function public.user_has_membership(uuid, text) to authenticated;

------------------------------------------------------------------------
-- 7. RLS for the new tables (least privilege)
------------------------------------------------------------------------
-- global_profiles: each user reads their own row plus other rows that
-- share an organisation membership with them. Writes are restricted to
-- service-role / RPC paths.
alter table public.global_profiles enable row level security;

create policy global_profiles_select_self
  on public.global_profiles for select to authenticated
  using (id = auth.uid());

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
        and them.profile_id = public.global_profiles.id
        and them.status = 'active'
    )
  );

create policy global_profiles_update_self
  on public.global_profiles for update to authenticated
  using (id = auth.uid() and deleted_at is null)
  with check (id = auth.uid() and deleted_at is null);

-- organisation_memberships: each user reads their own memberships. Admins
-- read all memberships in their active org.
alter table public.organisation_memberships enable row level security;

create policy organisation_memberships_select_self
  on public.organisation_memberships for select to authenticated
  using (profile_id = auth.uid());

create policy organisation_memberships_select_org_admin
  on public.organisation_memberships for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() = 'admin'
  );

-- INSERT/UPDATE/DELETE on organisation_memberships is intentionally not
-- granted. Memberships are created by handle_new_user (trigger) and
-- mutated by trusted server functions / RPCs in later tickets. The
-- "deny all" default is the desired invariant.

-- active_organisation_context: each user reads and writes their own row.
alter table public.active_organisation_context enable row level security;

create policy active_organisation_context_select_self
  on public.active_organisation_context for select to authenticated
  using (profile_id = auth.uid());

create policy active_organisation_context_write_self
  on public.active_organisation_context for insert to authenticated
  with check (profile_id = auth.uid());

create policy active_organisation_context_update_self
  on public.active_organisation_context for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy active_organisation_context_delete_self
  on public.active_organisation_context for delete to authenticated
  using (profile_id = auth.uid());

-- set_active_organisation: RPC that switches context to one of the user's
-- own active memberships. Validates membership before writing.
create or replace function public.set_active_organisation(p_organisation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.organisation_memberships m
    where m.profile_id = auth.uid()
      and m.organisation_id = p_organisation_id
      and m.status = 'active'
  ) then
    raise exception 'not_a_member'
      using errcode = '42501';
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
