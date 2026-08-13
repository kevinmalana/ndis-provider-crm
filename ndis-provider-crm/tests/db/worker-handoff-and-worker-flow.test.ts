import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootTestDb, type Executor } from "./harness";
import { seedOrgAInactiveMemberships, seedStandardFixture, type Fixture } from "./fixtures";

let ex: Executor;
let fx: Fixture;

beforeEach(async () => {
  ex = await bootTestDb();
  fx = await seedStandardFixture(ex);
});

afterEach(async () => {
  await ex.raw.close();
});

async function currentRouteId(routeType: "emergency" | "incident" | "complaint"): Promise<string> {
  const { rows } = await ex.execAsService(
    `select id
       from public.organisation_handoff_route_versions
      where organisation_id = '${fx.orgId}'
        and route_type = '${routeType}'
      order by effective_from desc, created_at desc
      limit 1`,
  );
  return String((rows[0] as { id: string }).id);
}

async function createTodayReadyShift(): Promise<string> {
  const now = new Date();
  const scheduledStart = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const scheduledEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const workerMembership = await ex.execAsService(
    `select membership_id
       from public.shift_assignments
      where shift_id = '${fx.shiftId}'
        and withdrawn_at is null
      limit 1`,
  );
  const membershipId = String((workerMembership.rows[0] as { membership_id: string }).membership_id);

  ex.setUser(fx.adminUid);
  const result = await ex.callRpc("cmd_admin_create_service_ready_shift", {
    command_id: `today-shift-${scheduledStart}`,
    organisation_id: fx.orgId,
    participant_id: fx.participantId,
    worker_membership: membershipId,
    service_context_id: fx.contextId,
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    reason: "today-list regression",
    payload: {},
  }) as { shift_id: string; status: string };

  expect(result).toMatchObject({ status: "accepted" });
  return result.shift_id;
}

