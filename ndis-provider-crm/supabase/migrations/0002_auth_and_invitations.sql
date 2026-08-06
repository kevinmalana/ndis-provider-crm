-- 0002_auth_and_invitations.sql
--
-- Auth, invitations, audit log, and soft-delete helpers.
--
-- Builds on 0001 (organisations + profiles with minimal RLS) and the
-- no-op handle_new_user trigger. Replaces the trigger with the real
-- invite-matching flow, adds the invitations + audit_log tables, and
-- refines RLS so soft-deleted rows and inactive users cannot read.
--
-- Locked decisions reflected here (see decision-log 2026-08-06):
--   * Magic-link only, no password, no SSO.
--   * Invitations single-use, time-bounded, revocable, audit-logged.
--   * Soft-delete with 30-day recovery; hard-delete is a later worker.
--   * Founding operator is "Open NDIS" (slug "opendis") — created later
--     by scripts/bootstrap-founding-tenant.ts, not here.
--
-- Order matters: profiles.invited_via references invitations(id), so
-- invitations must exist before profiles is altered to add that column.

------------------------------------------------------------------------
-- organisations: soft-delete column + slug unique index
------------------------------------------------------------------------

alter table public.organisations
  add column if not exists deleted_at timestamptz;

create unique index if not exists organisations_slug_unique
  on public.organisations (slug);

------------------------------------------------------------------------
-- profiles: soft-delete + email + (org,role) index
------------------------------------------------------------------------
-- invited_via is added LOWER DOWN, after invitations exists.

alter table public.profiles
  add column if not exists deleted_at timestamptz;

-- email is captured at invite acceptance; do not assume auth.users.email
-- is up-to-date (the underlying user row can be re-keyed without touching
-- profiles). Stored in profiles so RLS and the app can read it without
-- joining auth.users.
alter table public.profiles
  add column if not exists email text;

create index if not exists profiles_org_role_idx
  on public.profiles (organisation_id, role);

------------------------------------------------------------------------
-- invitations: single-use, expiring, revocable
------------------------------------------------------------------------

create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  email           text not null,
  role            text not null
                    check (role in ('admin','scheduler','worker','participant','external','nominee')),
  token           text not null unique,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  issued_by       uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists invitations_token_idx
  on public.invitations (token);

create index if not exists invitations_org_email_idx
  on public.invitations (organisation_id, email);

------------------------------------------------------------------------
-- profiles.invited_via: now that invitations exists, link the two
------------------------------------------------------------------------

alter table public.profiles
  add column if not exists invited_via uuid
  references public.invitations (id) on delete set null;

------------------------------------------------------------------------
-- audit_log: append-only trail for sensitive actions
------------------------------------------------------------------------

