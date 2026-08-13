import { describe, expect, it } from "vitest";

import {
  PRIVACY_SAFE_RECIPIENT_FALLBACK,
  acknowledge,
  allWarningsAcknowledged,
  beginCommand,
  buildIdentityLabels,
  clearFormError,
  completeCommand,
  createCommand,
  describeRecipient,
  describeWarning,
  failCommand,
  initialFormErrors,
  initialFormPending,
  initialReviewDueState,
  isAcknowledged,
  labelFor,
  nextCommandId,
  normalizeCommandResult,
  preserveResult,
  revokeAcknowledgement,
  setCreateDue,
  setFormError,
  setFormPending,
  setUpdateDue,
  shouldRotateAfterAck,
  simulateRetryLifecycle,
  type CommandRecord,
  type IdentityRow,
  type WarningAcknowledgement,
} from "@/app/app/admin/workspace-state";
import { selectCurrentHandoffRoutes } from "@/lib/handoff-routes";

const isoFuture = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86400000).toISOString();

describe("workspace state — command identity persistence", () => {
  it("returns the initial command ID for the first use and reuses it through pending and errored states", () => {
    let rec: CommandRecord = createCommand({ commandId: "cmd-1" });
    const firstId = nextCommandId(rec, false, () => "should-not-be-used");
    expect(firstId).toBe("cmd-1");

    rec = beginCommand(rec);
    const pendingId = nextCommandId(rec, false, () => "should-not-be-used");
    expect(pendingId).toBe("cmd-1");

    rec = failCommand(rec);
    const erroredId = nextCommandId(rec, false, () => "should-not-be-used");
    expect(erroredId).toBe("cmd-1");
  });

  it("mints a new command ID once a known terminal result is recorded", () => {
    let rec: CommandRecord = createCommand({ commandId: "cmd-1" });
    rec = beginCommand(rec);
    rec = completeCommand(rec, { status: "succeeded", resultKey: "shift-1", warnings: ["worker_overlap"] });
    const acceptedId = nextCommandId(rec, false, () => "cmd-2");
    expect(acceptedId).toBe("cmd-2");
  });

  it("mints a new command ID when the caller explicitly signals a new submission", () => {
    let rec: CommandRecord = createCommand({ commandId: "cmd-1" });
    rec = beginCommand(rec);
    rec = failCommand(rec);
    const explicitNew = nextCommandId(rec, true, () => "cmd-2");
    expect(explicitNew).toBe("cmd-2");
  });

  it("reuses the same command ID through an errored retry and mints a new one after duplicate_returned", () => {
    let rec: CommandRecord = createCommand({ commandId: "cmd-1" });
    rec = beginCommand(rec);
    rec = failCommand(rec);
    const retryId = nextCommandId(rec, false, () => "different");
    expect(retryId).toBe("cmd-1");
    rec = beginCommand({ ...rec, commandId: retryId });
    rec = completeCommand(rec, { status: "duplicate", resultKey: "shift-1", warnings: ["worker_overlap"] });
    expect(rec.commandId).toBe("cmd-1");
    expect(rec.status).toBe("duplicate");
    const afterDuplicate = nextCommandId(rec, false, () => "new-id");
    expect(afterDuplicate).toBe("new-id");
  });

  it("simulates the full retry lifecycle deterministically", () => {
    const lifecycle = simulateRetryLifecycle({
      generate: () => "new-id",
      initial: { commandId: "stable-id" },
    });
    expect(lifecycle.initialCommandId).toBe("stable-id");
    expect(lifecycle.reusedAcrossError).toBe(true);
    expect(lifecycle.retryCommandId).toBe("stable-id");
    expect(lifecycle.reusedAcrossDuplicate).toBe(false);
    expect(lifecycle.duplicateCommandId).toBe("new-id");
    expect(lifecycle.succeeded).toBe(true);
  });
});