describe("worker handoff route and receipt contract", () => {
  it("returns only current emergency and incident routes to the assigned worker", async () => {
    ex.setUser(fx.workerAUid);
    const { rows } = await ex.exec(
      `select * from public.list_worker_shift_handoff_routes('${fx.shiftId}')`,
    );
    const routes = rows as Array<{ route_type: string; primary_contact_uri: string }>;

    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.route_type).sort()).toEqual(["emergency", "incident"]);
    expect(routes.every((route) => route.primary_contact_uri.startsWith("tel:") || route.primary_contact_uri.startsWith("https://"))).toBe(true);
  });

  it("fails closed for a different worker and hides direct route-table reads from workers", async () => {
    ex.setUser(fx.workerBUid);
    await expect(
      ex.exec(`select * from public.list_worker_shift_handoff_routes('${fx.shiftId}')`),
    ).rejects.toThrow("not_assigned");

    const { rows } = await ex.exec(
      `select count(*)::int as c from public.organisation_handoff_route_versions`,
    );
    expect((rows[0] as { c: number }).c).toBe(0);
  });

  it("records initiated, worker_confirmed, and failed receipts distinctly and idempotently", async () => {
    const emergencyRouteId = await currentRouteId("emergency");
    const incidentRouteId = await currentRouteId("incident");

    ex.setUser(fx.workerAUid);
    const initiated = await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-1",
      shift_id: fx.shiftId,
      route_version_id: emergencyRouteId,
      event_type: "initiated",
      selected_channel: "primary",
      failure_code: null,
      claimed_at: "2026-08-07T09:45:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail" },
    });
    expect(initiated).toMatchObject({ status: "accepted", route_type: "emergency", event_type: "initiated" });

    const replay = await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-1",
      shift_id: fx.shiftId,
      route_version_id: emergencyRouteId,
      event_type: "initiated",
      selected_channel: "primary",
      failure_code: null,
      claimed_at: "2026-08-07T09:46:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail", retry: true },
    });
    expect(replay).toMatchObject({ status: "accepted", duplicate: true });

    const confirmed = await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-2",
      shift_id: fx.shiftId,
      route_version_id: emergencyRouteId,
      event_type: "worker_confirmed",
      selected_channel: "primary",
      failure_code: null,
      claimed_at: "2026-08-07T09:47:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail" },
    });
    expect(confirmed).toMatchObject({ status: "accepted", route_type: "emergency", event_type: "worker_confirmed" });

    const failed = await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-3",
      shift_id: fx.shiftId,
      route_version_id: incidentRouteId,
      event_type: "failed",
      selected_channel: "fallback",
      failure_code: "launch_failed",
      claimed_at: "2026-08-07T09:48:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail" },
    });
    expect(failed).toMatchObject({ status: "accepted", route_type: "incident", event_type: "failed" });

    const { rows } = await ex.execAsService(
      `select handoff_event, selected_channel, failure_code
         from public.worker_handoff_receipts
        where shift_id = '${fx.shiftId}'
        order by created_at`,
    );
    expect(rows).toEqual([
      { handoff_event: "initiated", selected_channel: "primary", failure_code: null },
      { handoff_event: "worker_confirmed", selected_channel: "primary", failure_code: null },
      { handoff_event: "failed", selected_channel: "fallback", failure_code: "launch_failed" },
    ]);
  });

  it("preserves not-assigned handoff attempts as conflict evidence", async () => {
    const emergencyRouteId = await currentRouteId("emergency");
    ex.setUser(fx.workerBUid);
    const result = await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-unassigned",
      shift_id: fx.shiftId,
      route_version_id: emergencyRouteId,
      event_type: "initiated",
      selected_channel: "primary",
      failure_code: null,
      claimed_at: "2026-08-07T09:49:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail" },
    });
    expect(result).toMatchObject({ status: "conflict_preserved", reason: "not_assigned" });
  });

  it("keeps direct handoff receipts visible to the actor and office only", async () => {
    const emergencyRouteId = await currentRouteId("emergency");
    ex.setUser(fx.workerAUid);
    await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-visible",
      shift_id: fx.shiftId,
      route_version_id: emergencyRouteId,
      event_type: "initiated",
      selected_channel: "primary",
      failure_code: null,
      claimed_at: "2026-08-07T09:50:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail" },
    });

    ex.setUser(fx.workerAUid);
    const ownRows = await ex.exec(
      `select count(*)::int as c
         from public.worker_handoff_receipts
        where shift_id = '${fx.shiftId}'`,
    );
    expect((ownRows.rows[0] as { c: number }).c).toBe(1);

    ex.setUser(fx.adminUid);
    const adminRows = await ex.exec(
      `select count(*)::int as c
         from public.worker_handoff_receipts
        where shift_id = '${fx.shiftId}'`,
    );
    expect((adminRows.rows[0] as { c: number }).c).toBe(1);

    ex.setUser(fx.workerBUid);
    const otherRows = await ex.exec(
      `select count(*)::int as c
         from public.worker_handoff_receipts
        where shift_id = '${fx.shiftId}'`,
    );
    expect((otherRows.rows[0] as { c: number }).c).toBe(0);
  });

  it("keeps worker handoff receipts immutable after append-only insertion", async () => {
    const emergencyRouteId = await currentRouteId("emergency");
    ex.setUser(fx.workerAUid);
    await ex.callRpc("cmd_worker_record_handoff", {
      command_id: "handoff-immutable",
      shift_id: fx.shiftId,
      route_version_id: emergencyRouteId,
      event_type: "initiated",
      selected_channel: "primary",
      failure_code: null,
      claimed_at: "2026-08-07T09:51:00Z",
      client_tz: "Australia/Sydney",
      payload: { source: "worker-detail" },
    });

    const receipt = await ex.execAsService(
      `select id from public.worker_handoff_receipts where shift_id = '${fx.shiftId}' limit 1`,
    );
    const receiptId = String((receipt.rows[0] as { id: string }).id);

    await expect(
      ex.execAsService(
        `update public.worker_handoff_receipts
            set selected_channel = 'fallback'
          where id = '${receiptId}'`,
      ),
    ).rejects.toThrow("immutable_evidence");
    await expect(
      ex.execAsService(`delete from public.worker_handoff_receipts where id = '${receiptId}'`),
    ).rejects.toThrow("immutable_evidence");
  });
});

