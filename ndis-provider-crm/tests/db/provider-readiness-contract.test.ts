import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { bootTestDb, type Executor } from "./harness";
import { seedStandardFixture, type Fixture } from "./fixtures";

let ex: Executor;
let fx: Fixture;

beforeEach(async () => { ex = await bootTestDb(); fx = await seedStandardFixture(ex); });
afterEach(async () => { await ex.raw.close(); });

describe("Ticket 05b provider-readiness boundary", () => {
  it("retires the exact context-free command and exposes only the ready command", async () => {
    const rows = await ex.execAsService(`select proname, pg_get_function_identity_arguments(oid) as args from pg_proc where pronamespace='public'::regnamespace and proname in ('cmd_admin_create_shift','cmd_admin_create_service_ready_shift')`);
    expect(rows.rows.some((row) => (row as { proname: string }).proname === "cmd_admin_create_shift")).toBe(false);
    expect(rows.rows.some((row) => (row as { proname: string }).proname === "cmd_admin_create_service_ready_shift")).toBe(true);
  });

  it("proves the migration boundary: old callable through 0008c, absent after 0009", async () => {
    const legacy = await bootTestDb({ through: "0008c_admin_final_security_lineage_fixup.sql" });
    const before = await legacy.execAsService(`select pg_get_function_identity_arguments(oid) as args from pg_proc where pronamespace='public'::regnamespace and proname='cmd_admin_create_shift'`);
    expect(before.rows).toHaveLength(1);
    expect((before.rows[0] as { args: string }).args.replace(/\s+/g, " ")).toBe("p_command_id text, p_organisation_id uuid, p_participant_id uuid, p_worker_membership uuid, p_scheduled_start timestamp with time zone, p_scheduled_end timestamp with time zone, p_reason text, p_payload jsonb");
    await legacy.raw.close();
    const after = await ex.execAsService(`select count(*)::int as c from pg_proc where pronamespace='public'::regnamespace and proname='cmd_admin_create_shift'`);
    expect(after.rows[0]).toMatchObject({ c: 0 });
  });

  it("rolls back the whole migration when a late statement fails", async () => {
    const legacy = await bootTestDb({ through: "0008c_admin_final_security_lineage_fixup.sql" });
    try {
      const migration = fs.readFileSync(new URL("../../supabase/migrations/0009_provider_readiness_service_evidence.sql", import.meta.url), "utf8");
      const forcedFailure = migration.replace(/\ncommit;\s*$/, "\nselect 1 / 0;\ncommit;");
      await expect(legacy.raw.exec(forcedFailure)).rejects.toThrow();
      await legacy.raw.exec("rollback");
      const oldCommand = await legacy.execAsService(`select count(*)::int as count from pg_proc where pronamespace='public'::regnamespace and proname='cmd_admin_create_shift'`);
      const newRelation = await legacy.execAsService(`select to_regclass('public.shift_service_snapshots') as relation`);
      expect(oldCommand.rows[0]).toMatchObject({ count: 1 });
      expect(newRelation.rows[0]).toMatchObject({ relation: null });
    } finally {
      await legacy.raw.close();
    }
  });


  it("creates an immutable service snapshot and duplicate retry returns its receipt", async () => {
    ex.setUser(fx.schedulerUid);
    const worker = (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] as { id: string };
    const args = { command_id: "ready-shift-1", organisation_id: fx.orgId, participant_id: fx.participantId, worker_membership: worker.id, service_context_id: fx.contextId, scheduled_start: "2026-08-07T12:00:00Z", scheduled_end: "2026-08-07T13:00:00Z", reason: "test", payload: {} };
    const first = await ex.callRpc("cmd_admin_create_service_ready_shift", args) as { shift_id: string; snapshot_id: string };
    const duplicate = await ex.callRpc("cmd_admin_create_service_ready_shift", { ...args, reason: "changed" }) as { status: string; duplicate: boolean; outcome: { shift_id: string } };
    expect(duplicate).toMatchObject({ status: "duplicate_returned", duplicate: true, outcome: { shift_id: first.shift_id } });
    const snapshots = await ex.execAsService(`select count(*)::int as c from public.shift_service_snapshots where shift_id='${first.shift_id}'`);
    expect(snapshots.rows[0]).toMatchObject({ c: 1 });
  });

  it("marks context-free history as legacy and prevents action", async () => {
    const legacy = await bootTestDb({ through: "0008c_admin_final_security_lineage_fixup.sql" });
    const org = "99999999-9999-4999-8999-999999999901";
    const scheduler = "99999999-9999-4999-8999-999999999902";
    const workerA = "99999999-9999-4999-8999-999999999903";
    const workerB = "99999999-9999-4999-8999-999999999904";
    const schedulerMembership = "99999999-9999-4999-8999-999999999905";
    const workerAMembership = "99999999-9999-4999-8999-999999999906";
    const workerBMembership = "99999999-9999-4999-8999-999999999907";
    const participant = "99999999-9999-4999-8999-999999999908";
    const legacyShift = "99999999-9999-4999-8999-999999999909";
    await legacy.raw.exec(`insert into auth.users(id,email) values ('${scheduler}','scheduler@legacy.test'),('${workerA}','a@legacy.test'),('${workerB}','b@legacy.test'); insert into public.organisations(id,name,slug) values ('${org}','Legacy','legacy'); update public.global_profiles set full_name=case id when '${scheduler}' then 'Scheduler'::text when '${workerA}' then 'Worker A'::text else 'Worker B'::text end where id in ('${scheduler}','${workerA}','${workerB}'); insert into public.organisation_memberships(id,organisation_id,profile_id,role,status,effective_from) values ('${schedulerMembership}','${org}','${scheduler}','scheduler','active','2026-08-01'),('${workerAMembership}','${org}','${workerA}','worker','active','2026-08-01'),('${workerBMembership}','${org}','${workerB}','worker','active','2026-08-01'); insert into public.active_organisation_context(profile_id,organisation_id) values ('${scheduler}','${org}'),('${workerA}','${org}'); insert into public.participants(id,organisation_id,first_name,last_initial,created_by) values ('${participant}','${org}','Legacy','P','${scheduler}'); insert into public.shifts(id,organisation_id,participant_id,scheduled_start,scheduled_end,state,version) values ('${legacyShift}','${org}','${participant}','2026-08-07T14:00:00Z','2026-08-07T15:00:00Z','scheduled',1); insert into public.shift_assignments(shift_id,organisation_id,membership_id,assigned_by) values ('${legacyShift}','${org}','${workerAMembership}','${scheduler}')`);
    const migration = fs.readFileSync(new URL("../../supabase/migrations/0009_provider_readiness_service_evidence.sql", import.meta.url), "utf8");
    await legacy.raw.exec(migration);
    const row = await legacy.execAsService(`select s.state,(select count(*)::int from public.shift_assignments a where a.shift_id=s.id) as assignments from public.shifts s where s.id='${legacyShift}'`);
    expect(row.rows[0]).toMatchObject({ state: "legacy_incomplete" });
    expect(row.rows[0]).toMatchObject({ assignments: 1 });
    legacy.setUser(scheduler);
    await expect(legacy.callRpc("cmd_reassign_shift", { command_id: "legacy-reassign", shift_id: legacyShift, expected_version: 1, claimed_at: "2026-08-07T13:00:00Z", client_tz: "Australia/Sydney", new_worker_membership: workerBMembership, reason: "must fail", payload: {} })).rejects.toThrow("legacy_incomplete_not_actionable");
    legacy.setUser(workerA);
    await expect(legacy.callRpc("cmd_start_shift", { command_id: "legacy-start", shift_id: legacyShift, expected_version: 1, claimed_at: "2026-08-07T14:00:00Z", client_tz: "Australia/Sydney", payload: {} })).resolves.toMatchObject({ status: "conflict_preserved", reason: "invalid_state" });
    const workerRows = await legacy.exec(`select id from public.shifts where id='${legacyShift}'`);
    expect(workerRows.rows).toHaveLength(0);
    await legacy.raw.close();
  });
});
