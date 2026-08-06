-- 0001_init_organisations_and_profiles.sql
-- Initial schema for the NDIS Provider CRM.
--
-- Establishes:
--   * organisations   — tenant root. One row per NDIS provider.
--   * profiles        — 1:1 with auth.users, scoped to an organisation.
--   * RLS on both tables, with the minimum policies needed for organisation
--     isolation. Full invite flow, MFA enforcement, and the rest of the
--     authorisation matrix are intentionally deferred to later tickets.
--
-- This migration is idempotent-friendly but not strictly idempotent: it
-- assumes a fresh database. Re-running it on a populated database will fail
-- on the CREATE statements and that is the desired behaviour.

------------------------------------------------------------------------
-- organisations
------------------------------------------------------------------------

create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index organisations_slug_idx on public.organisations (slug);

------------------------------------------------------------------------
-- profiles
------------------------------------------------------------------------

create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  full_name       text,
  role            text not null check (role in ('admin','scheduler','worker','participant','external','nominee')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index profiles_organisation_id_idx on public.profiles (organisation_id);
create index profiles_role_idx on public.profiles (role);

------------------------------------------------------------------------
-- updated_at triggers
------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organisations_set_updated_at
before update on public.organisations
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

------------------------------------------------------------------------
-- helper: current_user_organisation_id()
------------------------------------------------------------------------
-- Returns the organisation_id for the calling authenticated user, or null
-- if the user has no profile yet (e.g. invited but not accepted, or signed
-- up before the invite flow lands). RLS policies use this to scope reads
-- and writes to the caller's organisation.

create or replace function public.current_user_organisation_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organisation_id
  from public.profiles
  where id = auth.uid()
$$;

revoke all on function public.current_user_organisation_id() from public;
grant execute on function public.current_user_organisation_id() to authenticated;

------------------------------------------------------------------------
-- placeholder: handle_new_user trigger
------------------------------------------------------------------------
-- When a new auth.users row is created, create a corresponding profiles
-- row ONLY when the user was explicitly invited (via an invitations row
-- that a later ticket will define).
--
-- Today there is no invitations table yet, so this trigger is a no-op
-- placeholder — sign-ups through Supabase Auth will not create profile
-- rows. This is deliberate: invite-only access is part of the security
-- posture from day one.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Placeholder: full invite-only profile creation lands in a later
  -- ticket. Until then, do not auto-create a profile row.
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

------------------------------------------------------------------------
-- row level security
------------------------------------------------------------------------

alter table public.organisations enable row level security;
alter table public.profiles enable row level security;

-- organisations: members can read their own organisation.
create policy organisations_select_member
  on public.organisations
  for select
  to authenticated
  using (id = public.current_user_organisation_id());

-- profiles: a profile can read other profiles in the same organisation.
create policy profiles_select_own_org
  on public.profiles
  for select
  to authenticated
  using (organisation_id = public.current_user_organisation_id());

-- profiles: a profile updates only its own row.
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- profiles: insert/update/delete outside of the trigger pipeline is
-- restricted to trusted server functions (service role / Edge Functions)
-- in later tickets. Anon and authenticated roles cannot mutate profiles
-- directly.