describe("workspace state — warning acknowledgement binding", () => {
  it("keys acknowledgements by (resultKey, warningKey) so two results do not collide", () => {
    let acks: WarningAcknowledgement[] = [];
    acks = acknowledge(acks, "shift-A", ["worker_overlap"], "2026-08-07T10:00:00Z");
    acks = acknowledge(acks, "shift-B", ["outside_published_availability"], "2026-08-07T10:01:00Z");

    expect(isAcknowledged(acks, "shift-A", "worker_overlap")).toBe(true);
    expect(isAcknowledged(acks, "shift-B", "outside_published_availability")).toBe(true);
    expect(isAcknowledged(acks, "shift-A", "outside_published_availability")).toBe(false);
    expect(isAcknowledged(acks, "shift-B", "worker_overlap")).toBe(false);
  });

  it("reports all warnings acknowledged only when every key is acknowledged", () => {
    let acks: WarningAcknowledgement[] = [];
    acks = acknowledge(acks, "shift-A", ["worker_overlap"], "2026-08-07T10:00:00Z");
    expect(allWarningsAcknowledged(acks, "shift-A", ["worker_overlap", "outside_published_availability"])).toBe(false);
    acks = acknowledge(acks, "shift-A", ["outside_published_availability"], "2026-08-07T10:01:00Z");
    expect(allWarningsAcknowledged(acks, "shift-A", ["worker_overlap", "outside_published_availability"])).toBe(true);
  });

  it("treats an empty warning list as fully acknowledged", () => {
    const acks: WarningAcknowledgement[] = [];
    expect(allWarningsAcknowledged(acks, "shift-A", [])).toBe(true);
  });

  it("revokes a previously recorded acknowledgement", () => {
    let acks: WarningAcknowledgement[] = acknowledge([], "shift-A", ["worker_overlap"], "2026-08-07T10:00:00Z");
    expect(isAcknowledged(acks, "shift-A", "worker_overlap")).toBe(true);
    acks = revokeAcknowledgement(acks, "shift-A", "worker_overlap");
    expect(isAcknowledged(acks, "shift-A", "worker_overlap")).toBe(false);
  });

  it("preserves the result binding across state transitions", () => {
    let rec: CommandRecord = createCommand({ commandId: "cmd-shift" });
    rec = beginCommand(rec);
    rec = completeCommand(rec, { status: "succeeded", resultKey: "shift-1", warnings: ["worker_overlap"] });
    const preserved = preserveResult(rec);
    expect(preserved.resultKey).toBe("shift-1");
    expect(preserved.warnings).toEqual(["worker_overlap"]);
    expect(preserved.status).toBe("succeeded");

    const acks = acknowledge([], preserved.resultKey as string, preserved.warnings, "2026-08-07T10:00:00Z");
    expect(allWarningsAcknowledged(acks, preserved.resultKey as string, preserved.warnings)).toBe(true);
  });
});

describe("workspace state — recipient identity labels", () => {
  const identities: IdentityRow[] = [
    { profile_id: "p1", full_name: "Wendy Worker", email: "worker@example.test", role: "worker" },
    { profile_id: "p2", full_name: null, email: "external@example.test", role: "external" },
    { profile_id: "p3", full_name: "  ", email: " ", role: "external" },
  ];

  it("builds a label map keyed by profile id and never includes profiles with empty names", () => {
    const map = buildIdentityLabels(identities);
    expect(map.size).toBe(2);
    expect(map.get("p1")?.label).toBe("Wendy Worker");
    expect(map.get("p2")?.label).toBe("external@example.test");
    expect(map.has("p3")).toBe(false);
  });

  it("returns the privacy-safe fallback when a profile id is not in the map", () => {
    const map = buildIdentityLabels(identities);
    const description = describeRecipient(map, "unknown-uuid");
    expect(description.label).toBe(PRIVACY_SAFE_RECIPIENT_FALLBACK);
    expect(description.role).toBeNull();
    expect(description.isFallback).toBe(true);
  });

  it("returns a label and role for known recipients", () => {
    const map = buildIdentityLabels(identities);
    const description = describeRecipient(map, "p1");
    expect(description.label).toBe("Wendy Worker");
    expect(description.role).toBe("worker");
    expect(description.isFallback).toBe(false);
  });

  it("labelFor returns the same shape as describeRecipient for both branches", () => {
    const map = buildIdentityLabels(identities);
    expect(labelFor(map, "p1").label).toBe("Wendy Worker");
    expect(labelFor(map, "missing").label).toBe(PRIVACY_SAFE_RECIPIENT_FALLBACK);
  });
});