describe("worker-safe today list and acknowledgement projection", () => {
  it("returns today’s assigned work with minimal location disclosure and route readiness", async () => {
    const todayShiftId = await createTodayReadyShift();
    ex.setUser(fx.workerAUid);
    const result = await ex.exec(`select * from public.list_worker_today_shifts()`);
    const rows = result.rows as Array<{
      shift_id: string;
      participant_first_name: string;
      location_hint: string;
      has_emergency_route: boolean;
      has_incident_route: boolean;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shift_id: todayShiftId,
      participant_first_name: "Maya",
      location_hint: "Fairfield",
      has_emergency_route: true,
      has_incident_route: true,
    });
  });

  it("surfaces missing route configuration without exposing the route table directly", async () => {
    await createTodayReadyShift();
    await ex.execAsService(
      `update public.organisation_handoff_route_versions
          set status = 'withdrawn'
        where organisation_id = '${fx.orgId}'
          and route_type = 'incident'`,
    );

    ex.setUser(fx.workerAUid);
    const result = await ex.exec(`select * from public.list_worker_today_shifts()`);
    const rows = result.rows as Array<{
      has_emergency_route: boolean;
      has_incident_route: boolean;
    }>;

    expect(rows[0]).toMatchObject({
      has_emergency_route: true,
      has_incident_route: false,
    });
  });

  it("returns the current provider-recorded acknowledgement leaf to the assigned worker", async () => {
    ex.setUser(fx.workerAUid);
    const startedVersion = await ex.callRpc("cmd_start_shift", {
      command_id: "ack-start",
      shift_id: fx.shiftId,
      expected_version: 1,
      claimed_at: "2026-08-07T10:00:00Z",
      client_tz: "Australia/Sydney",
      payload: {},
    });
    expect(startedVersion).toMatchObject({ status: "accepted" });

    await ex.callRpc("cmd_end_shift", {
      command_id: "ack-end",
      shift_id: fx.shiftId,
      expected_version: 2,
      claimed_at: "2026-08-07T11:00:00Z",
      client_tz: "Australia/Sydney",
      payload: {},
    });
    await ex.callRpc("cmd_submit_summary", {
      command_id: "ack-summary",
      shift_id: fx.shiftId,
      expected_version: 3,
      claimed_at: "2026-08-07T11:05:00Z",
      activities: ["Individual time support"],
      summary_text: "Participant-ready summary.",
      audience: ["participant", "service_summary"],
      payload: {},
    });

    ex.setUser(fx.adminUid);
    await ex.callRpc("cmd_admin_record_acknowledgement", {
      command_id: "ack-current",
      organisation_id: fx.orgId,
      shift_id: fx.shiftId,
      event_class: "conclusive",
      event_type: "external_signed_evidence",
      reported_signer_profile_id: fx.participantUid,
      authority_type: "participant_self",
      method: "signed external form",
      occurred_at: "2026-08-07T11:10:00Z",
      reason: "Initial evidence",
      external_evidence_reference: "ACK-1",
      expected_current_event_id: null,
      payload: {},
    });

    ex.setUser(fx.workerAUid);
    const { rows } = await ex.exec(
      `select * from public.get_worker_shift_acknowledgement('${fx.shiftId}')`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status_kind: "conclusive",
      event_type: "external_signed_evidence",
      source_label: "Provider-recorded external evidence; not participant-authenticated",
      occurred_at: new Date("2026-08-07T11:10:00Z"),
      reason: "Initial evidence",
    });
  });

  it("lets admins supersede the current emergency route transactionally", async () => {
    ex.setUser(fx.adminUid);
    const result = await ex.callRpc("cmd_admin_create_handoff_route", {
      command_id: "handoff-route-admin",
      organisation_id: fx.orgId,
      route_type: "emergency",
      guidance_text: "Use the refreshed emergency channel.",
      owner_role_label: "Provider duty manager",
      primary_label: "Call refreshed emergency line",
      primary_contact_uri: "tel:+61255501111",
      fallback_phone: "02 5550 1110",
      effective_from: "2026-08-07T08:00:00Z",
      effective_until: null,
      payload: { source: "admin-workspace" },
    });
    expect(result).toMatchObject({ status: "accepted", route_type: "emergency" });

    ex.setUser(fx.workerAUid);
    const { rows } = await ex.exec(
      `select * from public.list_worker_shift_handoff_routes('${fx.shiftId}')`,
    );
    const routes = rows as Array<{ route_type: string; primary_contact_uri: string }>;

    expect(routes.find((route) => route.route_type === "emergency")).toMatchObject({
      primary_contact_uri: "tel:+61255501111",
    });
  });
});

