/**
 * Pure state-machine helpers for the admin roster and consent workspace.
 *
 * These helpers are intentionally framework-free so the same logic can be
 * exercised in unit tests and reasoned about without React. The client
 * component composes them with hooks and renders the UI; the helpers
 * guarantee the state transitions and contracts called out in the
 * Ticket 05 repeat-review UI fixup:
 *
 *   - Successful commands must refresh or reconcile the server-backed
 *     workspace without discarding warnings or result context. The
 *     reconciliation keeps the command's `resultKey` and warning list
 *     so the UI can keep the affected alert bound to the result.
 *   - A retry of the same logical command must reuse the same command
 *     ID across an uncertain post-commit transport failure. A new ID
 *     is only generated after a known terminal result (server-confirmed
 *     accepted or duplicate_returned) or when the caller signals a
 *     genuinely new submission.
 *   - Roster overlap and availability warnings require an explicit
 *     acknowledgement. The acknowledgement is keyed by the result the
 *     warning came from, not by the form, so refreshing the data does
 *     not lose the link and a follow-up refresh surfaces the recorded
 *     ack alongside the shift row.
 *   - Participant-create and critical-info review-due dates are tracked
 *     independently. Changing one must never rewrite the other.
 *   - Recipient identity labels are looked up from the scoped identity
 *     projection; raw UUIDs are never rendered in the disclosure
 *     summary.
 */

export type CommandStatus =
  | "idle"
  | "pending"
  | "succeeded"
  | "duplicate"
  | "errored";

export type CommandRecord = {
  commandId: string;
  status: CommandStatus;
  resultKey: string | null;
  warnings: string[];
};

export type CommandRecordInit = {
  commandId: string;
};

export function createCommand(init: CommandRecordInit): CommandRecord {
  return { commandId: init.commandId, status: "idle", resultKey: null, warnings: [] };
}

export function beginCommand(rec: CommandRecord): CommandRecord {
  return { ...rec, status: "pending" };
}

export type CompleteCommandInput = {
  status: "succeeded" | "duplicate";
  resultKey: string | null;
  warnings: string[];
};

export function completeCommand(rec: CommandRecord, input: CompleteCommandInput): CommandRecord {
  return { ...rec, status: input.status, resultKey: input.resultKey, warnings: input.warnings };
}

export function failCommand(rec: CommandRecord): CommandRecord {
  return { ...rec, status: "errored" };
}

export type NewIntentSignal = boolean;

export function nextCommandId(rec: CommandRecord, newIntent: NewIntentSignal, generate: () => string): string {
  if (newIntent) return generate();
  if (rec.status === "succeeded" || rec.status === "duplicate") return generate();
  return rec.commandId;
}

export function isTerminal(rec: CommandRecord): boolean {
  return rec.status === "succeeded" || rec.status === "duplicate";
}

export type PreservedResult = {
  resultKey: string | null;
  warnings: string[];
  status: CommandStatus;
};

export function preserveResult(rec: CommandRecord): PreservedResult {
  return { resultKey: rec.resultKey, warnings: rec.warnings, status: rec.status };
}

export type WarningAcknowledgement = {
  resultKey: string;
  warningKey: string;
  acknowledgedAt: string;
};

export function acknowledgementKey(resultKey: string, warningKey: string): string {
  return `${resultKey}::${warningKey}`;
}

export function acknowledge(
  acks: WarningAcknowledgement[],
  resultKey: string,
  warningKeys: string[],
  at: string,
): WarningAcknowledgement[] {
  const known = new Set(
    acks.filter((ack) => ack.resultKey === resultKey).map((ack) => ack.warningKey),
  );
  const additions = warningKeys
    .filter((key) => !known.has(key))
    .map((key) => ({ resultKey, warningKey: key, acknowledgedAt: at }));
  return [...acks, ...additions];
}

export function revokeAcknowledgement(
  acks: WarningAcknowledgement[],
  resultKey: string,
  warningKey: string,
): WarningAcknowledgement[] {
  return acks.filter((ack) => !(ack.resultKey === resultKey && ack.warningKey === warningKey));
}

export function isAcknowledged(
  acks: WarningAcknowledgement[],
  resultKey: string,
  warningKey: string,
): boolean {
  return acks.some((ack) => ack.resultKey === resultKey && ack.warningKey === warningKey);
}

