import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("PostgREST named-argument and ACL contract", () => {
  it("keeps invitation acceptance token-bound across SQL and the client wrapper", () => {
    const migration = read("supabase/migrations/0003_forward_identity.sql");
    const commands = read("src/lib/supabase/commands.ts");
    expect(migration).toMatch(
      /create or replace function public\.cmd_accept_invitation\(\s*p_token text/s,
    );
    expect(migration).toContain(
      "revoke all on function public.cmd_accept_invitation(text) from public;",
    );
    expect(migration).toContain(
      "grant execute on function public.cmd_accept_invitation(text) to authenticated;",
    );
    expect(commands).toContain(
      'client.rpc("cmd_accept_invitation", {\n    p_token: token,\n  })',
    );
  });

  it("uses p_-prefixed SQL parameters and authenticated-only execution for sensitive RPCs", () => {
    const migration = read("supabase/migrations/0005_sensitive_command_rpcs.sql");
    const commands = read("src/lib/supabase/commands.ts");
    for (const name of [
      "cmd_on_my_way",
      "cmd_start_shift",
      "cmd_end_shift",
      "cmd_submit_summary",
      "cmd_finalise_summary",
      "cmd_resolve_conflict",
      "cmd_request_correction",
      "cmd_request_access",
    ]) {
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to authenticated;`),
      );
      expect(migration).not.toMatch(
        new RegExp(`grant execute on function public\\.${name}\\([^;]+\\) to public;`),
      );
      expect(commands).toContain(`client.rpc("${name}", args)`);
    }
    expect(migration).toContain("p_command_id");
    expect(migration).toContain("p_shift_id");
  });

  it("keeps the urgent handoff prerequisite bound to explicit p_-prefixed route and worker arguments", () => {
    const migration = read("supabase/migrations/20260813000002_worker_urgent_handoff_and_worker_flow.sql");
    const commands = read("src/lib/supabase/commands.ts");
    expect(migration).toMatch(
      /create or replace function public\.cmd_admin_create_handoff_route\(\s*p_command_id text,\s*p_organisation_id uuid,\s*p_route_type text/s,
    );
    expect(migration).toMatch(
      /create or replace function public\.cmd_worker_record_handoff\(\s*p_command_id text,\s*p_shift_id uuid,\s*p_route_version_id uuid/s,
    );
    expect(migration).toContain(
      "grant execute on function public.cmd_admin_create_handoff_route(text,uuid,text,text,text,text,text,text,timestamptz,timestamptz,jsonb) to authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.cmd_worker_record_handoff(text,uuid,uuid,text,text,text,timestamptz,text,jsonb) to authenticated;",
    );
    expect(commands).toContain('adminRpc(client, "cmd_admin_create_handoff_route", args as unknown as Record<string, unknown>)');
    expect(commands).toContain('client.rpc("cmd_worker_record_handoff", args)');
  });

  it("contains explicit rerunnable DDL for pre-existing command receipts and tenant FKs", () => {
    const migration = read("supabase/migrations/0004_v1_domain_tables.sql");
    expect(migration).toContain(
      "alter table public.command_receipts\n  add column if not exists actor_profile_id uuid;",
    );
    expect(migration).toContain(
      "update public.command_receipts r\nset actor_profile_id = m.profile_id",
    );
    expect(migration).toContain(
      "alter column actor_profile_id set not null;",
    );
    expect(migration).toContain(
      "command_receipts_actor_profile_id_fkey",
    );
    expect(migration).toContain(
      "representative_authorities_identity_tenant",
    );
    expect(migration).toContain("external_grants_identity_tenant");
  });

  it("keeps the Ticket 06 review fixup RPC overrides on an empty search path with append-only handoff evidence", () => {
    const migration = read("supabase/migrations/20260813000003_ticket06_first_pass_review_fixup.sql");
    expect(migration).toContain(
      "revoke all on function public.current_worker_route_state(uuid) from authenticated;",
    );
    expect(migration).not.toContain(
      "grant execute on function public.current_worker_route_state(uuid) to authenticated;",
    );
    expect(migration).toMatch(
      /create or replace function public\.cmd_on_my_way\([\s\S]+?security definer[\s\S]+?set search_path = ''/s,
    );
    expect(migration).toMatch(
      /create or replace function public\.cmd_start_shift\([\s\S]+?security definer[\s\S]+?set search_path = ''/s,
    );
    expect(migration).toMatch(
      /create or replace function public\.cmd_end_shift\([\s\S]+?security definer[\s\S]+?set search_path = ''/s,
    );
    expect(migration).toMatch(
      /create or replace function public\.cmd_submit_summary\([\s\S]+?security definer[\s\S]+?set search_path = ''/s,
    );
    expect(migration).toMatch(
      /create or replace function public\.cmd_worker_record_handoff\([\s\S]+?security definer[\s\S]+?set search_path = ''/s,
    );
    expect(migration).toContain("create trigger worker_handoff_receipts_immutable");
    expect(migration).toContain("execute function public.prevent_05b_immutable_evidence()");
  });
});
