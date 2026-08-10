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
    const result = await ex.callRpc("cmd_admin_create_shift", {
      command_id: "admin-shift-1", organisation_id: fx.orgId, participant_id: fx.participantId,
      worker_membership: (await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] && ((await ex.execAsService(`select id from public.organisation_memberships where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}'`)).rows[0] as { id: string }).id,
      scheduled_start: "2026-08-07T10:30:00Z", scheduled_end: "2026-08-07T11:30:00Z", reason: "cover", payload: {},
    }) as { status: string; warnings: string[] };
    expect(result.status).toBe("accepted");
    expect(result.warnings).toContain("worker_overlap");
    expect(result.warnings).toContain("outside_published_availability");
  });
});
