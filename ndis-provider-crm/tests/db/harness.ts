/**
 * Shared test harness — boots an isolated pglite Postgres, applies every
 * migration in numeric order, and replaces Supabase's `auth` schema with
 * a small controllable stub so the SQL exercises the same code paths
 * Supabase uses (auth.uid(), role-aware RLS).
 *
 * The harness intentionally does NOT mutate any remote Supabase database.
 * Every test runs in a fresh in-memory pglite; nothing persists beyond the
 * test process.
 */
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

import migrations from "./migrations-list";

export type Executor = {
  /** Switch the "authenticated" user for subsequent statements. */
  setUser: (userId: string | null) => void;
  /** Run a SQL batch in the current user's context. */
  exec: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows: number }>;
  /** Run a SQL batch as the service role (bypasses RLS). */
  execAsService: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows: number }>;
  /** Run an RPC by name. */
  callRpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Raw pglite instance for tests that need direct access. */
  raw: PGlite;
};

const AUTH_SCHEMA_SQL = `
  -- Stubbed Supabase auth schema so the migrations run unchanged on pglite.
  --
  -- Roles: Supabase provisions \`anon\` and \`authenticated\` plus
  -- \`service_role\`. pglite ships with the postgresql \`postgres\`
  -- superuser; we recreate the names so RLS / grants resolve.
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin bypassrls;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'test_auth_user') then
      -- A non-superuser role used as the default for \`set role\` so
      -- RLS is actually enforced during tests.
      create role test_auth_user nologin;
    end if;
  end $$;

  grant authenticated to test_auth_user;

  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key,
    email text,
    created_at timestamptz not null default now()
  );

  -- Per-session settings:
  --   request.jwt.claim.sub  -- the auth.users.id of the current user
  --   request.jwt.claim.role -- the supabase role (e.g. authenticated,
  --                            anon, service_role)
  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  create or replace function auth.role()
  returns text
  language sql
  stable
  as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;

  grant execute on function auth.uid() to public;
  grant execute on function auth.role() to public;
`;

export async function bootTestDb(options: { through?: string } = {}): Promise<Executor> {
  const pg = new PGlite();

  await pg.exec(AUTH_SCHEMA_SQL);

  await pg.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  await pg.exec("select set_config('request.jwt.claim.sub','',false)");

  for (const file of migrations) {
    const sql = fs.readFileSync(file, "utf8");
    await pg.exec(sql);
    if (options.through && file.endsWith(options.through)) break;
  }

  // After all migrations are in place, grant the test_auth_user role
  // table-level SELECT/INSERT/UPDATE/DELETE on every domain table so
  // RLS policies act as row-level filters (not as a privilege gate).
  // service_role / superuser paths bypass RLS entirely.
  await pg.exec(`
    grant usage on schema public to test_auth_user;
    grant select, insert, update, delete on all tables in schema public to test_auth_user;
    grant usage on all sequences in schema public to test_auth_user;
    grant execute on all functions in schema public to test_auth_user;
    -- Keep intentionally internal SECURITY DEFINER helpers out of the
    -- blanket test grant so ACL regressions match production semantics.
    do $$ begin
      if to_regprocedure('public.current_worker_route_state(uuid)') is not null then
        execute 'revoke all on function public.current_worker_route_state(uuid) from test_auth_user';
      end if;
    end $$;
  `);

  return wrap(pg);
}

function wrap(pg: PGlite): Executor {
  let currentUser: string | null = null;

  async function setSession(
    userId: string | null,
    role: "authenticated" | "service_role" | "anon",
  ): Promise<void> {
    await pg.exec(`select set_config('request.jwt.claim.role','${role}',false)`);
    await pg.exec(
      `select set_config('request.jwt.claim.sub','${userId ?? ""}',false)`,
    );
    if (role === "service_role") {
      await pg.exec(`reset role`);
    } else {
      // Force RLS by acting as a non-superuser role.
      await pg.exec(`set role test_auth_user`);
    }
  }

  async function exec(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; affectedRows: number }> {
    await setSession(currentUser, "authenticated");
    const res = await pg.query(sql, params);
    return { rows: res.rows ?? [], affectedRows: res.affectedRows ?? 0 };
  }

  async function execAsService(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; affectedRows: number }> {
    await setSession(currentUser, "service_role");
    const res = await pg.query(sql, params);
    return { rows: res.rows ?? [], affectedRows: res.affectedRows ?? 0 };
  }

  async function callRpc(name: string, args: Record<string, unknown>) {
    await setSession(currentUser, "authenticated");
    const spec = RPC_SIGNATURES[name];
    if (!spec) throw new Error(`unknown rpc ${name}`);
    const params: unknown[] = [];
    const placeholders: string[] = [];
    spec.params.forEach((p, idx) => {
      const value = args[p.name] ?? null;
      params.push(value);
      placeholders.push(`$${idx + 1}::${p.type}`);
    });
    const sql = `select public.${name}(${placeholders.join(",")}) as result`;
    const res = await pg.query(sql, params);
    const row = res.rows[0] as { result: unknown } | undefined;
    if (!row) throw new Error(`rpc ${name} returned no row`);
    return row.result;
  }

  return {
    setUser(userId) {
      currentUser = userId;
    },
    exec,
    execAsService,
    callRpc,
    raw: pg,
  };
}

