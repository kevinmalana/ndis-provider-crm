import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedStandardFixture, type Fixture } from "./fixtures";
import { bootTestDb, type Executor } from "./harness";

let ex: Executor;
let fx: Fixture;
let workerMembership: string;

beforeEach(async () => {
  ex = await bootTestDb();
  fx = await seedStandardFixture(ex);
  const row = await ex.execAsService(`select membership_id from public.shift_assignments where shift_id='${fx.shiftId}' and withdrawn_at is null`);
  workerMembership = String((row.rows[0] as { membership_id: string }).membership_id);
});

afterEach(async () => { await ex.raw.close(); });

async function readiness() {
  const row = await ex.execAsService(`select public.provider_readiness('${fx.orgId}','${workerMembership}','${fx.participantId}','${fx.contextId}','2026-08-07T10:00:00Z','2026-08-07T11:00:00Z') as value`);
  return (row.rows[0] as { value: Record<string, unknown> }).value;
}

describe("Ticket 05b final independent review fixup", () => {
  it("fails closed when effective admin or assigned-worker roles are withdrawn", async () => {
    const adminMembership = await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.adminUid}'`);
    await ex.execAsService(`insert into public.organisation_membership_roles(membership_id,role,status,effective_from) values ('${(adminMembership.rows[0] as { id: string }).id}','worker','active','2026-08-01') on conflict(membership_id,role) do update set status='active',effective_from='2026-08-01'`);
    ex.setUser(fx.adminUid);
    await expect(ex.exec(`select public.cmd_admin_create_provider_scope_version('withdrawn-admin','${fx.orgId}','registered','g','individual',array['NSW'],'2026-08-07','2026-08-08',null,'{}')`)).rejects.toThrow("admin_or_scheduler_required");

    await ex.execAsService(`insert into public.organisation_membership_roles(membership_id,role,status,effective_from) values ('${workerMembership}','worker','withdrawn','2026-08-01') on conflict(membership_id,role) do update set status='withdrawn',effective_from='2026-08-01'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "worker_membership_invalid" });
    ex.setUser(fx.workerAUid);
    await expect(ex.callRpc("cmd_start_shift", { command_id: "withdrawn-worker-start", shift_id: fx.shiftId, expected_version: 1, claimed_at: "2026-08-07T10:00:00Z", client_tz: "Australia/Sydney", payload: {} })).resolves.toMatchObject({ status: "conflict_preserved", reason: "not_assigned" });
  });

  it("applies required screening and competence rules that cover only part of the shift", async () => {
    const rows = await ex.execAsService(`select role_version_id from public.participant_service_context_versions where id='${fx.contextId}'`);
    const role = String((rows.rows[0] as { role_version_id: string }).role_version_id);
    await ex.execAsService(`update public.risk_assessed_role_versions set risk_assessed=false where id='${role}'`);
    await ex.execAsService(`update public.role_screening_policy_versions set effective_until='2026-08-07T10:30:00Z' where role_version_id='${role}' and decision='required'`);
    await ex.execAsService(`update public.worker_screening_verification_versions set clearance_status='pending' where worker_membership_id='${workerMembership}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "screening_not_current" });
    await ex.execAsService(`update public.worker_screening_verification_versions set clearance_status='current',effective_until='2026-08-07T10:30:00Z' where worker_membership_id='${workerMembership}'`);
    expect(await readiness()).toMatchObject({ ready: true, screening_source: "provider_verification" });
    await ex.execAsService(`update public.role_competence_requirements set effective_until='2026-08-07T10:30:00Z' where role_version_id='${role}' and requirement_state='required'`);
    await ex.execAsService(`update public.worker_competence_evidence_versions set assessed_state='not_met' where worker_membership_id='${workerMembership}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "competence_not_current" });
    await ex.execAsService(`update public.worker_competence_evidence_versions set assessed_state='met',effective_until='2026-08-07T10:30:00Z' where worker_membership_id='${workerMembership}'`);
    expect(await readiness()).toMatchObject({ ready: true });
  });

  it("resolves acknowledgement authority at event time with exact scope", async () => {
    ex.setUser(fx.adminUid);
    await ex.execAsService(`update public.participant_self_links set linked_at='2026-08-10T00:00:00Z' where participant_id='${fx.participantId}' and profile_id='${fx.participantUid}'`);
    await expect(ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "pre-link", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external", occurred_at: "2026-08-07T10:00:00Z", external_evidence_reference: "PRE", payload: {} })).rejects.toThrow("ack_authority_not_allowed");
    await expect(ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "summary-only", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.representerUid, authority_type: "plan_nominee", method: "external", occurred_at: "2026-08-07T10:00:00Z", external_evidence_reference: "SUMMARY", payload: {} })).rejects.toThrow("ack_authority_not_allowed");
    await ex.execAsService(`update public.representative_authorities set scope_categories=array['service_acknowledgement'],effective_from='2026-08-01T00:00:00Z',status='revoked',withdrawn_at='2026-08-09T00:00:00Z' where participant_id='${fx.participantId}' and representative_profile_id='${fx.representerUid}'`);
    await expect(ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "historical-authority", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.representerUid, authority_type: "plan_nominee", method: "external", occurred_at: "2026-08-07T10:00:00Z", external_evidence_reference: "HIST", payload: {} })).resolves.toMatchObject({ status: "accepted" });
  });

  it("routes post-Start risk-role and effective worker-role withdrawal to urgent review", async () => {
    ex.setUser(fx.workerAUid);
    await expect(ex.callRpc("cmd_start_shift", { command_id: "start-role-review", shift_id: fx.shiftId, expected_version: 1, claimed_at: "2026-08-07T10:00:00Z", client_tz: "Australia/Sydney", payload: {} })).resolves.toMatchObject({ status: "accepted" });
    const role = await ex.execAsService(`select role_version_id from public.participant_service_context_versions where id='${fx.contextId}'`);
    await ex.execAsService(`update public.risk_assessed_role_versions set effective_until='2026-08-07T10:30:00Z' where id='${(role.rows[0] as { role_version_id: string }).role_version_id}'`);
    let shift = await ex.execAsService(`select state from public.shifts where id='${fx.shiftId}'`);
    expect(shift.rows[0]).toMatchObject({ state: "urgent_provider_review" });

    // PGlite exposes one connection, so exercise the production trigger/lock path
    // directly, then prove a second role authority source produces the same outcome.
    const lockTrigger = await ex.execAsService(`
      select pg_catalog.pg_get_triggerdef(t.oid) as trigger_def,
             pg_catalog.pg_get_functiondef(t.tgfoid) as function_def
      from pg_catalog.pg_trigger t
      where t.tgname='ticket05b_lock_membership_roles'
    `);
    expect(lockTrigger.rows[0]).toMatchObject({
      trigger_def: expect.stringContaining("BEFORE"),
      function_def: expect.stringContaining("lock_05b_readiness"),
    });
    await ex.execAsService(`update public.risk_assessed_role_versions set effective_until=null where id='${(role.rows[0] as { role_version_id: string }).role_version_id}'`);
    await ex.execAsService(`update public.shifts set state='started' where id='${fx.shiftId}'`);
    await ex.execAsService(`insert into public.organisation_membership_roles(membership_id,role,status,effective_from) values ('${workerMembership}','worker','withdrawn','2026-08-01') on conflict(membership_id,role) do update set status='withdrawn',effective_from='2026-08-01'`);
    shift = await ex.execAsService(`select state from public.shifts where id='${fx.shiftId}'`);
    expect(shift.rows[0]).toMatchObject({ state: "urgent_provider_review" });
  });

  it("returns the original capability receipt before revalidating changed scope state", async () => {
    const scope = await ex.execAsService(`select id from public.organisation_provider_scope_versions where organisation_id='${fx.orgId}' limit 1`);
    const args = { command_id: "capability-exact-retry", organisation_id: fx.orgId, scope_version_id: (scope.rows[0] as { id: string }).id, support_category: "daily_living", service_kind: "individual_time", capability: "individual_time_supported", effective_from: "2026-08-07", effective_until: "2026-08-08", payload: {} };
    ex.setUser(fx.adminUid);
    const first = await ex.callRpc("cmd_admin_create_support_capability", args) as { receipt_id: string };
    await ex.execAsService(`update public.organisation_provider_scope_versions set status='withdrawn' where id='${args.scope_version_id}'`);
    await expect(ex.callRpc("cmd_admin_create_support_capability", args)).resolves.toMatchObject({ status: "duplicate_returned", receipt_id: first.receipt_id });
  });

  it("uses the actor-bound completed-receipt fast path in every 05b command family", async () => {
    const commands = [
      "cmd_admin_create_service_ready_shift", "cmd_admin_reveal_participant_ndis_identifier", "cmd_admin_set_ndis_identifier",
      "cmd_admin_create_service_context", "cmd_admin_record_acknowledgement", "cmd_admin_create_provider_scope_version",
      "cmd_admin_create_support_capability", "cmd_admin_create_catalogue_item", "cmd_admin_record_worker_verification",
      "cmd_admin_record_competence_evidence", "cmd_admin_create_risk_role", "cmd_admin_create_screening_policy",
      "cmd_admin_create_competence_requirement", "cmd_admin_record_worker_pathway", "cmd_admin_update_service_context_state",
    ];
    const defs = await ex.execAsService(`
      select p.proname,pg_catalog.pg_get_functiondef(p.oid) as definition
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any(array[${commands.map((name) => `'${name}'`).join(",")}])
    `);
    expect(defs.rows).toHaveLength(commands.length);
    for (const row of defs.rows as Array<{ proname: string; definition: string }>) {
      const lookup = row.definition.indexOf("lookup_05b_admin_retry");
      const reserve = row.definition.indexOf("reserve_admin_command");
      expect(lookup, `${row.proname} has completed-receipt lookup`).toBeGreaterThan(0);
      expect(lookup, `${row.proname} looks up before reservation/mutable validation`).toBeLessThan(reserve);
    }
  });
});
