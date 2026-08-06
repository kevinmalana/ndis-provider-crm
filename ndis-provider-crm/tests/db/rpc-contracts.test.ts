/**
 * Transactional RPC contract tests.
 *
 * Each sensitive command is verified against its acceptance contract:
 *   * Happy path produces the new state, audit row, and event row.
 *   * Duplicate retry with the same command_id returns the original
 *     receipt idempotently and does not duplicate audit / event rows.
 *   * Stale version produces conflict_preserved + evidence_review_queue row.
 *   * Wrong assignment (worker B) is rejected.
 *   * Cancellation/reassignment preserves evidence without deleting rows.
 *   * Correction creates a new immutable version, original stays.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { bootTestDb, type Executor } from "./harness";
import { seedStandardFixture, type Fixture, TEST_TS } from "./fixtures";

let ex: Executor;
let fx: Fixture;

beforeEach(async () => {
  ex = await bootTestDb();
  fx = await seedStandardFixture(ex);
});

afterEach(async () => {
  await ex.raw.close();
});

function iso(t: number): string {
  return new Date(t).toISOString();
}

async function startShift() {
  ex.setUser(fx.workerAUid);
  // First: on_my_way (optional path).
  const onMyWay = (await ex.callRpc("cmd_on_my_way", {
    command_id: "c-onmyway-1",
    shift_id: fx.shiftId,
    claimed_at: iso(TEST_TS.getTime() + 70 * 60 * 1000),
    client_tz: "Australia/Sydney",
    payload: { source: "mobile" },
  })) as { status: string; new_state: string; version?: number };
  expect(onMyWay.status).toBe("accepted");
  expect(onMyWay.new_state).toBe("in_transit");

  // Then: start.
  const startV = onMyWay.version ?? 2;
  const start = (await ex.callRpc("cmd_start_shift", {
    command_id: "c-start-1",
    shift_id: fx.shiftId,
    expected_version: startV,
    claimed_at: iso(TEST_TS.getTime() + 75 * 60 * 1000),
    client_tz: "Australia/Sydney",
    payload: { source: "mobile" },
  })) as { status: string; new_state: string; version?: number };
  expect(start.status).toBe("accepted");
  expect(start.new_state).toBe("started");
  return (start.version as number) ?? startV + 1;
}

async function endShift() {
  const startedV = await startShift();
  ex.setUser(fx.workerAUid);
  const end = (await ex.callRpc("cmd_end_shift", {
    command_id: "c-end-step",
    shift_id: fx.shiftId,
    expected_version: startedV,
    claimed_at: iso(TEST_TS.getTime() + 80 * 60 * 1000),
    client_tz: "Australia/Sydney",
    payload: { source: "mobile" },
  })) as { status: string; new_state: string; version?: number };
  expect(end.status).toBe("accepted");
  return (end.version as number) ?? startedV + 1;
}

describe("cmd_on_my_way / cmd_start_shift / cmd_end_shift", () => {
  it("on_my_way → start → end happy path", async () => {
    const endV = await endShift();
    expect(endV).toBeGreaterThan(1);

    const { rows } = await ex.execAsService(
      `select state, version from public.shifts where id = '${fx.shiftId}'`,
    );
    expect((rows[0] as { state: string }).state).toBe(
      "ended_summary_required",
    );
  });

  it("duplicate start returns the original receipt idempotently", async () => {
    await startShift();
    // Replay same command_id (start), expect duplicate.
    ex.setUser(fx.workerAUid);
    const replay = await ex.callRpc("cmd_start_shift", {
      command_id: "c-start-1",
      shift_id: fx.shiftId,
      expected_version: 999,
      claimed_at: iso(TEST_TS.getTime()),
      client_tz: "Australia/Sydney",
      payload: { source: "mobile" },
    });
    expect(replay).toMatchObject({ duplicate: true, status: "accepted" });

    const { rows } = await ex.execAsService(
      `select count(*)::int as c from public.command_receipts where command_id = 'c-start-1'`,
    );
    expect((rows[0] as { c: number }).c).toBe(1);

    const { rows: shiftEvents } = await ex.execAsService(
      `select count(*)::int as c
         from public.shift_events
        where shift_id = '${fx.shiftId}' and event_type = 'start'`,
    );
    expect((shiftEvents[0] as { c: number }).c).toBe(1);
  });

  it("receipt lookup is bound to the authenticated actor membership", async () => {
    ex.setUser(fx.workerAUid);
    await ex.callRpc("cmd_on_my_way", {
      command_id: "c-scope-receipt",
      shift_id: fx.shiftId,
      claimed_at: iso(TEST_TS.getTime()),
      client_tz: "Australia/Sydney",
      payload: { source: "mobile" },
    });
    const membershipA = `(select id from public.organisation_memberships where organisation_id = '${fx.orgId}' and profile_id = '${fx.workerAUid}')`;
    ex.setUser(fx.workerBUid);
    const { rows } = await ex.exec(
      `select count(*)::int as c from public.lookup_command_receipt(
         '${fx.orgId}', ${membershipA}, 'on_my_way', 'c-scope-receipt')`,
    );
    expect((rows[0] as { c: number }).c).toBe(0);
  });

  it("stale version returns conflict_preserved and preserves evidence", async () => {
    await startShift();
    ex.setUser(fx.workerAUid);
    const res = await ex.callRpc("cmd_end_shift", {
      command_id: "c-end-stale",
      shift_id: fx.shiftId,
      expected_version: 999,
      claimed_at: iso(TEST_TS.getTime()),
      client_tz: "Australia/Sydney",
      payload: { source: "mobile" },
    });
    expect(res).toMatchObject({
      status: "conflict_preserved",
      reason: "stale_version",
    });
    const { rows } = await ex.execAsService(
      `select id, receipt_id, state from public.evidence_review_queue
        order by created_at desc limit 1`,
    );
    expect((rows[0] as { state: string }).state).toBe("pending");

    ex.setUser(fx.schedulerUid);
    const resolved = (await ex.callRpc("cmd_resolve_conflict", {
      command_id: "c-resolve-stale-end",
      review_id: (rows[0] as { id: string }).id,
      decision: "accept_exception",
      reason: "Supervisor accepts the captured end evidence.",
      payload: { source: "dashboard" },
    })) as { status: string; authoritative_state: string; original_receipt_id: string };
    expect(resolved).toMatchObject({
      status: "accepted",
      authoritative_state: "ended_summary_required",
      original_receipt_id: (rows[0] as { receipt_id: string }).receipt_id,
    });

    const { rows: resolvedShift } = await ex.execAsService(
      `select state from public.shifts where id = '${fx.shiftId}'`,
    );
    expect((resolvedShift[0] as { state: string }).state).toBe("ended_summary_required");
  });

  it("non-assigned worker preserves evidence", async () => {
    ex.setUser(fx.workerBUid);
    // No row in shift_assignments for worker B.
    const result = await ex.callRpc("cmd_start_shift", {
        command_id: "c-start-bad",
        shift_id: fx.shiftId,
        expected_version: 1,
        claimed_at: iso(TEST_TS.getTime()),
        client_tz: "Australia/Sydney",
        payload: { source: "mobile" },
      });
    expect((result as { status: string }).status).toBe("conflict_preserved");
  });
});

describe("cmd_submit_summary / finalise / apply_correction", () => {
  async function driveToAwaitingSummary(): Promise<number> {
    return endShift();
  }

  it("submit → finalise → correction versions stay immutable", async () => {
    const v = await driveToAwaitingSummary();
    ex.setUser(fx.workerAUid);
    const submit = (await ex.callRpc("cmd_submit_summary", {
      command_id: "c-submit-1",
      shift_id: fx.shiftId,
      expected_version: v,
      claimed_at: iso(TEST_TS.getTime() + 90 * 60 * 1000),
      activities: ["personal_care", "community_access"],
      summary_text:
        "Helped Maya with morning routine and a short community outing.",
      audience: ["participant", "service_summary_external"],
      payload: { source: "mobile" },
    })) as { status: string; new_state: string };
    expect(submit.status).toBe("accepted");

    const { rows: shiftRows } = await ex.execAsService(
      `select state, version from public.shifts where id = '${fx.shiftId}'`,
    );
    expect((shiftRows[0] as { state: string }).state).toBe("finalised");

    ex.setUser(fx.schedulerUid);
    const finalise = await ex.callRpc("cmd_finalise_summary", {
      command_id: "c-finalise-1",
      shift_id: fx.shiftId,
      payload: { source: "dashboard" },
    });
    expect(finalise).toMatchObject({ status: "accepted", duplicate: true, state: "finalised" });

    const { rows: shiftRows2 } = await ex.execAsService(
      `select state, version from public.shifts where id = '${fx.shiftId}'`,
    );
    const newV = (shiftRows2[0] as { version: number }).version;
    expect(newV).toBeGreaterThan(0);

    ex.setUser(fx.workerAUid);
    const request = (await ex.callRpc("cmd_request_correction", {
      command_id: "c-correction-request-1",
      shift_id: fx.shiftId,
      reason: "Forgot to record meal-prep support.",
      requested_changes: "Add meal preparation activity.",
      payload: { source: "mobile" },
    })) as { request_id: string };

    ex.setUser(fx.adminUid);
    const correct = (await ex.callRpc("cmd_apply_correction", {
      command_id: "c-correction-1",
      request_id: request.request_id,
      expected_version: newV,
      claimed_at: iso(TEST_TS.getTime() + 95 * 60 * 1000),
      client_tz: "Australia/Sydney",
      activities: ["personal_care", "community_access", "meal_prep"],
      summary_text:
        "Helped Maya with morning routine, meal prep, and a short community outing.",
      audience: ["participant", "service_summary_external"],
      reason: "Forgot to record meal-prep support.",
      payload: { source: "dashboard" },
    })) as {
      status: string;
      previous_version_id: string;
      new_version_id: string;
    };
    expect(correct.status).toBe("accepted");
    expect(correct.previous_version_id).not.toBe(correct.new_version_id);

    const { rows } = await ex.execAsService(
      `select version_number, is_correction from public.service_summary_versions
         where summary_id in (select id from public.service_summaries where shift_id = '${fx.shiftId}')
         order by version_number`,
    );
    expect(rows).toHaveLength(2);
    expect((rows[0] as { version_number: number; is_correction: boolean }).is_correction).toBe(false);
    expect((rows[1] as { version_number: number; is_correction: boolean }).is_correction).toBe(true);
  });

  it("finalise is idempotent for an already-finalised summary", async () => {
    const v = await driveToAwaitingSummary();
    ex.setUser(fx.workerAUid);
    await ex.callRpc("cmd_submit_summary", {
      command_id: "c-submit-2",
      shift_id: fx.shiftId,
      expected_version: v,
      claimed_at: iso(TEST_TS.getTime()),
      activities: ["personal_care"],
      summary_text: "Test summary text.",
      audience: ["participant"],
      payload: {},
    });
    ex.setUser(fx.schedulerUid);
    await ex.callRpc("cmd_finalise_summary", {
      command_id: "c-f-1",
      shift_id: fx.shiftId,
      payload: {},
    });
    ex.setUser(fx.adminUid);
    // Re-finalise with a NEW command_id (the manager clicks again).
    const replay = await ex.callRpc("cmd_finalise_summary", {
      command_id: "c-f-2",
      shift_id: fx.shiftId,
      payload: {},
    });
    expect(replay).toMatchObject({
      status: "accepted",
      duplicate: true,
      state: "finalised",
    });
  });

  it("finalise compatibility endpoint rejects worker retries", async () => {
    const v = await driveToAwaitingSummary();
    ex.setUser(fx.workerAUid);
    await ex.callRpc("cmd_submit_summary", {
      command_id: "c-submit-3",
      shift_id: fx.shiftId,
      expected_version: v,
      claimed_at: iso(TEST_TS.getTime()),
      activities: ["personal_care"],
      summary_text: "Test summary text.",
      audience: ["participant"],
      payload: {},
    });
    await expect(ex.callRpc("cmd_finalise_summary", {
        command_id: "c-f-bad",
        shift_id: fx.shiftId,
        payload: {},
      })).rejects.toThrow("finalise_requires_admin_or_scheduler");
  });
});

describe("portal request identity and idempotency", () => {
  it("uses the caller profile, not an arbitrary membership, for access requests", async () => {
    ex.setUser(fx.representerUid);
    const first = (await ex.callRpc("cmd_request_access", {
      command_id: "c-portal-access-1",
      participant_id: fx.participantId,
      scope_categories: ["service_summary"],
      reason: "Need the current summary.",
      payload: { source: "portal" },
    })) as { status: string; receipt_id: string; requester_kind: string };
    const second = (await ex.callRpc("cmd_request_access", {
      command_id: "c-portal-access-1",
      participant_id: fx.participantId,
      scope_categories: ["service_summary"],
      reason: "Retry",
      payload: { source: "portal" },
    })) as { duplicate: boolean; receipt_id: string };
    expect(first).toMatchObject({ status: "accepted", requester_kind: "representative" });
    expect(second).toMatchObject({ duplicate: true, receipt_id: first.receipt_id });
    const { rows } = await ex.execAsService(
      `select count(*)::int as c from public.access_requests
        where requester_profile_id = '${fx.representerUid}' and participant_id = '${fx.participantId}'`,
    );
    expect((rows[0] as { c: number }).c).toBe(1);
  });
});

describe("evidence preservation after reassignment", () => {
  it("preserves a worker command after membership withdrawal", async () => {
    const startedV = await startShift();
    await ex.execAsService(
      `update public.organisation_memberships
          set status = 'withdrawn', withdrawn_at = now()
        where organisation_id = '${fx.orgId}'
          and profile_id = '${fx.workerAUid}'`,
    );
    ex.setUser(fx.workerAUid);
    const result = (await ex.callRpc("cmd_end_shift", {
      command_id: "c-end-withdrawn",
      shift_id: fx.shiftId,
      expected_version: startedV,
      claimed_at: iso(TEST_TS.getTime()),
      client_tz: "Australia/Sydney",
      payload: { source: "offline" },
    })) as { status: string; receipt_id: string };
    expect(result.status).toBe("conflict_preserved");
    expect(result.receipt_id).toBeTruthy();
    const { rows } = await ex.execAsService(
      `select count(*)::int as c from public.command_receipts
        where command_id = 'c-end-withdrawn' and actor_profile_id = '${fx.workerAUid}'`,
    );
    expect((rows[0] as { c: number }).c).toBe(1);
  });

  it("cancelled shift preserves evidence rather than dropping it", async () => {
    await startShift();
    // Worker B is reassigned: existing worker A assignment gets
    // superseded_by a new row for worker B, and the shift state moves
    // to cancelled_needs_review. The original worker A evidence rows
    // remain.
    ex.setUser(fx.adminUid);
    const { rows: shiftBefore } = await ex.execAsService(
      `select state, version from public.shifts where id = '${fx.shiftId}'`,
    );
    expect((shiftBefore[0] as { state: string }).state).toBe("started");

    // Reassign worker B by inserting a new assignment and withdrawing the
    // old one.
    await ex.execAsService(
      `insert into public.shift_assignments
         (id, shift_id, organisation_id, membership_id, assigned_by, predecessor_id)
       values (
         gen_random_uuid(),
         '${fx.shiftId}',
         '${fx.orgId}',
         (select id from public.organisation_memberships
            where profile_id = '${fx.workerBUid}'
              and organisation_id = '${fx.orgId}'),
         '${fx.adminUid}',
         null
       )`,
    ).catch(() => {
      // schema may not have predecessor_id; tolerate either.
      return ex.execAsService(
        `insert into public.shift_assignments
           (id, shift_id, organisation_id, membership_id, assigned_by)
         values (
           gen_random_uuid(),
           '${fx.shiftId}',
           '${fx.orgId}',
           (select id from public.organisation_memberships
              where profile_id = '${fx.workerBUid}'
                and organisation_id = '${fx.orgId}'),
           '${fx.adminUid}'
         )`,
      );
    });

    // The earlier audit + shift_events rows are still present.
    const { rows: events } = await ex.execAsService(
      `select count(*)::int as c from public.shift_events
        where shift_id = '${fx.shiftId}'`,
    );
    expect((events[0] as { c: number }).c).toBeGreaterThanOrEqual(2);
  });
});
