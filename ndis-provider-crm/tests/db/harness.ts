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

export async function bootTestDb(): Promise<Executor> {
  const pg = new PGlite();

  await pg.exec(AUTH_SCHEMA_SQL);

  await pg.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  await pg.exec("select set_config('request.jwt.claim.sub','',false)");

  for (const file of migrations) {
    const sql = fs.readFileSync(file, "utf8");
    await pg.exec(sql);
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
  cmd_apply_correction: {
    params: [
      { name: "command_id", type: "text" },
      { name: "shift_id", type: "uuid" },
      { name: "expected_version", type: "bigint" },
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