describe("workspace state — independent review-due state", () => {
  it("initialises create and update due from the same default and keeps them independent", () => {
    const state = initialReviewDueState("2026-08-08T00:00:00Z");
    expect(state.createDue).toBe("2026-08-08T00:00:00Z");
    expect(state.updateDue).toBe("2026-08-08T00:00:00Z");

    const afterCreate = setCreateDue(state, "2026-09-01T00:00:00Z");
    expect(afterCreate.createDue).toBe("2026-09-01T00:00:00Z");
    expect(afterCreate.updateDue).toBe("2026-08-08T00:00:00Z");

    const afterUpdate = setUpdateDue(afterCreate, "2026-10-01T00:00:00Z");
    expect(afterUpdate.createDue).toBe("2026-09-01T00:00:00Z");
    expect(afterUpdate.updateDue).toBe("2026-10-01T00:00:00Z");
  });

  it("treats the two slots as independent — changing one never mutates the other", () => {
    const state = initialReviewDueState(isoFuture(1));
    const changed = setCreateDue(state, isoFuture(60));
    expect(changed.updateDue).toBe(state.updateDue);
    const changedUpdate = setUpdateDue(state, isoFuture(90));
    expect(changedUpdate.createDue).toBe(state.createDue);
  });
});

describe("workspace state — warning human labels", () => {
  it("returns a friendly message for the known warning keys", () => {
    expect(describeWarning("worker_overlap").message).toMatch(/overlapping/);
    expect(describeWarning("outside_published_availability").message).toMatch(/availability/);
  });

  it("falls back to a generic review notice for unknown warning keys", () => {
    const description = describeWarning("unknown_warning");
    expect(description.warningKey).toBe("unknown_warning");
    expect(description.message.toLowerCase()).toContain("review");
  });
});

describe("workspace state — command ID rotates only after ack / new intent", () => {
  it("keeps the command ID while warnings remain unacknowledged", () => {
    let rec: CommandRecord = createCommand({ commandId: "shift-1" });
    rec = beginCommand(rec);
    rec = completeCommand(rec, {
      status: "succeeded",
      resultKey: "shift-1",
      warnings: ["worker_overlap", "outside_published_availability"],
    });
    const acks: WarningAcknowledgement[] = [];
    expect(shouldRotateAfterAck(rec, acks)).toBe(false);
    expect(
      shouldRotateAfterAck(
        rec,
        acknowledge(acks, "shift-1", ["worker_overlap"], "2026-08-07T10:00:00Z"),
      ),
    ).toBe(false);
  });

  it("rotates the command ID once every warning is acknowledged", () => {
    let rec: CommandRecord = createCommand({ commandId: "shift-1" });
    rec = beginCommand(rec);
    rec = completeCommand(rec, {
      status: "succeeded",
      resultKey: "shift-1",
      warnings: ["worker_overlap", "outside_published_availability"],
    });
    const acks = acknowledge(
      [],
      "shift-1",
      ["worker_overlap", "outside_published_availability"],
      "2026-08-07T10:00:00Z",
    );
    expect(shouldRotateAfterAck(rec, acks)).toBe(true);
  });

  it("returns false for terminal records that never had warnings", () => {
    let rec: CommandRecord = createCommand({ commandId: "shift-1" });
    rec = beginCommand(rec);
    rec = completeCommand(rec, { status: "succeeded", resultKey: "shift-1", warnings: [] });
    expect(shouldRotateAfterAck(rec, [])).toBe(false);
  });
});