create table if not exists public.audit_log (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid references public.organisations (id) on delete set null,
  actor           uuid references public.profiles (id) on delete set null,
  action          text not null,
  subject_type    text,
  subject_id      uuid,
  metadata        jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists audit_log_org_created_idx
  on public.audit_log (organisation_id, created_at desc);

create index if not exists audit_log_subject_idx
  on public.audit_log (subject_type, subject_id);

------------------------------------------------------------------------
-- helper: current_user_role()
------------------------------------------------------------------------

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and deleted_at is null
$$;

revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated;

------------------------------------------------------------------------
-- helper: current_user_organisation_id() — refined to exclude soft-deleted
------------------------------------------------------------------------

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
    and deleted_at is null
$$;

revoke all on function public.current_user_organisation_id() from public;
grant execute on function public.current_user_organisation_id() to authenticated;

------------------------------------------------------------------------
-- helper: is_invitation_valid(p_token text)
------------------------------------------------------------------------
-- Returns true iff:
--   * a row exists for the token,
--   * it has not been accepted or revoked,
--   * it has not expired,
--   * its organisation is not soft-deleted.
--
-- Callable by anon (for the invite landing page) and by authenticated.

create or replace function public.is_invitation_valid(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.invitations i
    join public.organisations o on o.id = i.organisation_id
    where i.token = p_token
      and i.accepted_at is null
      and i.revoked_at is null
      and i.expires_at > now()
      and o.deleted_at is null
  )
$$;

revoke all on function public.is_invitation_valid(text) from public;
grant execute on function public.is_invitation_valid(text) to anon, authenticated;

------------------------------------------------------------------------
-- helper: get_invitation_view(p_token text)
------------------------------------------------------------------------
-- Returns the row needed to render the invite landing page: email, role,
-- organisation name, expiry, status. Bypasses RLS via security definer
-- because the visitor is not yet signed in.

create or replace function public.get_invitation_view(p_token text)
returns table (
  email           text,
  role            text,
  organisation_name text,
  organisation_slug text,
  expires_at      timestamptz,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  organisation_deleted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.email,
    i.role,
    o.name,
    o.slug,
    i.expires_at,
    i.accepted_at,
    i.revoked_at,
    o.deleted_at is not null
  from public.invitations i
  join public.organisations o on o.id = i.organisation_id
  where i.token = p_token
  limit 1
$$;

revoke all on function public.get_invitation_view(text) from public;
grant execute on function public.get_invitation_view(text) to anon, authenticated;

------------------------------------------------------------------------
-- soft_delete_organisation(p_id uuid)
------------------------------------------------------------------------
-- Soft-delete an organisation and cascade to its members + invitations.
-- Hard-delete is NOT in this ticket — a later ticket adds the 30-day
-- purge worker. Caller must be trusted server-side (service role or
-- an Edge Function); no public grant is given.

create or replace function public.soft_delete_organisation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.organisations
    set deleted_at = now()
    where id = p_id
      and deleted_at is null;

  update public.profiles
    set deleted_at = now()
    where organisation_id = p_id
      and deleted_at is null;

  update public.invitations
    set revoked_at = now()
    where organisation_id = p_id
      and accepted_at is null
      and revoked_at is null;
end;
$$;

revoke all on function public.soft_delete_organisation(uuid) from public;

------------------------------------------------------------------------
-- handle_new_user: real invitation-matching flow
------------------------------------------------------------------------
-- Replaces the no-op placeholder from 0001.
--
-- On insert into auth.users:
--   1. Find the newest matching invitation by email that is unused,
--      unrevoked, unexpired.
--   2. If none: do nothing (user lands on "no invitation" page after
--      sign-in; profile row is not created).
--   3. If found: create the profile row bound to that invitation's
--      organisation + role, stamp invited_via, mark the invitation
--      accepted, write an audit_log entry.

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

  insert into public.profiles (id, organisation_id, role, email, invited_via)
  values (
    new.id,
    v_invitation.organisation_id,
    v_invitation.role,
    new.email,
    v_invitation.id
  )
  on conflict (id) do nothing;

  update public.invitations
    set accepted_at = now()
    where id = v_invitation.id;

  insert into public.audit_log (
    organisation_id,
    actor,
    action,
    subject_type,
    subject_id,
    metadata
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

-- The trigger from 0001 already references handle_new_user, and
-- create or replace above preserved the function body. The trigger
-- itself does not need to be re-created.

------------------------------------------------------------------------
-- row level security: refine existing policies + add new ones
------------------------------------------------------------------------

-- organisations: members can read their own (non-deleted) organisation.
drop policy if exists organisations_select_member on public.organisations;
create policy organisations_select_member
  on public.organisations
  for select
  to authenticated
  using (
    id = public.current_user_organisation_id()
    and deleted_at is null
  );

-- profiles: read same-org, non-deleted members.
drop policy if exists profiles_select_own_org on public.profiles;
create policy profiles_select_own_org
  on public.profiles
  for select
  to authenticated
  using (
    organisation_id = public.current_user_organisation_id()
    and deleted_at is null
  );

-- profiles: update only your own (non-deleted) row.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid() and deleted_at is null)
  with check (id = auth.uid() and deleted_at is null);

-- invitations: enable RLS and let admin/scheduler read their org's rows.
alter table public.invitations enable row level security;

create policy invitations_select_admin_or_scheduler
  on public.invitations
  for select
  to authenticated
  using (
    organisation_id = public.current_user_organisation_id()
    and public.current_user_role() in ('admin', 'scheduler')
  );

-- INSERT/UPDATE/DELETE on invitations are intentionally not granted to
-- any role. Invitations are written by trusted server functions (service
-- role / Edge Functions) and revoked by an admin-only path that lives in
-- a later ticket. With RLS enabled and no policy for these verbs, the
-- default behaviour is "deny all" — exactly what we want.

-- audit_log: enable RLS, admins read their org's trail.
alter table public.audit_log enable row level security;

create policy audit_log_select_admin
  on public.audit_log
  for select
  to authenticated
  using (
    organisation_id = public.current_user_organisation_id()
    and public.current_user_role() = 'admin'
  );

-- INSERT/UPDATE/DELETE on audit_log are intentionally not granted.
-- audit_log is append-only and written by triggers + trusted server
-- functions. The "deny all" default is the audit-trail invariant.