const Param = { name: "string", type: "string" };

type ParamSpec = { name: string; type: string };

const RPC_SIGNATURES: Record<string, { params: ParamSpec[] }> = {
  cmd_admin_create_participant: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" },
      { name: "first_name", type: "text" }, { name: "last_initial", type: "text" },
      { name: "critical_content", type: "text" }, { name: "review_due_at", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_update_critical_info: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" },
      { name: "participant_id", type: "uuid" }, { name: "critical_content", type: "text" },
      { name: "review_due_at", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_invite: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" },
      { name: "email", type: "text" }, { name: "role", type: "text" },
      { name: "expires_at", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_link_participant: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" },
      { name: "participant_id", type: "uuid" }, { name: "profile_id", type: "uuid" },
      { name: "evidence_reference", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_set_authority: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "participant_id", type: "uuid" },
      { name: "representative_profile_id", type: "uuid" }, { name: "authority_type", type: "text" }, { name: "scope_categories", type: "text[]" },
      { name: "evidence_reference", type: "text" }, { name: "issuer", type: "text" }, { name: "effective_from", type: "timestamptz" },
      { name: "effective_until", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_service_ready_shift: {
      params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" },
      { name: "participant_id", type: "uuid" }, { name: "worker_membership", type: "uuid" },
      { name: "service_context_id", type: "uuid" },
      { name: "scheduled_start", type: "timestamptz" }, { name: "scheduled_end", type: "timestamptz" },
      { name: "reason", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_handoff_route: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" },
      { name: "route_type", type: "text" }, { name: "guidance_text", type: "text" },
      { name: "owner_role_label", type: "text" }, { name: "primary_label", type: "text" },
      { name: "primary_contact_uri", type: "text" }, { name: "fallback_phone", type: "text" },
      { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_service_context: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "participant_id", type: "uuid" },
      { name: "capability_id", type: "uuid" }, { name: "catalogue_item_id", type: "uuid" }, { name: "role_version_id", type: "uuid" }, { name: "jurisdiction", type: "text" }, { name: "external_agreement_reference", type: "text" },
      { name: "plan_reference", type: "text" }, { name: "source_type", type: "text" }, { name: "owner_profile_id", type: "uuid" },
      { name: "reviewer_profile_id", type: "uuid" }, { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" },
      { name: "goal_source", type: "text" }, { name: "goal_reference", type: "text" }, { name: "goal_display", type: "text" },
      { name: "lifecycle_state", type: "text" }, { name: "screening_required", type: "boolean" }, { name: "screening_decision_issuer", type: "text" },
      { name: "screening_decision_authority", type: "text" }, { name: "screening_evidence_reference", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_record_acknowledgement: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "shift_id", type: "uuid" },
      { name: "event_class", type: "text" }, { name: "event_type", type: "text" }, { name: "reported_signer_profile_id", type: "uuid" },
      { name: "authority_type", type: "text" }, { name: "method", type: "text" }, { name: "occurred_at", type: "timestamptz" },
      { name: "reason", type: "text" }, { name: "external_evidence_reference", type: "text" }, { name: "expected_current_event_id", type: "uuid" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_set_ndis_identifier: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "participant_id", type: "uuid" }, { name: "identifier", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_reveal_participant_ndis_identifier: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "participant_id", type: "uuid" }, { name: "reason", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_update_service_context_state: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "context_id", type: "uuid" }, { name: "lifecycle_state", type: "text" }, { name: "reviewer_profile_id", type: "uuid" }, { name: "role_version_id", type: "uuid" }, { name: "jurisdiction", type: "text" }, { name: "reason", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_provider_scope_version: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "registration_state", type: "text" }, { name: "registration_group", type: "text" }, { name: "class_of_support", type: "text" }, { name: "jurisdictions", type: "text[]" }, { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" }, { name: "reviewed_by", type: "uuid" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_support_capability: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "scope_version_id", type: "uuid" }, { name: "support_category", type: "text" }, { name: "service_kind", type: "text" }, { name: "capability", type: "text" }, { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_catalogue_item: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "source_label", type: "text" }, { name: "source_version", type: "text" }, { name: "catalogue_effective_from", type: "timestamptz" }, { name: "catalogue_effective_until", type: "timestamptz" }, { name: "item_code", type: "text" }, { name: "item_name", type: "text" }, { name: "support_category", type: "text" }, { name: "time_unit", type: "text" }, { name: "service_kind", type: "text" }, { name: "item_effective_from", type: "timestamptz" }, { name: "item_effective_until", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_create_grant: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "consent_id", type: "uuid" },
      { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_record_consent: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "participant_id", type: "uuid" },
      { name: "recipient_profile_id", type: "uuid" }, { name: "authorising_profile_id", type: "uuid" }, { name: "purpose", type: "text" },
      { name: "scope_categories", type: "text[]" }, { name: "consent_basis", type: "text" }, { name: "representative_authority_id", type: "uuid" },
      { name: "evidence_reference", type: "text" }, { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_renew_consent: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "consent_id", type: "uuid" },
      { name: "expected_current_consent_id", type: "uuid" }, { name: "purpose", type: "text" }, { name: "scope_categories", type: "text[]" },
      { name: "evidence_reference", type: "text" }, { name: "effective_from", type: "timestamptz" }, { name: "effective_until", type: "timestamptz" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_revoke_grant: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "grant_id", type: "uuid" },
      { name: "reason", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_admin_set_availability: {
    params: [
      { name: "command_id", type: "text" }, { name: "organisation_id", type: "uuid" }, { name: "worker_membership", type: "uuid" },
      { name: "available_from", type: "timestamptz" }, { name: "available_until", type: "timestamptz" },
      { name: "note", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_accept_invitation: {
    params: [{ name: "token", type: "text" }],
  },
  cmd_on_my_way: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "claimed_at", type: "timestamptz" },
      { name: "client_tz", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_start_shift: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "expected_version", type: "bigint" },
      { name: "claimed_at", type: "timestamptz" },
      { name: "client_tz", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_reassign_shift: {
    params: [
      { name: "command_id", type: "text" }, { name: "shift_id", type: "uuid" }, { name: "expected_version", type: "bigint" }, { name: "claimed_at", type: "timestamptz" }, { name: "client_tz", type: "text" }, { name: "new_worker_membership", type: "uuid" }, { name: "reason", type: "text" }, { name: "payload", type: "jsonb" },
    ],
  },
  cmd_end_shift: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "expected_version", type: "bigint" },
      { name: "claimed_at", type: "timestamptz" },
      { name: "client_tz", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_submit_summary: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "expected_version", type: "bigint" },
      { name: "claimed_at", type: "timestamptz" },
      { name: "activities", type: "text[]" },
      { name: "summary_text", type: "text" },
      { name: "audience", type: "text[]" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_worker_record_handoff: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "route_version_id", type: "uuid" },
      { name: "event_type", type: "text" },
      { name: "selected_channel", type: "text" },
      { name: "failure_code", type: "text" },
      { name: "claimed_at", type: "timestamptz" },
      { name: "client_tz", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_finalise_summary: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_resolve_conflict: {
    params: [
      { name: "command_id", type: "text" },
      { name: "review_id", type: "uuid" },
      { name: "decision", type: "text" },
      { name: "reason", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_request_correction: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "reason", type: "text" },
      { name: "requested_changes", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  cmd_request_access: {
    params: [
      { name: "command_id", type: "text" },
      { name: "participant_id", type: "uuid" },
      { name: "scope_categories", type: "text[]" },
      { name: "reason", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  list_worker_today_shifts: {
    params: [],
  },
  list_worker_shift_handoff_routes: {
    params: [{ name: "shift_id", type: "uuid" }],
  },
  get_worker_shift_acknowledgement: {
    params: [{ name: "shift_id", type: "uuid" }],
  },
  cmd_apply_correction: {
    params: [
      { name: "command_id", type: "text" },
      { name: "request_id", type: "uuid" },
      { name: "expected_version", type: "bigint" },
      { name: "claimed_at", type: "timestamptz" },
      { name: "client_tz", type: "text" },
      { name: "activities", type: "text[]" },
      { name: "summary_text", type: "text" },
      { name: "audience", type: "text[]" },
      { name: "reason", type: "text" },
      { name: "payload", type: "jsonb" },
    ],
  },
  set_active_organisation: {
    params: [{ name: "organisation_id", type: "uuid" }],
  },
};

export const _internal = { Param, RPC_SIGNATURES };