describe("handoff route current-window selection", () => {
  it("treats only currently effective active route versions as Current", () => {
    const now = new Date("2026-08-12T12:00:00Z");
    const routes = selectCurrentHandoffRoutes(
      [
        {
          route_type: "emergency",
          status: "active",
          effective_from: "2026-08-12T08:00:00Z",
          effective_until: null,
          created_at: "2026-08-12T08:00:00Z",
        },
        {
          route_type: "emergency",
          status: "active",
          effective_from: "2026-08-13T08:00:00Z",
          effective_until: null,
          created_at: "2026-08-12T09:00:00Z",
        },
        {
          route_type: "incident",
          status: "active",
          effective_from: "2026-08-10T08:00:00Z",
          effective_until: "2026-08-12T11:59:59Z",
          created_at: "2026-08-10T08:00:00Z",
        },
      ],
      now,
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      route_type: "emergency",
      effective_from: "2026-08-12T08:00:00Z",
    });
  });
});

describe("workspace state — normalizeCommandResult", () => {
  it("extracts resultKey / warnings / token from an accepted response shape", () => {
    const accepted = {
      status: "accepted",
      receipt_id: "r-1",
      shift_id: "shift-1",
      warnings: ["worker_overlap"],
      token: "tok-1",
      invitation_id: "inv-1",
    };
    const result = normalizeCommandResult(accepted);
    expect(result).toEqual({
      status: "accepted",
      duplicate: false,
      receiptId: "r-1",
      resultKey: "shift-1",
      warnings: ["worker_overlap"],
      token: "tok-1",
      invitationId: "inv-1",
    });
  });

  it("extracts the same fields from a duplicate_returned outcome shape", () => {
    const duplicate = {
      status: "duplicate_returned",
      duplicate: true,
      receipt_id: "r-1",
      outcome: {
        shift_id: "shift-1",
        warnings: ["worker_overlap"],
        token: "tok-1",
        invitation_id: "inv-1",
      },
    };
    const result = normalizeCommandResult(duplicate);
    expect(result).toEqual({
      status: "duplicate",
      duplicate: true,
      receiptId: "r-1",
      resultKey: "shift-1",
      warnings: ["worker_overlap"],
      token: "tok-1",
      invitationId: "inv-1",
    });
  });

  it("returns an empty resultKey and an empty warning list when the response is empty", () => {
    const empty = normalizeCommandResult({});
    expect(empty).toEqual({
      status: "accepted",
      duplicate: false,
      receiptId: "",
      resultKey: null,
      warnings: [],
      token: null,
      invitationId: null,
    });
  });

  it("preserves the original invitation token on duplicate retry so the copy link stays recoverable for the issuing actor", () => {
    const duplicate = normalizeCommandResult({
      status: "duplicate_returned",
      receipt_id: "r-invite",
      outcome: { invitation_id: "inv-1", token: "tok-original", email: "x@y.test" },
    });
    expect(duplicate.token).toBe("tok-original");
    expect(duplicate.invitationId).toBe("inv-1");
  });
});

describe("workspace state — per-form pending / error helpers", () => {
  it("starts with empty maps so every form has no inherited pending or error", () => {
    expect(initialFormPending()).toEqual({});
    expect(initialFormErrors()).toEqual({});
  });

  it("sets and clears per-form pending without disturbing other forms", () => {
    const before = initialFormPending();
    const pendingShift = setFormPending(before, "create-shift", true);
    expect(pendingShift["create-shift"]).toBe(true);
    expect(pendingShift["set-availability"]).toBeUndefined();
    const released = setFormPending(pendingShift, "create-shift", false);
    expect(released["create-shift"]).toBe(false);
  });

  it("stores and clears per-form error messages independently", () => {
    const seeded = setFormError(initialFormErrors(), "create-shift", "Could not save");
    expect(seeded["create-shift"]).toBe("Could not save");
    const cleared = clearFormError(seeded, "create-shift");
    expect(cleared["create-shift"]).toBeUndefined();
    expect(cleared).not.toBe(seeded);
  });
});