export function allWarningsAcknowledged(
  acks: WarningAcknowledgement[],
  resultKey: string,
  warningKeys: string[],
): boolean {
  if (warningKeys.length === 0) return true;
  return warningKeys.every((key) => isAcknowledged(acks, resultKey, key));
}

export function acknowledgedKeysFor(
  acks: WarningAcknowledgement[],
  resultKey: string,
): string[] {
  return acks.filter((ack) => ack.resultKey === resultKey).map((ack) => ack.warningKey);
}

export type IdentityRow = {
  profile_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
};

export type IdentityLabel =
  | { hasLabel: true; label: string; role: string }
  | { hasLabel: false; label: string; role: null };

export const PRIVACY_SAFE_RECIPIENT_FALLBACK = "External recipient";

export function buildIdentityLabels(rows: IdentityRow[]): Map<string, IdentityLabel> {
  const map = new Map<string, IdentityLabel>();
  for (const row of rows) {
    const trimmed = (row.full_name ?? "").trim() || (row.email ?? "").trim();
    if (!trimmed) continue;
    map.set(row.profile_id, { hasLabel: true, label: trimmed, role: row.role });
  }
  return map;
}

export function labelFor(map: Map<string, IdentityLabel>, profileId: string): IdentityLabel {
  const found = map.get(profileId);
  if (found && found.hasLabel) return found;
  return { hasLabel: false, label: PRIVACY_SAFE_RECIPIENT_FALLBACK, role: null };
}

export type RecipientDescription = {
  label: string;
  role: string | null;
  isFallback: boolean;
};

export function describeRecipient(map: Map<string, IdentityLabel>, profileId: string): RecipientDescription {
  const label = labelFor(map, profileId);
  return {
    label: label.label,
    role: label.role,
    isFallback: !label.hasLabel,
  };
}

export type ReviewDueState = {
  createDue: string;
  updateDue: string;
};

export function initialReviewDueState(defaultDue: string): ReviewDueState {
  return { createDue: defaultDue, updateDue: defaultDue };
}

export function setCreateDue(state: ReviewDueState, value: string): ReviewDueState {
  return { ...state, createDue: value };
}

export function setUpdateDue(state: ReviewDueState, value: string): ReviewDueState {
  return { ...state, updateDue: value };
}

export type WarningHumanLabel = {
  warningKey: string;
  message: string;
};

export const WARNING_LABELS: Record<string, string> = {
  worker_overlap: "The worker has another overlapping assignment.",
  outside_published_availability: "The shift falls outside the worker’s published availability.",
};

export function describeWarning(warningKey: string): WarningHumanLabel {
  return {
    warningKey,
    message: WARNING_LABELS[warningKey] ?? "Review the roster warning before treating this shift as confirmed.",
  };
}

export type CommandLifecycle = {
  initialCommandId: string;
  retryCommandId: string;
  duplicateCommandId: string;
  succeeded: boolean;
  reusedAcrossError: boolean;
  reusedAcrossDuplicate: boolean;
};

export function simulateRetryLifecycle(opts: {
  generate: () => string;
  initial: { commandId: string };
  afterError?: (rec: CommandRecord) => void;
  afterSuccess?: (rec: CommandRecord) => void;
}): CommandLifecycle {
  const lifecycle: CommandLifecycle = {
    initialCommandId: opts.initial.commandId,
    retryCommandId: opts.initial.commandId,
    duplicateCommandId: opts.initial.commandId,
    succeeded: false,
    reusedAcrossError: false,
    reusedAcrossDuplicate: false,
  };
  let rec = createCommand({ commandId: opts.initial.commandId });
  rec = beginCommand(rec);
  rec = failCommand(rec);
  const retryId = nextCommandId(rec, false, opts.generate);
  lifecycle.retryCommandId = retryId;
  lifecycle.reusedAcrossError = retryId === opts.initial.commandId;
  opts.afterError?.(rec);

  rec = beginCommand({ ...rec, commandId: retryId });
  rec = completeCommand(rec, { status: "duplicate", resultKey: "shift-1", warnings: ["worker_overlap"] });
  // After a known terminal duplicate_returned the next submission is a
  // new intent — the server already confirmed the original receipt, so
  // a fresh command ID is minted.
  const afterDuplicateId = nextCommandId(rec, false, opts.generate);
  lifecycle.duplicateCommandId = afterDuplicateId;
  lifecycle.reusedAcrossDuplicate = afterDuplicateId === retryId;
  lifecycle.succeeded = true;
  opts.afterSuccess?.(rec);
  return lifecycle;
}
