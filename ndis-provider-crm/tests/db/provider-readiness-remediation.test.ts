import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestDb, type Executor } from "./harness";
import { seedStandardFixture, type Fixture } from "./fixtures";

let ex: Executor;
let fx: Fixture;

beforeEach(async () => { ex = await bootTestDb(); fx = await seedStandardFixture(ex); });
afterEach(async () => { await ex.raw.close(); });

describe("05b hardening invariants", () => {
  it("rejects direct snapshot mutation and cross-tenant evidence links", async () => {
    await expect(ex.execAsService(`update public.shift_service_snapshots set goal_display='changed' where shift_id='${fx.shiftId}'`)).rejects.toThrow("immutable_evidence");
    const otherOrg = "99999999-9999-4999-8999-999999999901";
    await ex.execAsService(`insert into public.organisations(id,name,slug) values ('${otherOrg}','Other','other')`);
    await expect(ex.execAsService(`insert into public.participant_service_context_versions(organisation_id,participant_id,capability_id,catalogue_item_id,external_agreement_reference,source_type,owner_profile_id,effective_from,effective_until,goal_source,goal_reference,goal_display,lifecycle_state) select '${otherOrg}', '${fx.participantId}', capability_id, catalogue_item_id, 'x','provider','${fx.adminUid}','2026-08-06','2026-09-01','x','x','x','draft' from public.participant_service_context_versions where id='${fx.contextId}'`)).rejects.toThrow();
  });

  it("keeps attempts separate and resolves an immutable conclusive chain", async () => {
    ex.setUser(fx.schedulerUid);
    const attempt = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-attempt", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "attempt", event_type: "unavailable_attempt", occurred_at: "2026-08-07T08:59:00Z", reason: "Signer unavailable", payload: {} });
    expect(attempt).toMatchObject({ status: "accepted" });
    ex.setUser(fx.adminUid);
    const root = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-root", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_signed", occurred_at: "2026-08-07T09:00:00Z", external_evidence_reference: "SYN-ACK-1", payload: {} });
    const rootId = (root as { event_id: string }).event_id;
    const successor = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-successor", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_decline_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_decline", occurred_at: "2026-08-07T09:05:00Z", external_evidence_reference: "SYN-ACK-2", expected_current_event_id: rootId, reason: "Declined", payload: {} });
    expect(successor).toMatchObject({ status: "accepted" });
    const current = await ex.execAsService(`select id,event_type,supersedes_event_id from public.service_acknowledgement_current where shift_id='${fx.shiftId}'`);
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]).toMatchObject({ event_type: "external_decline_evidence", supersedes_event_id: rootId });
    await expect(ex.execAsService(`delete from public.service_acknowledgement_events where id='${rootId}'`)).rejects.toThrow("immutable_evidence");
  });

  it("quarantines a stale correction without forking the current leaf", async () => {
    ex.setUser(fx.adminUid);
    const root = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-root-stale", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_signed", occurred_at: "2026-08-07T09:00:00Z", external_evidence_reference: "SYN-ACK-ROOT", payload: {} });
    const rootId = (root as { event_id: string }).event_id;
    await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-next-stale", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_decline_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_decline", occurred_at: "2026-08-07T09:01:00Z", external_evidence_reference: "SYN-ACK-NEXT", expected_current_event_id: rootId, payload: {} });
    const stale = await ex.callRpc("cmd_admin_record_acknowledgement", { command_id: "ack-conflict", organisation_id: fx.orgId, shift_id: fx.shiftId, event_class: "conclusive", event_type: "external_signed_evidence", reported_signer_profile_id: fx.participantUid, authority_type: "participant_self", method: "external_signed", occurred_at: "2026-08-07T09:02:00Z", external_evidence_reference: "SYN-ACK-CONFLICT", expected_current_event_id: rootId, payload: {} });
    expect(stale).toMatchObject({ status: "conflict_preserved" });
    const leaves = await ex.execAsService(`select count(*)::int as c from public.service_acknowledgement_current where shift_id='${fx.shiftId}'`);
    expect(leaves.rows[0]).toMatchObject({ c: 1 });
    const reviews = await ex.execAsService(`select count(*)::int as c from public.service_acknowledgement_reviews where shift_id='${fx.shiftId}'`);
    expect(reviews.rows[0]).toMatchObject({ c: 1 });
  });
});
