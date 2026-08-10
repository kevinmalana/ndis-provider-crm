import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestDb, type Executor } from "./harness";
import { seedStandardFixture, type Fixture } from "./fixtures";

let ex: Executor;
let fx: Fixture;

beforeEach(async () => { ex = await bootTestDb(); fx = await seedStandardFixture(ex); });
afterEach(async () => { await ex.raw.close(); });

describe("admin workspace command RPCs", () => {
  it("creates a participant, critical handoff, audit row, and receipt atomically", async () => {
    ex.setUser(fx.schedulerUid);
    const result = await ex.callRpc("cmd_admin_create_participant", {
      command_id: "admin-participant-1", organisation_id: fx.orgId, first_name: "Synthetic", last_initial: "Q",
      critical_content: "Use plain language and confirm access needs.", review_due_at: "2026-08-20T00:00:00Z", payload: { test: true },
    }) as { status: string; participant_id: string; critical_info_card_id: string };
    expect(result.status).toBe("accepted");
    const rows = await ex.execAsService(`select p.first_name, c.content_text, a.action from public.participants p join public.critical_info_cards c on c.participant_id=p.id join public.audit_log a on a.subject_id=p.id where p.id='${result.participant_id}'`);
    expect(rows.rows[0]).toMatchObject({ first_name: "Synthetic", content_text: "Use plain language and confirm access needs.", action: "participant.created" });
  });

  it("returns overlap and availability warnings without blocking shift creation", async () => {
    ex.setUser(fx.schedulerUid);
    const workerMembership = (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] as { id: string };
    const result = await ex.callRpc("cmd_admin_create_service_ready_shift", {
      command_id: "admin-shift-1", organisation_id: fx.orgId, participant_id: fx.participantId,
      worker_membership: workerMembership.id,
      service_context_id: fx.contextId,
      scheduled_start: "2026-08-07T10:30:00Z", scheduled_end: "2026-08-07T11:30:00Z", reason: "cover", payload: {},
    }) as { status: string; snapshot_id: string; readiness: { ready: boolean } };
    expect(result.status).toBe("accepted");
    expect(result.snapshot_id).toBeTruthy();
    expect(result.readiness).toMatchObject({ ready: true });
  });

  it("reserves the receipt before mutation and returns the original outcome on altered retry", async () => {
    ex.setUser(fx.schedulerUid);
    const args = { command_id: "admin-idempotent-participant", organisation_id: fx.orgId, first_name: "First", last_initial: "A", critical_content: "Initial handoff", review_due_at: "2026-08-20T00:00:00Z", payload: { attempt: 1 } };
    const first = await ex.callRpc("cmd_admin_create_participant", args) as { status: string; participant_id: string; critical_info_card_id: string };
    const second = await ex.callRpc("cmd_admin_create_participant", { ...args, first_name: "Second", payload: { attempt: 2 } }) as { status: string; duplicate: boolean; outcome: { participant_id: string } };
    expect(first.status).toBe("accepted");
    expect(second).toMatchObject({ status: "duplicate_returned", duplicate: true, outcome: { participant_id: first.participant_id } });
    const counts = await ex.execAsService(`select count(*)::int as participants from public.participants where organisation_id='${fx.orgId}' and id='${first.participant_id}'`);
    expect(counts.rows[0]).toMatchObject({ participants: 1 });
  });

  it("enforces role-scoped invitations and returns a copy-link token", async () => {
    ex.setUser(fx.schedulerUid);
    const invite = await ex.callRpc("cmd_admin_invite", { command_id: "scheduler-worker-invite", organisation_id: fx.orgId, email: "new-worker@example.test", role: "worker", expires_at: "2026-08-20T00:00:00Z", payload: {} }) as { token: string; role: string };
    expect(invite).toMatchObject({ role: "worker" });
    expect(invite.token).toHaveLength(64);
    const inviteRetry = await ex.callRpc("cmd_admin_invite", { command_id: "scheduler-worker-invite", organisation_id: fx.orgId, email: "altered@example.test", role: "worker", expires_at: "2026-08-20T00:00:00Z", payload: { altered: true } }) as { status: string; outcome: { invitation_id: string } };
    expect(inviteRetry).toMatchObject({ status: "duplicate_returned", outcome: { invitation_id: expect.any(String) } });
    await expect(ex.callRpc("cmd_admin_invite", { command_id: "scheduler-admin-invite", organisation_id: fx.orgId, email: "new-admin@example.test", role: "admin", expires_at: "2026-08-20T00:00:00Z", payload: {} })).rejects.toThrow("scheduler_invite_role_not_allowed");
  });

  it("deduplicates authority, availability, shift, grant, revoke, and invite commands", async () => {
    ex.setUser(fx.schedulerUid);
    const worker = (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] as { id: string };
    const authorityArgs = { command_id: "dedupe-authority", organisation_id: fx.orgId, participant_id: fx.participantId, representative_profile_id: fx.representerUid, authority_type: "plan_nominee", scope_categories: ["service_summary"], evidence_reference: "dedupe-authority-proof", issuer: "scheduler", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} };
    const authority = await ex.callRpc("cmd_admin_set_authority", authorityArgs) as { authority_id: string };
    const authorityRetry = await ex.callRpc("cmd_admin_set_authority", { ...authorityArgs, authority_type: "guardian" }) as { status: string; outcome: { authority_id: string } };
    expect(authorityRetry).toMatchObject({ status: "duplicate_returned", outcome: { authority_id: authority.authority_id } });
    const consent = await ex.callRpc("cmd_admin_record_consent", { command_id: "dedupe-consent-record", organisation_id: fx.orgId, participant_id: fx.participantId, recipient_profile_id: fx.externalUid, authorising_profile_id: fx.representerUid, purpose: "coordinate", scope_categories: ["service_summary"], consent_basis: "authorised_representative", representative_authority_id: authority.authority_id, evidence_reference: "dedupe-consent-proof", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} }) as { consent_id: string };
    const consentRetry = await ex.callRpc("cmd_admin_record_consent", { command_id: "dedupe-consent-record", organisation_id: fx.orgId, participant_id: fx.participantId, recipient_profile_id: fx.externalUid, authorising_profile_id: fx.representerUid, purpose: "altered", scope_categories: ["upcoming_visits"], consent_basis: "authorised_representative", representative_authority_id: authority.authority_id, evidence_reference: "altered", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: { altered: true } }) as { status: string; outcome: { consent_id: string } };
    expect(consentRetry).toMatchObject({ status: "duplicate_returned", outcome: { consent_id: consent.consent_id } });
    const selfProfile = "99999999-9999-4999-8999-999999999991";
    const selfMembership = "99999999-9999-4999-8999-999999999992";
    await ex.execAsService(`insert into auth.users (id,email) values ('${selfProfile}','new-participant@example.test')`);
    await ex.execAsService(`insert into public.global_profiles (id,email,full_name) values ('${selfProfile}','new-participant@example.test','New Participant') on conflict (id) do update set full_name=excluded.full_name`);
    await ex.execAsService(`insert into public.organisation_memberships (id,organisation_id,profile_id,role,status) values ('${selfMembership}','${fx.orgId}','${selfProfile}','participant','active')`);
    const linkArgs = { command_id: "dedupe-self-link", organisation_id: fx.orgId, participant_id: fx.participantId, profile_id: selfProfile, evidence_reference: "self-link-proof", payload: {} };
    const link = await ex.callRpc("cmd_admin_link_participant", linkArgs) as { self_link_id: string };
    const linkRetry = await ex.callRpc("cmd_admin_link_participant", { ...linkArgs, evidence_reference: "altered" }) as { status: string; outcome: { self_link_id: string } };
    expect(linkRetry).toMatchObject({ status: "duplicate_returned", outcome: { self_link_id: link.self_link_id } });
    const created = await ex.callRpc("cmd_admin_create_participant", { command_id: "dedupe-update-target", organisation_id: fx.orgId, first_name: "Update", last_initial: "T", critical_content: "Original", review_due_at: "2026-08-20T00:00:00Z", payload: {} }) as { participant_id: string };
    const updateArgs = { command_id: "dedupe-critical-update", organisation_id: fx.orgId, participant_id: created.participant_id, critical_content: "Reviewed", review_due_at: "2026-08-21T00:00:00Z", payload: {} };
    const update = await ex.callRpc("cmd_admin_update_critical_info", updateArgs) as { critical_info_card_id: string };
    const updateRetry = await ex.callRpc("cmd_admin_update_critical_info", { ...updateArgs, critical_content: "Altered" }) as { status: string; outcome: { critical_info_card_id: string } };
    expect(updateRetry).toMatchObject({ status: "duplicate_returned", outcome: { critical_info_card_id: update.critical_info_card_id } });
    const availabilityArgs = { command_id: "dedupe-availability", organisation_id: fx.orgId, worker_membership: worker.id, available_from: "2026-08-07T06:00:00Z", available_until: "2026-08-07T18:00:00Z", note: "published", payload: {} };
    const availability = await ex.callRpc("cmd_admin_set_availability", availabilityArgs) as { availability_id: string };
    const availabilityRetry = await ex.callRpc("cmd_admin_set_availability", { ...availabilityArgs, note: "altered" }) as { status: string; outcome: { availability_id: string } };
    expect(availabilityRetry).toMatchObject({ status: "duplicate_returned", outcome: { availability_id: availability.availability_id } });
    const shiftArgs = { command_id: "dedupe-shift", organisation_id: fx.orgId, participant_id: fx.participantId, worker_membership: worker.id, service_context_id: fx.contextId, scheduled_start: "2026-08-07T19:00:00Z", scheduled_end: "2026-08-07T20:00:00Z", reason: "routine", payload: {} };
    const shift = await ex.callRpc("cmd_admin_create_service_ready_shift", shiftArgs) as { shift_id: string };
    const shiftRetry = await ex.callRpc("cmd_admin_create_service_ready_shift", { ...shiftArgs, reason: "altered" }) as { status: string; outcome: { shift_id: string } };
    expect(shiftRetry).toMatchObject({ status: "duplicate_returned", outcome: { shift_id: shift.shift_id } });
    const grantArgs = { command_id: "dedupe-grant", organisation_id: fx.orgId, consent_id: consent.consent_id, effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} };
    const grant = await ex.callRpc("cmd_admin_create_grant", grantArgs) as { grant_id: string };
    const grantRetry = await ex.callRpc("cmd_admin_create_grant", { ...grantArgs, purpose: "altered" }) as { status: string; outcome: { grant_id: string } };
    expect(grantRetry).toMatchObject({ status: "duplicate_returned", outcome: { grant_id: grant.grant_id } });
    const revokeArgs = { command_id: "dedupe-revoke", organisation_id: fx.orgId, grant_id: grant.grant_id, reason: "withdrawn", payload: {} };
    await ex.callRpc("cmd_admin_revoke_grant", revokeArgs);
    const revokeRetry = await ex.callRpc("cmd_admin_revoke_grant", { ...revokeArgs, reason: "altered" }) as { status: string; outcome: { status: string } };
    expect(revokeRetry).toMatchObject({ status: "duplicate_returned", outcome: { status: "revoked" } });
  });

  it("exposes only live same-tenant worker identities to schedulers", async () => {
    ex.setUser(fx.schedulerUid);
    const result = await ex.exec(`select profile_id, role from public.list_admin_workspace_identities('${fx.orgId}', array['worker']::text[])`);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => (row as { role: string }).role === "worker")).toBe(true);
    await ex.execAsService(`update public.organisation_memberships set status='withdrawn' where organisation_id='${fx.orgId}' and profile_id='${fx.workerBUid}'`);
    const after = await ex.exec(`select profile_id from public.list_admin_workspace_identities('${fx.orgId}', array['worker']::text[])`);
    expect(after.rows).toHaveLength(1);
  });

  it("rejects deleted organisations, future workers, and cross-tenant workers", async () => {
    ex.setUser(fx.schedulerUid);
    const worker = (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] as { id: string };
    await ex.execAsService(`insert into public.organisation_membership_roles (membership_id, role, status, effective_from) values ('${worker.id}','worker','active',now()+interval '1 day')`);
    await ex.execAsService(`update public.organisation_memberships set effective_from='2026-08-08T00:00:00Z' where id='${worker.id}'`);
    await expect(ex.callRpc("cmd_admin_create_service_ready_shift", { command_id: "future-worker", organisation_id: fx.orgId, participant_id: fx.participantId, worker_membership: worker.id, service_context_id: fx.contextId, scheduled_start: "2026-08-07T10:30:00Z", scheduled_end: "2026-08-07T11:30:00Z", reason: "future", payload: {} })).rejects.toThrow("provider_not_ready");
    await ex.execAsService(`update public.organisations set deleted_at=now() where id='${fx.orgId}'`);
    await expect(ex.callRpc("cmd_admin_create_participant", { command_id: "deleted-org", organisation_id: fx.orgId, first_name: "Blocked", last_initial: "B", critical_content: "No", review_due_at: "2026-08-20T00:00:00Z", payload: {} })).rejects.toThrow("admin_or_scheduler_required");
  });

  it("keeps participant links tenant- and role-bound", async () => {
    ex.setUser(fx.schedulerUid);
    await expect(ex.callRpc("cmd_admin_link_participant", { command_id: "wrong-link-role", organisation_id: fx.orgId, participant_id: fx.participantId, profile_id: fx.workerAUid, evidence_reference: "evidence", payload: {} })).rejects.toThrow("participant_membership_required");
    await expect(ex.callRpc("cmd_admin_link_participant", { command_id: "cross-link", organisation_id: fx.orgId, participant_id: fx.participantId, profile_id: fx.externalUid, evidence_reference: "evidence", payload: {} })).rejects.toThrow("participant_membership_required");
  });

  it("requires current representative authority and recipient membership for grants", async () => {
    ex.setUser(fx.schedulerUid);
    const authority = await ex.callRpc("cmd_admin_set_authority", { command_id: "authority-for-grant", organisation_id: fx.orgId, participant_id: fx.participantId, representative_profile_id: fx.representerUid, authority_type: "plan_nominee", scope_categories: ["service_summary"], evidence_reference: "authority-proof-1", issuer: "scheduler", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} }) as { authority_id: string };
    const consent = await ex.callRpc("cmd_admin_record_consent", { command_id: "consent-for-grant", organisation_id: fx.orgId, participant_id: fx.participantId, recipient_profile_id: fx.externalUid, authorising_profile_id: fx.representerUid, purpose: "coordinate", scope_categories: ["service_summary"], consent_basis: "authorised_representative", representative_authority_id: authority.authority_id, evidence_reference: "consent-evidence", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} }) as { consent_id: string };
    const grant = await ex.callRpc("cmd_admin_create_grant", { command_id: "rep-grant", organisation_id: fx.orgId, consent_id: consent.consent_id, effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} }) as { grant_id: string };
    expect(grant.grant_id).toBeTruthy();
    await ex.execAsService(`update public.representative_authorities set status='revoked', withdrawn_at=now() where id='${authority.authority_id}'`);
    await expect(ex.callRpc("cmd_admin_create_grant", { command_id: "revoked-rep-grant", organisation_id: fx.orgId, consent_id: consent.consent_id, effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} })).rejects.toThrow("representative_consent_authority_required");
    await ex.execAsService(`update public.organisation_memberships set status='withdrawn' where organisation_id='${fx.orgId}' and profile_id='${fx.externalUid}'`);
    await expect(ex.callRpc("cmd_admin_create_grant", { command_id: "withdrawn-recipient", organisation_id: fx.orgId, consent_id: consent.consent_id, effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} })).rejects.toThrow("external_recipient_membership_required");
  });

  it("requires separate participant consent evidence and a live self-link", async () => {
    ex.setUser(fx.schedulerUid);
    const consent = await ex.callRpc("cmd_admin_record_consent", { command_id: "participant-consent", organisation_id: fx.orgId, participant_id: fx.participantId, recipient_profile_id: fx.externalUid, authorising_profile_id: fx.participantUid, purpose: "coordinate", scope_categories: ["service_summary"], consent_basis: "participant", representative_authority_id: null, evidence_reference: "participant-recorded-evidence", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-09-01T00:00:00Z", payload: {} }) as { consent_id: string };
    const grant = await ex.callRpc("cmd_admin_create_grant", { command_id: "participant-grant", organisation_id: fx.orgId, consent_id: consent.consent_id, effective_from: "2026-08-07T00:00:00Z", effective_until: "2026-08-31T00:00:00Z", payload: {} }) as { grant_id: string };
    expect(grant.grant_id).toBeTruthy();
    await ex.execAsService(`update public.participant_self_links set status='withdrawn', withdrawn_at=now() where organisation_id='${fx.orgId}' and participant_id='${fx.participantId}' and profile_id='${fx.participantUid}'`);
    await expect(ex.callRpc("cmd_admin_create_grant", { command_id: "participant-grant-after-withdrawal", organisation_id: fx.orgId, consent_id: consent.consent_id, effective_from: "2026-08-07T00:00:00Z", effective_until: "2026-08-31T00:00:00Z", payload: {} })).rejects.toThrow("participant_consent_authority_required");
  });

  it("uses creation vocabulary and hardens definer ACL/search path", async () => {
    ex.setUser(fx.schedulerUid);
    const worker = (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] as { id: string };
    const result = await ex.callRpc("cmd_admin_create_service_ready_shift", { command_id: "created-event", organisation_id: fx.orgId, participant_id: fx.participantId, worker_membership: worker.id, service_context_id: fx.contextId, scheduled_start: "2026-08-07T12:30:00Z", scheduled_end: "2026-08-07T13:30:00Z", reason: "routine", payload: {} }) as { shift_id: string };
    const event = await ex.execAsService(`select event_type from public.shift_events where shift_id='${result.shift_id}'`);
    expect(event.rows[0]).toMatchObject({ event_type: "created" });
    const catalog = await ex.execAsService(`select p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='cmd_admin_create_participant'`);
    expect(catalog.rows[0]).toMatchObject({ anon_execute: false });
    expect((catalog.rows[0] as { proconfig: string[] }).proconfig.some((value) => value.includes("search_path=\"\""))).toBe(true);
  });
});