describe("server-side urgent-route gates and urgent-review recovery", () => {
  it("does not grant clients direct access to the internal route-state helper", async () => {
    const { rows } = await ex.execAsService(
      `select
         has_function_privilege('authenticated', 'public.current_worker_route_state(uuid)', 'execute') as authenticated_execute,
         has_function_privilege('anon', 'public.current_worker_route_state(uuid)', 'execute') as anon_execute`,
    );
    expect(rows[0]).toEqual({
      authenticated_execute: false,
      anon_execute: false,
    });

    const { orgBId } = await seedOrgAInactiveMemberships(ex);
    ex.setUser(fx.workerAUid);
    await expect(
      ex.exec(`select * from public.current_worker_route_state('${orgBId}')`),
    ).rejects.toThrow(/permission denied|execute/i);
  });

  it("fails closed inside worker delivery RPCs when a current route is withdrawn or expired", async () => {
    await ex.execAsService(
      `update public.organisation_handoff_route_versions
          set status = 'withdrawn'
        where organisation_id = '${fx.orgId}'
          and route_type = 'incident'`,
    );

    ex.setUser(fx.workerAUid);
    await expect(
      ex.callRpc("cmd_on_my_way", {
        command_id: "route-gate-on-my-way",
        shift_id: fx.shiftId,
        claimed_at: "2026-08-07T09:55:00Z",
        client_tz: "Australia/Sydney",
        payload: {},
      }),
    ).resolves.toMatchObject({
      status: "conflict_preserved",
      reason: "urgent_routes_not_current",
      has_emergency_route: true,
      has_incident_route: false,
    });

    await expect(
      ex.callRpc("cmd_start_shift", {
        command_id: "route-gate-start",
        shift_id: fx.shiftId,
        expected_version: 1,
        claimed_at: "2026-08-07T10:00:00Z",
        client_tz: "Australia/Sydney",
        payload: {},
      }),
    ).resolves.toMatchObject({
      status: "conflict_preserved",
      reason: "urgent_routes_not_current",
      has_emergency_route: true,
      has_incident_route: false,
    });

    await ex.execAsService(
      `update public.organisation_handoff_route_versions
          set status = 'active'
        where organisation_id = '${fx.orgId}'
          and route_type = 'incident'`,
    );

    await expect(
      ex.callRpc("cmd_start_shift", {
        command_id: "route-gate-start-success",
        shift_id: fx.shiftId,
        expected_version: 1,
        claimed_at: "2026-08-07T10:01:00Z",
        client_tz: "Australia/Sydney",
        payload: {},
      }),
    ).resolves.toMatchObject({ status: "accepted", new_state: "started", version: 2 });

    await ex.execAsService(
      `update public.organisation_handoff_route_versions
          set effective_until = '2026-08-07T10:30:00Z'
        where organisation_id = '${fx.orgId}'
          and route_type = 'incident'`,
    );

    await expect(
      ex.callRpc("cmd_end_shift", {
        command_id: "route-gate-end",
        shift_id: fx.shiftId,
        expected_version: 2,
        claimed_at: "2026-08-07T11:00:00Z",
        client_tz: "Australia/Sydney",
        payload: {},
      }),
    ).resolves.toMatchObject({
      status: "conflict_preserved",
      reason: "urgent_routes_not_current",
      has_emergency_route: true,
      has_incident_route: false,
    });
  });

  it("preserves end and summary recovery after post-start urgent provider review", async () => {
    ex.setUser(fx.workerAUid);
    await expect(
      ex.callRpc("cmd_start_shift", {
        command_id: "urgent-review-start",
        shift_id: fx.shiftId,
        expected_version: 1,
        claimed_at: "2026-08-07T10:00:00Z",
        client_tz: "Australia/Sydney",
        payload: {},
      }),
    ).resolves.toMatchObject({ status: "accepted", new_state: "started", version: 2 });

    await ex.execAsService(
      `update public.risk_assessed_role_versions
          set effective_until = '2026-08-07T10:30:00Z'
        where organisation_id = '${fx.orgId}'`,
    );

    const afterRevocation = await ex.execAsService(
      `select state, version
         from public.shifts
        where id = '${fx.shiftId}'`,
    );
    expect(afterRevocation.rows[0]).toMatchObject({
      state: "urgent_provider_review",
      version: 3,
    });

    ex.setUser(fx.workerAUid);
    await expect(
      ex.callRpc("cmd_end_shift", {
        command_id: "urgent-review-end",
        shift_id: fx.shiftId,
        expected_version: 3,
        claimed_at: "2026-08-07T11:00:00Z",
        client_tz: "Australia/Sydney",
        payload: {},
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      new_state: "urgent_provider_review",
      version: 4,
    });

    await expect(
      ex.callRpc("cmd_submit_summary", {
        command_id: "urgent-review-summary",
        shift_id: fx.shiftId,
        expected_version: 4,
        claimed_at: "2026-08-07T11:05:00Z",
        activities: ["Individual time support"],
        summary_text: "Participant-ready summary after urgent provider review.",
        audience: ["participant", "service_summary"],
        payload: {},
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      new_state: "urgent_provider_review",
      version: 5,
    });

    const finalShift = await ex.execAsService(
      `select state, version from public.shifts where id = '${fx.shiftId}'`,
    );
    expect(finalShift.rows[0]).toMatchObject({
      state: "urgent_provider_review",
      version: 5,
    });

    const summary = await ex.execAsService(
      `select s.current_version_id, v.summary_text
         from public.service_summaries s
         join public.service_summary_versions v on v.id = s.current_version_id
        where s.shift_id = '${fx.shiftId}'`,
    );
    expect(summary.rows[0]).toMatchObject({
      summary_text: "Participant-ready summary after urgent provider review.",
    });
  });
});
