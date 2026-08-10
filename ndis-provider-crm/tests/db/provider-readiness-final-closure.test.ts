import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedOrgAInactiveMemberships, seedStandardFixture, type Fixture } from "./fixtures";
import { bootTestDb, type Executor } from "./harness";

let ex: Executor;
let fx: Fixture;
let workerMembership: string;

beforeEach(async () => {
  ex = await bootTestDb();
  fx = await seedStandardFixture(ex);
  const assignment = await ex.execAsService(`select membership_id from public.shift_assignments where shift_id='${fx.shiftId}' and withdrawn_at is null`);
  workerMembership = String((assignment.rows[0] as { membership_id: string }).membership_id);
});

afterEach(async () => { await ex.raw.close(); });

async function readiness(): Promise<Record<string, unknown>> {
  const result = await ex.execAsService(`select public.provider_readiness('${fx.orgId}','${workerMembership}','${fx.participantId}','${fx.contextId}','2026-08-07T10:00:00Z','2026-08-07T11:00:00Z') as value`);
  return (result.rows[0] as { value: Record<string, unknown> }).value;
}

describe("Ticket 05b repeat-review closure", () => {
  it("denies no-role readiness and cross-tenant acknowledgement-ledger callers", async () => {
    ex.setUser(fx.noRoleUid);
    await expect(ex.exec(`select public.provider_readiness('${fx.orgId}','${workerMembership}','${fx.participantId}','${fx.contextId}','2026-08-07T10:00:00Z','2026-08-07T11:00:00Z')`)).rejects.toThrow("readiness_not_authorised");
    const other = await seedOrgAInactiveMemberships(ex);
    ex.setUser(other.otherOrgWorkerUid);
    await expect(ex.exec(`select * from public.list_admin_acknowledgement_ledger('${fx.orgId}',null)`)).rejects.toThrow("admin_or_scheduler_required");
  });

  it("rejects expired capability/catalogue, nullable jurisdiction, participant mismatch and unrelated role evidence", async () => {
    const ids = (await ex.execAsService(`select c.capability_id,c.catalogue_item_id,i.catalogue_version_id,c.role_version_id from public.participant_service_context_versions c join public.provider_support_items i on i.id=c.catalogue_item_id where c.id='${fx.contextId}'`)).rows[0] as Record<string, string>;
    await ex.execAsService(`update public.organisation_support_capabilities set effective_until='2026-08-07T09:00:00Z' where id='${ids.capability_id}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "capability_not_supported" });
    await ex.execAsService(`update public.organisation_support_capabilities set effective_until=null where id='${ids.capability_id}'`);
    await ex.execAsService(`update public.provider_support_catalogue_versions set status='withdrawn',effective_until='2026-08-07T09:00:00Z' where id='${ids.catalogue_version_id}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "catalogue_version_not_current" });
    await ex.execAsService(`update public.provider_support_catalogue_versions set status='active',effective_until=null where id='${ids.catalogue_version_id}'`);
    await ex.execAsService(`update public.participant_service_context_versions set jurisdiction=null where id='${fx.contextId}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "context_not_current" });
    await ex.execAsService(`update public.participant_service_context_versions set jurisdiction='NSW' where id='${fx.contextId}'`);
    const mismatch = await ex.execAsService(`select public.provider_readiness('${fx.orgId}','${workerMembership}','00000000-0000-4000-8000-000000000001','${fx.contextId}','2026-08-07T10:00:00Z','2026-08-07T11:00:00Z') as value`);
    expect((mismatch.rows[0] as { value: unknown }).value).toMatchObject({ ready: false, reason: "participant_context_mismatch" });
    const otherRole = "00000000-0000-4000-8000-000000000002";
    await ex.execAsService(`insert into public.risk_assessed_role_versions(id,organisation_id,title,definition_basis,description,assessed_at,assessor_name,assessor_title,risk_assessed,effective_from,created_by) values ('${otherRole}','${fx.orgId}','Unrelated role','test','not service-bound','2026-08-06','Admin','Admin',true,'2026-08-06','${fx.adminUid}')`);
    await ex.execAsService(`update public.participant_service_context_versions set role_version_id='${otherRole}' where id='${fx.contextId}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "screening_not_current" });
  });

  it("enforces verification and competence intervals plus every adverse status", async () => {
    const verificationResult = await ex.execAsService(`select id from public.worker_screening_verification_versions where worker_membership_id='${workerMembership}' order by created_at desc limit 1`);
    const evidenceResult = await ex.execAsService(`select id from public.worker_competence_evidence_versions where worker_membership_id='${workerMembership}' order by created_at desc limit 1`);
    const verification = String((verificationResult.rows[0] as { id: string }).id);
    const evidence = String((evidenceResult.rows[0] as { id: string }).id);
    await ex.execAsService(`update public.worker_screening_verification_versions set effective_from='2026-08-07T12:00:00Z' where id='${verification}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "screening_not_current" });
    await ex.execAsService(`update public.worker_screening_verification_versions set effective_from='2026-08-06T00:00:00Z' where id='${verification}'`);
    await ex.execAsService(`update public.worker_competence_evidence_versions set effective_until='2026-08-07T10:30:00Z' where id='${evidence}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "competence_not_current" });
    for (const column of ["interim_bar", "suspension", "exclusion", "revocation"]) {
      await ex.execAsService(`update public.worker_competence_evidence_versions set effective_until=null where id='${evidence}'`);
      await ex.execAsService(`update public.worker_screening_verification_versions set ${column}=true where id='${verification}'`);
      expect(await readiness()).toMatchObject({ ready: false, reason: "adverse_screening_status" });
      await ex.execAsService(`update public.worker_screening_verification_versions set ${column}=false where id='${verification}'`);
    }
  });

  it("requires complete named pathway fields and a different live cleared supervisor", async () => {
    const roleResult = await ex.execAsService(`select role_version_id from public.participant_service_context_versions where id='${fx.contextId}'`);
    const role = String((roleResult.rows[0] as { role_version_id: string }).role_version_id);
    const supervisor = (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerBUid}'`)).rows[0] as { id: string };
    await ex.execAsService(`update public.worker_screening_verification_versions set clearance_status='pending' where worker_membership_id='${workerMembership}'`);
    await ex.execAsService(`insert into public.worker_screening_verification_versions(organisation_id,worker_membership_id,role_version_id,source_checked,verifier_name,verified_at,application_or_check_reference,clearance_status,clearance_expires_at,effective_from,created_by) values ('${fx.orgId}','${supervisor.id}','${role}','test','Admin','2026-08-06','SUP-CLEAR','current','2026-09-01','2026-08-06','${fx.adminUid}')`);
    await ex.execAsService(`insert into public.worker_screening_pathway_versions(organisation_id,worker_membership_id,role_version_id,pathway,jurisdiction,application_placement_contract_reference,pathway_start,pathway_end,supervisor_membership_id,supervisor_clearance_reference,risk_management_plan_reference,effective_from,effective_until,created_by) values ('${fx.orgId}','${workerMembership}','${role}','working_on_application','NSW','APP-1','2026-08-06','2026-09-01','${supervisor.id}','SUP-CLEAR','RISK-1','2026-08-06','2026-09-01','${fx.adminUid}')`);
    expect(await readiness()).toMatchObject({ ready: true, screening_source: "named_pathway" });
    await ex.execAsService(`update public.worker_screening_pathway_versions set risk_management_plan_reference='' where worker_membership_id='${workerMembership}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "screening_not_current" });
    await ex.execAsService(`update public.worker_screening_pathway_versions set risk_management_plan_reference='RISK-1' where worker_membership_id='${workerMembership}'`);
    await ex.execAsService(`update public.organisation_memberships set status='suspended' where id='${supervisor.id}'`);
    expect(await readiness()).toMatchObject({ ready: false, reason: "screening_not_current" });
  });

  it("routes a post-Start worker-evidence revocation to urgent provider review without deleting evidence", async () => {
    ex.setUser(fx.workerAUid);
    const started = await ex.callRpc("cmd_start_shift", { command_id: "start-before-revocation", shift_id: fx.shiftId, expected_version: 1, claimed_at: "2026-08-07T10:00:00Z", client_tz: "Australia/Sydney", payload: {} });
    expect(started).toMatchObject({ status: "accepted" });
    const eventsBefore = await ex.execAsService(`select count(*)::int as count from public.shift_events where shift_id='${fx.shiftId}'`);
    await ex.execAsService(`update public.worker_screening_verification_versions set revocation=true where worker_membership_id='${workerMembership}'`);
    const shift = await ex.execAsService(`select state from public.shifts where id='${fx.shiftId}'`);
    expect(shift.rows[0]).toMatchObject({ state: "urgent_provider_review" });
    const eventsAfter = await ex.execAsService(`select count(*)::int as count from public.shift_events where shift_id='${fx.shiftId}'`);
    expect(eventsAfter.rows[0]).toEqual(eventsBefore.rows[0]);
  });

  it("supports the complete masked identifier/admin reveal/audit flow and rejects scheduler reveal", async () => {
    ex.setUser(fx.adminUid);
    await expect(ex.callRpc("cmd_admin_set_ndis_identifier", { command_id: "identifier-set", organisation_id: fx.orgId, participant_id: fx.participantId, identifier: "43000000123", payload: {} })).resolves.toMatchObject({ status: "accepted", masked_identifier: "*******0123" });
    const masked = await ex.exec(`select * from public.list_admin_masked_participant_ndis_identifiers('${fx.orgId}')`);
    expect(masked.rows[0]).toMatchObject({ participant_id: fx.participantId, masked_identifier: "*******0123" });
    const reveal = await ex.callRpc("cmd_admin_reveal_participant_ndis_identifier", { command_id: "identifier-reveal", organisation_id: fx.orgId, participant_id: fx.participantId, reason: "Prepare synthetic acceptance evidence", payload: {} });
    expect(reveal).toMatchObject({ identifier: "43000000123" });
    const audit = await ex.execAsService(`select count(*)::int as count from public.audit_log where action='participant_ndis_identifier.revealed' and subject_id='${fx.participantId}'`);
    expect(audit.rows[0]).toMatchObject({ count: 1 });
    ex.setUser(fx.schedulerUid);
    await expect(ex.callRpc("cmd_admin_reveal_participant_ndis_identifier", { command_id: "identifier-scheduler", organisation_id: fx.orgId, participant_id: fx.participantId, reason: "not allowed", payload: {} })).rejects.toThrow("admin_required");
  });

  it("requires reviewed context activation with explicit role and jurisdiction", async () => {
    const context = (await ex.execAsService(`select capability_id,catalogue_item_id,role_version_id from public.participant_service_context_versions where id='${fx.contextId}'`)).rows[0] as Record<string, string>;
    ex.setUser(fx.adminUid);
    const draft = await ex.callRpc("cmd_admin_create_service_context", { command_id: "context-draft", organisation_id: fx.orgId, participant_id: fx.participantId, capability_id: context.capability_id, catalogue_item_id: context.catalogue_item_id, role_version_id: context.role_version_id, jurisdiction: "NSW", external_agreement_reference: "AGREEMENT-2", plan_reference: "PLAN-2", source_type: "provider_recorded", owner_profile_id: fx.adminUid, reviewer_profile_id: null, effective_from: "2026-08-07", effective_until: "2026-08-08", goal_source: "participant_goal", goal_reference: "GOAL-2", goal_display: "Second goal", lifecycle_state: "draft", screening_required: false, payload: {} }) as { service_context_id: string };
    await expect(ex.callRpc("cmd_admin_update_service_context_state", { command_id: "activate-unreviewed", organisation_id: fx.orgId, context_id: draft.service_context_id, lifecycle_state: "active", reviewer_profile_id: null, role_version_id: context.role_version_id, jurisdiction: "NSW", reason: "review", payload: {} })).rejects.toThrow("reviewed_context_required");
    await expect(ex.callRpc("cmd_admin_update_service_context_state", { command_id: "activate-reviewed", organisation_id: fx.orgId, context_id: draft.service_context_id, lifecycle_state: "active", reviewer_profile_id: fx.adminUid, role_version_id: context.role_version_id, jurisdiction: "NSW", reason: "review complete", payload: {} })).resolves.toMatchObject({ status: "accepted", lifecycle_state: "active" });
  });

  it("rejects malformed admin scope/catalogue/pathway writes before reserving a command", async () => {
    ex.setUser(fx.adminUid);
    await expect(ex.exec(`select public.cmd_admin_create_provider_scope_version('invalid-scope','${fx.orgId}','registered','group','individual',array['  ']::text[],'2026-08-07','2026-08-08','${fx.adminUid}','{}'::jsonb)`)).rejects.toThrow("provider_scope_invalid");
    await expect(ex.exec(`select public.cmd_admin_create_catalogue_item('invalid-catalogue','${fx.orgId}','Source','v1','2026-08-07','2026-08-08','ITEM','Item','daily_living','hour','individual_time','2026-08-06','2026-08-09','{}'::jsonb)`)).rejects.toThrow("catalogue_item_invalid");
    const roleResult = await ex.execAsService(`select role_version_id from public.participant_service_context_versions where id='${fx.contextId}'`);
    const role = String((roleResult.rows[0] as { role_version_id: string }).role_version_id);
    await expect(ex.exec(`select public.cmd_admin_record_worker_pathway('invalid-pathway','${fx.orgId}','${workerMembership}','${role}','working_on_application','NSW','APP','2026-08-06','2026-08-09','${workerMembership}','CLEAR','RISK',null,'2026-08-07','2026-08-08','{}'::jsonb)`)).rejects.toThrow("screening_pathway_invalid");
    const receipts = await ex.execAsService(`select count(*)::int as count from public.command_receipts where command_id in ('invalid-scope','invalid-catalogue','invalid-pathway')`);
    expect(receipts.rows[0]).toMatchObject({ count: 0 });
  });

  it("resolves four conclusive corrections, duplicate retry and stale quarantine to one current leaf", async () => {
    ex.setUser(fx.adminUid);
    let expected: string | null = null;
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const event = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: `ack-chain-${index}`, organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: index % 2 === 0 ? "external_signed_evidence" : "external_decline_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_record", occurred_at: `2026-08-07T09:0${index}:00Z`, reason: index === 0 ? "Initial" : `Correction ${index}`, external_evidence_reference: `ACK-${index}`, expected_current_event_id: expected, payload: {} }) as { status: string; event_id: string };
      expect(event.status).toBe("accepted"); ids.push(event.event_id); expected = event.event_id;
    }
    const duplicate = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-chain-3", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_decline_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_record", occurred_at: "2026-08-07T09:03:00Z", reason: "Correction 3", external_evidence_reference: "ACK-3", expected_current_event_id: ids[2], payload: {} });
    expect(duplicate).toMatchObject({ status: "duplicate_returned" });
    const stale = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-chain-stale", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_record", occurred_at: "2026-08-07T09:04:00Z", reason: "Stale", external_evidence_reference: "ACK-STALE", expected_current_event_id: ids[1], payload: {} });
    expect(stale).toMatchObject({ status: "conflict_preserved" });
    await expect(ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-blank-correction", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_record", occurred_at: "2026-08-07T09:05:00Z", reason: " ", external_evidence_reference: "ACK-BLANK", expected_current_event_id: ids[3], payload: {} })).rejects.toThrow("ack_correction_reason_required");
    const ledger = await ex.exec(`select * from public.list_admin_acknowledgement_ledger('${fx.orgId}','${fx.shiftId}')`);
    expect(ledger.rows.filter((row) => (row as { current_leaf: boolean }).current_leaf)).toHaveLength(1);
    expect(ledger.rows.filter((row) => (row as { review_only: boolean }).review_only)).toHaveLength(1);
    expect(ledger.rows).toHaveLength(5);
  });
});
