"use client";

import { cloneElement, isValidElement, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

import {
  PRIVACY_SAFE_RECIPIENT_FALLBACK,
  acknowledge,
  allWarningsAcknowledged,
  beginCommand,
  buildIdentityLabels,
  clearFormError,
  completeCommand,
  createCommand,
  describeWarning,
  failCommand,
  initialFormErrors,
  initialFormPending,
  initialReviewDueState,
  isAcknowledged,
  labelFor,
  normalizeCommandResult,
  payloadFingerprint,
  setCreateDue,
  setFormError,
  setFormPending,
  setUpdateDue,
  shouldReuseCommandId,
  shouldRotateAfterAck,
  type CommandRecord,
  type IdentityRow,
  type NormalizedCommandResult,
  type PayloadFingerprint,
  type ReviewDueState,
  type WarningAcknowledgement,
} from "./workspace-state";

type Organisation = { id: string; name: string; role: string };
type Data = {
  participants: Array<Record<string, unknown>>;
  cards: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
  identities: Array<Record<string, unknown>>;
  shifts: Array<Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
  authorities: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  consents: Array<Record<string, unknown>>;
  availability: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  selfLinks?: Array<Record<string, unknown>>;
  serviceContexts?: Array<Record<string, unknown>>;
};

const isoTomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 16);

const FORM_KEYS = {
  createParticipant: "create-participant",
  updateCriticalInfo: "update-critical-info",
  createShift: "create-shift",
  setAvailability: "set-availability",
  reassignShift: "reassign-shift",
  invite: "invite",
  recordConsent: "record-consent",
  renewConsent: "renew-consent",
  createGrant: "create-grant",
  revokeGrant: "revoke-grant",
  linkSelf: "link-self",
  setAuthority: "set-authority",
} as const;

type FormKey = typeof FORM_KEYS[keyof typeof FORM_KEYS];

function freshFormKeys(): Record<FormKey, string> {
  const keys = Object.values(FORM_KEYS) as FormKey[];
  return Object.fromEntries(keys.map((k) => [k, crypto.randomUUID()])) as Record<FormKey, string>;
}

function freshRecords(): Record<FormKey, CommandRecord> {
  const init: Partial<Record<FormKey, CommandRecord>> = {};
  for (const key of Object.values(FORM_KEYS)) {
    init[key] = createCommand({ commandId: crypto.randomUUID() });
  }
  return init as Record<FormKey, CommandRecord>;
}

export function AdminWorkspace({ organisation, initialData }: { organisation: Organisation; initialData: Data }) {
  // Data flows through props so router.refresh() re-renders the
  // workspace with newly reconciled rows. Only client-specific state
  // lives in useState so refresh preserves warnings and acks.
  const data = initialData;
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [tab, setTab] = useState("overview");

  // Per-form pending / error state. Each form has its own lock so
  // unrelated forms remain usable while one is in flight. Every
  // submitting control visibly reflects its own state via the
  // disabled prop + aria-busy.
  const [formPending, setFormPendingState] = useState<Record<string, boolean>>(initialFormPending);
  const [formErrors, setFormErrorsState] = useState<Record<string, string | null>>(initialFormErrors);
  const formLocksRef = useRef<Record<string, boolean>>({});

  const [commandIds, setCommandIds] = useState<Record<FormKey, string>>(() => freshFormKeys());
  const [records, setRecords] = useState<Record<FormKey, CommandRecord>>(() => freshRecords());
  const [acks, setAcks] = useState<WarningAcknowledgement[]>([]);
  const acksRef = useRef<WarningAcknowledgement[]>(acks);
  acksRef.current = acks;
  const [lastFingerprint, setLastFingerprint] = useState<Record<FormKey, PayloadFingerprint | null>>(
    () => Object.fromEntries(Object.values(FORM_KEYS).map((k) => [k, null])) as Record<FormKey, PayloadFingerprint | null>,
  );
  const [lastArgs, setLastArgs] = useState<Record<FormKey, Record<string, unknown> | null>>(
    () => Object.fromEntries(Object.values(FORM_KEYS).map((k) => [k, null])) as Record<FormKey, Record<string, unknown> | null>,
  );
  const [inviteFallbackUrl, setInviteFallbackUrl] = useState<string | null>(null);

  const workers = data.identities.filter((m) => m.role === "worker");
  const identityLabels = useMemo(
    () => buildIdentityLabels(data.identities as unknown as IdentityRow[]),
    [data.identities],
  );

  function currentCommandId(formKey: FormKey): string {
    return commandIds[formKey];
  }

  function renewCommandId(formKey: FormKey): string {
    const nextId = crypto.randomUUID();
    setCommandIds((prev) => ({ ...prev, [formKey]: nextId }));
    setRecords((prev) => ({ ...prev, [formKey]: createCommand({ commandId: nextId }) }));
    return nextId;
  }

  function recordCommandResult(
    formKey: FormKey,
    args: Record<string, unknown>,
    result: NormalizedCommandResult,
  ): void {
    transitionRecord(formKey, (rec) =>
      completeCommand(rec, {
        status: result.duplicate ? "duplicate" : "succeeded",
        resultKey: result.resultKey,
        warnings: result.warnings,
      }),
    );
  }

  function transitionRecord(formKey: FormKey, updater: (rec: CommandRecord) => CommandRecord): void {
    setRecords((prev) => ({ ...prev, [formKey]: updater(prev[formKey]) }));
  }

  function isFormPending(formKey: FormKey): boolean {
    return Boolean(formPending[formKey]);
  }

  function formError(formKey: FormKey): string | null {
    return formErrors[formKey] ?? null;
  }

  // Apply a normalized command result to component state. Pulls
  // resultKey / warnings / token from the appropriate location for
  // both accepted and duplicate_returned responses so warnings
  // survive transport-uncertain retries unchanged.
  function applyResult(formKey: FormKey, args: Record<string, unknown>, result: NormalizedCommandResult): void {
    recordCommandResult(formKey, args, result);

    if (formKey === FORM_KEYS.invite && result.token) {
      const url = `${window.location.origin}/invite/${result.token}`;
      setInviteFallbackUrl(url);
      const fallback = `Invitation created. Copy this single-use link through the provider’s approved channel: ${url}`;
      // Always render the selectable URL first. Clipboard is an optional
      // enhancement: missing APIs, non-Promise implementations, and
      // permission-rejected writes must never make a committed invite
      // unrecoverable.
      setFormMessage(formKey, fallback);
      const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      const writeText = clipboard?.writeText;
      if (typeof writeText !== "function") return;
      try {
        const writeResult = writeText.call(clipboard, url);
        if (writeResult && typeof (writeResult as PromiseLike<void>).then === "function") {
          Promise.resolve(writeResult).then(
            () => setFormMessage(formKey, "Invitation created. The single-use link was copied; the selectable URL remains available below."),
            () => setFormMessage(formKey, fallback),
          );
        } else {
          setFormMessage(formKey, "Invitation created. The single-use link was copied; the selectable URL remains available below.");
        }
      } catch {
        setFormMessage(formKey, fallback);
      }
    }
  }

  function setFormMessage(formKey: FormKey, message: string): void {
    setFormErrorsState((prev) => setFormError(prev, formKey, message));
  }

  function clearFormMessage(formKey: FormKey): void {
    setFormErrorsState((prev) => clearFormError(prev, formKey));
  }

  async function call(formKey: FormKey, name: string, args: Record<string, unknown>, visibleIntent?: Record<string, unknown>): Promise<boolean> {
    if (formLocksRef.current[formKey]) return false;
    formLocksRef.current[formKey] = true;
    setFormPendingState((prev) => setFormPending(prev, formKey, true));
    clearFormMessage(formKey);
    transitionRecord(formKey, beginCommand);
    const fingerprint = payloadFingerprint(visibleIntent ?? args);
    const lastFingerprintForForm = lastFingerprint[formKey] ?? null;
    const currentRecord = records[formKey];
    // A retry of the same logical command (same payload fingerprint
    // while still transport-uncertain) reuses the existing command
    // ID; a changed payload forces a fresh command ID.
    const reuseCommand = shouldReuseCommandId(currentRecord, fingerprint, lastFingerprintForForm);
    const retryArgs = reuseCommand && lastArgs[formKey] ? lastArgs[formKey] : args;
    const commandId = reuseCommand
      ? currentCommandId(formKey)
      : renewCommandId(formKey);
    // Capture the exact logical arguments before the RPC starts so a
    // rejection/throw can retry with the same command ID and payload.
    setLastFingerprint((prev) => ({ ...prev, [formKey]: fingerprint }));
    if (!reuseCommand) setLastArgs((prev) => ({ ...prev, [formKey]: args }));
    if (formKey === FORM_KEYS.invite && !reuseCommand) setInviteFallbackUrl(null);
    try {
      const { data: result, error } = await supabase.rpc(name, { ...retryArgs, p_command_id: commandId });
      if (error) {
        setFormMessage(formKey, `Could not save: ${error.message.replace(/^.*?: /, "")}`);
        transitionRecord(formKey, failCommand);
        return false;
      }
      const payload = (result ?? {}) as Record<string, unknown>;
      const status = payload.status as "accepted" | "duplicate_returned" | undefined;
      const isDuplicate = status === "duplicate_returned";
      const normalized = normalizeCommandResult(payload);

      if (name === "cmd_admin_create_service_ready_shift" && normalized.warnings.length > 0 && normalized.resultKey) {
        setFormMessage(
          formKey,
          isDuplicate
            ? "This command was already applied; the original shift result with warnings is shown."
            : "Shift created, but review the roster warnings before treating it as confirmed.",
        );
        applyResult(formKey, retryArgs, normalized);
        void router.refresh();
        return true;
      }

      if (isDuplicate) {
        setFormMessage(formKey, "This command was already applied; the original result was returned.");
      } else {
        setFormMessage(formKey, "Saved and added to the audit timeline.");
      }
      applyResult(formKey, retryArgs, normalized);
      void router.refresh();
      return true;
    } catch (error) {
      setFormMessage(formKey, `Could not save: ${error instanceof Error ? error.message : "connection failed"}`);
      transitionRecord(formKey, failCommand);
      return false;
    } finally {
      formLocksRef.current[formKey] = false;
      setFormPendingState((prev) => setFormPending(prev, formKey, false));
    }
  }

  // After a warning is acknowledged, decide whether the command ID
  // can rotate. Ack is preserved across refresh because it lives in
  // client state.
  function acknowledgeWarning(resultKey: string, warningKey: string, acknowledged: boolean): void {
    const at = new Date().toISOString();
    const nextAcks = acknowledged
      ? acknowledge(acksRef.current, resultKey, [warningKey], at)
      : acksRef.current.filter((ack) => !(ack.resultKey === resultKey && ack.warningKey === warningKey));
    acksRef.current = nextAcks;
    setAcks(nextAcks);
    // Once every warning for this result is acknowledged, the next
    // submission is a genuine new intent and a fresh command ID is
    // minted. Until then the ID stays stable so transport-uncertain
    // retries return the same result.
    for (const key of Object.values(FORM_KEYS)) {
      const rec = records[key];
      if (rec.resultKey === resultKey && shouldRotateAfterAck(rec, nextAcks)) {
        renewCommandId(key);
      }
    }
  }

  const pendingWarnings = Object.values(records)
    .filter((rec) => rec.resultKey && rec.warnings.length > 0)
    .map((rec) => ({ resultKey: rec.resultKey as string, warnings: rec.warnings }));

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-sm font-medium text-muted-foreground">{organisation.name} · {organisation.role}</p><h1 className="text-3xl font-semibold tracking-tight">Admin workspace</h1></div>
          <span className="rounded-full border border-success/40 bg-success/10 px-3 py-1 text-sm text-success-foreground">Synthetic workspace</span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">Prepare pilot records with separate participant identity, authority evidence, roster history, and external disclosure grants. Sensitive changes are recorded by a protected transaction.</p>
      </header>

      <nav aria-label="Admin workspace sections" className="flex flex-wrap gap-2 border-b pb-3">
        {["overview", "participants", "roster", "access", "audit"].map((item) => <Button key={item} variant={tab === item ? "default" : "outline"} onClick={() => setTab(item)} aria-current={tab === item ? "page" : undefined}>{item[0].toUpperCase() + item.slice(1)}</Button>)}
      </nav>
      {pendingWarnings.map(({ resultKey, warnings: warningKeys }) => {
        const allAck = allWarningsAcknowledged(acks, resultKey, warningKeys);
        return (
          <div key={resultKey} role="alert" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            <strong>Roster warnings require review.</strong>
            <p className="text-xs text-muted-foreground">Tied to shift result <code>{resultKey.slice(0, 8)}…</code>; refreshes keep this alert bound to the same shift.</p>
            <ul className="mt-1 list-disc pl-5">
              {warningKeys.map((warningKey) => {
                const description = describeWarning(warningKey);
                const ack = isAcknowledged(acks, resultKey, warningKey);
                const inputId = `ack-${resultKey}-${warningKey}`;
                return (
                  <li key={warningKey}>
                    <label className="flex items-start gap-2" htmlFor={inputId}>
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={ack}
                        onChange={(e) => acknowledgeWarning(resultKey, warningKey, e.target.checked)}
                        className="mt-1"
                      />
                      <span>{description.message}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs">
              {allAck
                ? "All warnings acknowledged for this shift result."
                : `${warningKeys.filter((k) => isAcknowledged(acks, resultKey, k)).length}/${warningKeys.length} acknowledged.`}
            </p>
          </div>
        );
      })}

      {tab === "overview" ? <Overview data={data} setTab={setTab} /> : null}
      {tab === "participants" ? (
        <Participants
          data={data}
          organisationId={organisation.id}
          call={call}
          isPending={isFormPending}
          formError={formError}
        />
      ) : null}
      {tab === "roster" ? (
        <Roster
          data={data}
          workers={workers}
          organisationId={organisation.id}
          call={call}
          isPending={isFormPending}
          formError={formError}
        />
      ) : null}
      {tab === "access" ? (
        <Access
          data={data}
          organisationId={organisation.id}
          actorRole={organisation.role}
          call={call}
          isPending={isFormPending}
          formError={formError}
          privacyFallback={PRIVACY_SAFE_RECIPIENT_FALLBACK}
          labelLookup={(profileId) => labelFor(identityLabels, profileId)}
          inviteFallbackUrl={inviteFallbackUrl}
        />
      ) : null}
      {tab === "audit" ? <Audit data={data} /> : null}
    </div>
  );
}

function Overview({ data, setTab }: { data: Data; setTab: (tab: string) => void }) {
  const cards = [{ label: "Participants", value: data.participants.length, tab: "participants" }, { label: "Workers", value: data.identities.filter((m) => m.role === "worker").length, tab: "roster" }, { label: "Upcoming shifts", value: data.shifts.filter((s) => s.state === "scheduled").length, tab: "roster" }, { label: "Active grants", value: data.grants.filter((g) => g.status === "active").length, tab: "access" }];
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{cards.map((card) => <button key={card.label} className="text-left" onClick={() => setTab(card.tab)}><Card className="h-full transition hover:ring-2 hover:ring-ring"><CardHeader><CardDescription>{card.label}</CardDescription><CardTitle className="text-3xl">{card.value}</CardTitle></CardHeader><CardContent><span className="text-sm text-muted-foreground">Open workspace →</span></CardContent></Card></button>)}</div>;
}

type FormCall = (formKey: FormKey, name: string, args: Record<string, unknown>, visibleIntent?: Record<string, unknown>) => Promise<boolean>;

function Participants({
  data,
  organisationId,
  call,
  isPending,
  formError,
}: {
  data: Data;
  organisationId: string;
  call: FormCall;
  isPending: (formKey: FormKey) => boolean;
  formError: (formKey: FormKey) => string | null;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastInitial, setLastInitial] = useState("");
  const [critical, setCritical] = useState("");
  const [dueState, setDueState] = useState<ReviewDueState>(() => initialReviewDueState(isoTomorrow()));
  const [criticalParticipant, setCriticalParticipant] = useState("");
  const [updatedCritical, setUpdatedCritical] = useState("");
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Create participant</CardTitle>
          <CardDescription>Identity and minimum critical handoff are created together, but remain separate records.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              // The form values are intentionally preserved across
              // successful submissions; the user signals "new
              // submission" by changing the fields or clicking reset.
              // A transport-uncertain retry therefore sends the same
              // arguments with the same command ID.
              void call(FORM_KEYS.createParticipant, "cmd_admin_create_participant", {
                p_organisation_id: organisationId,
                p_first_name: firstName,
                p_last_initial: lastInitial,
                p_critical_content: critical,
                p_review_due_at: new Date(dueState.createDue).toISOString(),
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="First name">
              <Input required value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Synthetic participant" />
            </Field>
            <Field label="Last initial">
              <Input maxLength={3} value={lastInitial} onChange={(e) => setLastInitial(e.target.value)} placeholder="R" />
            </Field>
            <Field label="Critical support and safety handoff">
              <textarea
                required
                value={critical}
                onChange={(e) => setCritical(e.target.value)}
                className="min-h-28 w-full rounded-md border bg-transparent p-3 text-base"
                placeholder="Minimum worker-visible information; no clinical approval claim."
              />
            </Field>
            <Field label="Review due (create)">
              <Input
                required
                type="datetime-local"
                value={dueState.createDue}
                onChange={(e) => setDueState((prev) => setCreateDue(prev, e.target.value))}
              />
            </Field>
            <Button type="submit" disabled={isPending(FORM_KEYS.createParticipant)} aria-busy={isPending(FORM_KEYS.createParticipant)}>Create secure record</Button>
            {formError(FORM_KEYS.createParticipant) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.createParticipant)}</p> : null}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Participant register</CardTitle>
          <CardDescription>Names are intentionally minimised. Open a participant to review separate authority and sharing evidence.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.participants.length
              ? data.participants.map((p) => {
                  const card = data.cards.find((c) => c.participant_id === p.id);
                  return (
                    <div key={String(p.id)} className="rounded-lg border p-4">
                      <div className="flex flex-wrap justify-between gap-2">
                        <strong>{String(p.first_name)} {p.last_initial ? `${String(p.last_initial)}.` : ""}</strong>
                        <span className="text-xs text-muted-foreground">Created {new Date(String(p.created_at)).toLocaleDateString("en-AU")}</span>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">Critical handoff: {card ? `review due ${new Date(String(card.review_due_at)).toLocaleDateString("en-AU")}` : "missing — contact provider"}</p>
                    </div>
                  );
                })
              : <EmptyState text="No participants yet. Use the form to prepare a synthetic participant." />}
          </div>
          <form
            className="mt-5 space-y-4 border-t pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              void call(FORM_KEYS.updateCriticalInfo, "cmd_admin_update_critical_info", {
                p_organisation_id: organisationId,
                p_participant_id: criticalParticipant,
                p_critical_content: updatedCritical,
                p_review_due_at: new Date(dueState.updateDue).toISOString(),
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="Participant to review">
              <select required value={criticalParticipant} onChange={(e) => setCriticalParticipant(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose participant</option>
                {data.participants.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.first_name)}</option>)}
              </select>
            </Field>
            <Field label="Updated critical handoff">
              <textarea
                required
                value={updatedCritical}
                onChange={(e) => setUpdatedCritical(e.target.value)}
                className="min-h-24 w-full rounded-md border bg-transparent p-3 text-base"
              />
            </Field>
            <Field label="Review due (update)">
              <Input
                required
                type="datetime-local"
                value={dueState.updateDue}
                onChange={(e) => setDueState((prev) => setUpdateDue(prev, e.target.value))}
              />
            </Field>
            <Button type="submit" disabled={isPending(FORM_KEYS.updateCriticalInfo)} aria-busy={isPending(FORM_KEYS.updateCriticalInfo)}>Update critical handoff</Button>
            {formError(FORM_KEYS.updateCriticalInfo) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.updateCriticalInfo)}</p> : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Roster({
  data,
  workers,
  organisationId,
  call,
  isPending,
  formError,
}: {
  data: Data;
  workers: Array<Record<string, unknown>>;
  organisationId: string;
  call: FormCall;
  isPending: (formKey: FormKey) => boolean;
  formError: (formKey: FormKey) => string | null;
}) {
  const [participant, setParticipant] = useState("");
  const [serviceContext, setServiceContext] = useState("");
  const [worker, setWorker] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [availabilityFrom, setAvailabilityFrom] = useState("");
  const [availabilityUntil, setAvailabilityUntil] = useState("");
  const [availabilityNote, setAvailabilityNote] = useState("");
  const [reassignShift, setReassignShift] = useState("");
  const [reassignWorker, setReassignWorker] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Create roster shift</CardTitle>
          <CardDescription>Overlap and published-availability warnings return with the transaction; a warning does not silently hide the assignment.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              // Form values preserved across submissions — the next
              // click sends the same logical command with the same
              // command ID, returning duplicate_returned on the
              // server side until the user signals new intent.
              void call(FORM_KEYS.createShift, "cmd_admin_create_service_ready_shift", {
                p_organisation_id: organisationId,
                p_participant_id: participant,
                p_worker_membership: worker,
                p_service_context_id: serviceContext,
                p_scheduled_start: new Date(start).toISOString(),
                p_scheduled_end: new Date(end).toISOString(),
                p_reason: reason,
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="Participant">
              <select required value={participant} onChange={(e) => setParticipant(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose participant</option>
                {data.participants.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.first_name)} {String(p.last_initial ?? "")}</option>)}
              </select>
            </Field>
            <Field label="Worker">
              <select required value={worker} onChange={(e) => setWorker(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose worker membership</option>
                {workers.map((w) => <option key={String(w.membership_id)} value={String(w.membership_id)}>{String(w.full_name ?? w.email ?? w.profile_id)} · worker</option>)}
              </select>
            </Field>
            <Field label="Reviewed service context">
              <select required value={serviceContext} onChange={(e) => setServiceContext(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose active reviewed context</option>
                {(data.serviceContexts ?? []).filter((c) => !participant || String(c.participant_id) === participant).map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.goal_reference ?? c.id)} · {String(c.lifecycle_state)}</option>)}
              </select>
            </Field>
            <Field label="Scheduled start">
              <Input required type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Scheduled end">
              <Input required type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
            <Field label="Assignment reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Routine roster / cover" />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={isPending(FORM_KEYS.createShift)} aria-busy={isPending(FORM_KEYS.createShift)}>Create shift</Button>
            </div>
            {formError(FORM_KEYS.createShift) ? <p role="status" className="text-xs text-info-foreground md:col-span-2">{formError(FORM_KEYS.createShift)}</p> : null}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Published worker availability</CardTitle>
          <CardDescription>Availability is advisory. A shift outside this window is warned, not silently discarded.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void call(FORM_KEYS.setAvailability, "cmd_admin_set_availability", {
                p_organisation_id: organisationId,
                p_worker_membership: worker,
                p_available_from: new Date(availabilityFrom).toISOString(),
                p_available_until: new Date(availabilityUntil).toISOString(),
                p_note: availabilityNote,
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="Worker">
              <select required value={worker} onChange={(e) => setWorker(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose worker membership</option>
                {workers.map((w) => <option key={String(w.membership_id)} value={String(w.membership_id)}>{String(w.full_name ?? w.email ?? w.profile_id)}</option>)}
              </select>
            </Field>
            <Field label="Note">
              <Input value={availabilityNote} onChange={(e) => setAvailabilityNote(e.target.value)} placeholder="School hours / regular window" />
            </Field>
            <Field label="Available from">
              <Input required type="datetime-local" value={availabilityFrom} onChange={(e) => setAvailabilityFrom(e.target.value)} />
            </Field>
            <Field label="Available until">
              <Input required type="datetime-local" value={availabilityUntil} onChange={(e) => setAvailabilityUntil(e.target.value)} />
            </Field>
            <div>
              <Button type="submit" disabled={isPending(FORM_KEYS.setAvailability)} aria-busy={isPending(FORM_KEYS.setAvailability)} variant="outline">Publish availability</Button>
            </div>
            {formError(FORM_KEYS.setAvailability) ? <p role="status" className="text-xs text-info-foreground md:col-span-2">{formError(FORM_KEYS.setAvailability)}</p> : null}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Reassign a shift</CardTitle>
          <CardDescription>The current assignment is withdrawn, the new assignment is appended, and the reason remains visible in the audit history.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const selected = data.shifts.find((s) => s.id === reassignShift);
              if (!selected) return;
              void call(FORM_KEYS.reassignShift, "cmd_reassign_shift", {
                p_shift_id: reassignShift,
                p_expected_version: selected.version,
                p_claimed_at: new Date().toISOString(),
                p_client_tz: "Australia/Sydney",
                p_new_worker_membership: reassignWorker,
                p_reason: reassignReason,
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="Shift">
              <select required value={reassignShift} onChange={(e) => setReassignShift(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose shift</option>
                {data.shifts.map((s) => <option key={String(s.id)} value={String(s.id)}>{new Date(String(s.scheduled_start)).toLocaleString("en-AU")} · v{String(s.version)}</option>)}
              </select>
            </Field>
            <Field label="New worker">
              <select required value={reassignWorker} onChange={(e) => setReassignWorker(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose worker membership</option>
                {workers.map((w) => <option key={String(w.membership_id)} value={String(w.membership_id)}>{String(w.full_name ?? w.email ?? w.profile_id)}</option>)}
              </select>
            </Field>
            <Field label="Reason">
              <Input required value={reassignReason} onChange={(e) => setReassignReason(e.target.value)} placeholder="Cover confirmed with worker" />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={isPending(FORM_KEYS.reassignShift)} aria-busy={isPending(FORM_KEYS.reassignShift)} variant="outline">Reassign shift</Button>
            </div>
            {formError(FORM_KEYS.reassignShift) ? <p role="status" className="text-xs text-info-foreground md:col-span-2">{formError(FORM_KEYS.reassignShift)}</p> : null}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Roster and audit-friendly assignment history</CardTitle>
          <CardDescription>Reassignment uses the existing versioned command and never erases prior assignments.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.shifts.length
              ? data.shifts.map((shift) => {
                  const assignment = data.assignments.find((a) => a.shift_id === shift.id && !a.withdrawn_at);
                  const p = data.participants.find((item) => item.id === shift.participant_id);
                  return (
                    <div key={String(shift.id)} className="rounded-lg border p-4">
                      <div className="flex flex-wrap justify-between gap-2">
                        <strong>{String(p?.first_name ?? "Participant")}</strong>
                        <span className="rounded-full bg-muted px-2 py-1 text-xs">{String(shift.state)}</span>
                      </div>
                      <p className="mt-1 text-sm">{new Date(String(shift.scheduled_start)).toLocaleString("en-AU")} – {new Date(String(shift.scheduled_end)).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</p>
                      <p className="text-xs text-muted-foreground">Current worker membership: {String(assignment?.membership_id ?? "unassigned")} · version {String(shift.version)}</p>
                    </div>
                  );
                })
              : <EmptyState text="No shifts yet. Create a synthetic roster assignment above." />}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Access({
  data,
  organisationId,
  actorRole,
  call,
  isPending,
  formError,
  privacyFallback,
  labelLookup,
  inviteFallbackUrl,
}: {
  data: Data;
  organisationId: string;
  actorRole: string;
  call: FormCall;
  isPending: (formKey: FormKey) => boolean;
  formError: (formKey: FormKey) => string | null;
  privacyFallback: string;
  labelLookup: (profileId: string) => { hasLabel: true; label: string; role: string } | { hasLabel: false; label: string; role: null };
  inviteFallbackUrl: string | null;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("worker");
  const [inviteExpiry, setInviteExpiry] = useState(isoTomorrow());
  const [evidence, setEvidence] = useState("");
  const [authorityType, setAuthorityType] = useState("plan_nominee");
  const [authorityScope, setAuthorityScope] = useState("upcoming_visits,service_summary");
  const [selfEvidence, setSelfEvidence] = useState("");
  const [consentParticipant, setConsentParticipant] = useState("");
  const [consentRecipient, setConsentRecipient] = useState("");
  const [consentAuthoriser, setConsentAuthoriser] = useState("");
  const [consentBasis, setConsentBasis] = useState<"participant" | "authorised_representative">("participant");
  const [consentAuthorityId, setConsentAuthorityId] = useState("");
  const [consentPurpose, setConsentPurpose] = useState("");
  const [consentScope, setConsentScope] = useState("service_summary");
  const [consentEvidence, setConsentEvidence] = useState("");
  const [renewParticipant, setRenewParticipant] = useState("");
  const [renewRecipient, setRenewRecipient] = useState("");
  const [renewExpectedConsent, setRenewExpectedConsent] = useState("");
  const [renewPurpose, setRenewPurpose] = useState("");
  const [renewScope, setRenewScope] = useState("");
  const [renewEvidence, setRenewEvidence] = useState("");
  const [grantConsent, setGrantConsent] = useState("");
  const [selfParticipant, setSelfParticipant] = useState("");
  const [selfProfile, setSelfProfile] = useState("");
  const [authorityParticipant, setAuthorityParticipant] = useState("");
  const [authorityProfile, setAuthorityProfile] = useState("");
  const inviteRoles = actorRole === "admin" ? ["admin", "scheduler", "worker", "participant", "nominee", "external"] : ["worker", "participant", "nominee"];

  // For a given (participant, recipient) pair, the unique unsuperseded
  // current consent leaf — if any — is the row to renew against.
  const currentConsentForPair = (participantId: string, recipientId: string): Record<string, unknown> | null => {
    return (
      data.consents.find(
        (c) =>
          c.participant_id === participantId &&
          c.recipient_profile_id === recipientId &&
          c.superseded_by == null,
      ) ?? null
    );
  };
  const recordPair = consentParticipant && consentRecipient
    ? currentConsentForPair(consentParticipant, consentRecipient)
    : null;
  const participantAuthorities = consentParticipant
    ? data.authorities.filter((authority) => authority.participant_id === consentParticipant && authority.status === "active")
    : [];
  const participantSelfProfiles = new Set(
    (data.selfLinks ?? [])
      .filter((link) => link.participant_id === consentParticipant && link.status === "active")
      .map((link) => String(link.profile_id)),
  );
  const renewPair = renewParticipant && renewRecipient
    ? currentConsentForPair(renewParticipant, renewRecipient)
    : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Invite a role</CardTitle>
          <CardDescription>Invitations are single-use, expiring, and do not reveal whether the email belongs to another organisation.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void call(FORM_KEYS.invite, "cmd_admin_invite", {
                p_organisation_id: organisationId,
                p_email: email,
                p_role: role,
                p_expires_at: new Date(inviteExpiry).toISOString(),
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="Email"><Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                {inviteRoles.map((inviteRole) => <option key={inviteRole}>{inviteRole}</option>)}
              </select>
            </Field>
            <Field label="Expires"><Input required type="datetime-local" value={inviteExpiry} onChange={(e) => setInviteExpiry(e.target.value)} /></Field>
            <Button type="submit" disabled={isPending(FORM_KEYS.invite)} aria-busy={isPending(FORM_KEYS.invite)}>Issue invitation</Button>
            {formError(FORM_KEYS.invite) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.invite)}</p> : null}
            {inviteFallbackUrl ? (
              <div className="space-y-2" role="status">
                <Label htmlFor="invite-fallback-url">Selectable invitation URL</Label>
                <Input id="invite-fallback-url" readOnly value={inviteFallbackUrl} aria-label="Selectable invitation URL" />
              </div>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Record consent evidence</CardTitle>
          <CardDescription>Provider-recorded evidence is separate from self-access and authority. It names the recipient, purpose, categories, basis, and time window. Participant and authorised-representative evidence share one current lineage; renew an existing pair instead of creating a parallel record.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const from = new Date();
              const until = new Date(Date.now() + 30 * 86400000);
              void call(FORM_KEYS.recordConsent, "cmd_admin_record_consent", {
                p_organisation_id: organisationId,
                p_participant_id: consentParticipant,
                p_recipient_profile_id: consentRecipient,
                p_authorising_profile_id: consentAuthoriser,
                p_purpose: consentPurpose,
                p_scope_categories: consentScope.split(",").map((s) => s.trim()).filter(Boolean),
                p_consent_basis: consentBasis,
                p_representative_authority_id: consentBasis === "authorised_representative" ? consentAuthorityId : null,
                p_evidence_reference: consentEvidence,
                p_effective_from: from.toISOString(),
                p_effective_until: until.toISOString(),
                p_payload: { source: "admin-workspace", provider_recorded: true },
              }, {
                participant: consentParticipant,
                recipient: consentRecipient,
                authoriser: consentAuthoriser,
                basis: consentBasis,
                authority: consentAuthorityId,
                purpose: consentPurpose,
                scope: consentScope,
                evidence: consentEvidence,
              });
            }}
          >
            <Field label="Participant">
              <select required value={consentParticipant} onChange={(e) => setConsentParticipant(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose participant</option>
                {data.participants.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.first_name)}</option>)}
              </select>
            </Field>
            <Field label="External recipient">
              <select required value={consentRecipient} onChange={(e) => setConsentRecipient(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose external recipient</option>
                {data.identities.filter((i) => i.role === "external").map((i) => {
                  const label = labelLookup(String(i.profile_id));
                  return <option key={String(i.profile_id)} value={String(i.profile_id)}>{label.label} · external</option>;
                })}
              </select>
            </Field>
            <Field label="Consent basis">
              <select required value={consentBasis} onChange={(e) => {
                const next = e.target.value as "participant" | "authorised_representative";
                setConsentBasis(next);
                setConsentAuthoriser("");
                setConsentAuthorityId("");
              }} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="participant">Participant self-evidence</option>
                <option value="authorised_representative">Authorised-representative evidence</option>
              </select>
            </Field>
            {consentBasis === "participant" ? (
              <Field label="Participant authoriser">
                <select required value={consentAuthoriser} onChange={(e) => setConsentAuthoriser(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                  <option value="">Choose participant account</option>
                  {data.identities.filter((i) => i.role === "participant" && participantSelfProfiles.has(String(i.profile_id))).map((i) => {
                    const label = labelLookup(String(i.profile_id));
                    return <option key={String(i.profile_id)} value={String(i.profile_id)}>{label.label}</option>;
                  })}
                </select>
              </Field>
            ) : (
              <>
                <Field label="Representative authority">
                  <select required value={consentAuthorityId} onChange={(e) => {
                    const authorityId = e.target.value;
                    setConsentAuthorityId(authorityId);
                    const selected = participantAuthorities.find((authority) => authority.id === authorityId);
                    setConsentAuthoriser(selected ? String(selected.representative_profile_id) : "");
                  }} className="h-9 w-full rounded-md border bg-background px-2">
                    <option value="">Choose current authority for this participant</option>
                    {participantAuthorities.map((authority) => {
                      const label = labelLookup(String(authority.representative_profile_id));
                      const scope = Array.isArray(authority.scope_categories) ? (authority.scope_categories as string[]).join(", ") : "scoped authority";
                      return <option key={String(authority.id)} value={String(authority.id)}>{label.label} · {scope}</option>;
                    })}
                  </select>
                </Field>
                <Field label="Authorised representative">
                  <Input readOnly required value={consentAuthoriser ? labelLookup(consentAuthoriser).label : ""} placeholder="Choose an authority above" />
                </Field>
              </>
            )}
            <Field label="Purpose"><Input required value={consentPurpose} onChange={(e) => setConsentPurpose(e.target.value)} placeholder="e.g. coordination with school" /></Field>
            <Field label="Scope categories"><Input required value={consentScope} onChange={(e) => setConsentScope(e.target.value)} placeholder="service_summary,upcoming_visits" /></Field>
            <Field label="Evidence reference"><Input required value={consentEvidence} onChange={(e) => setConsentEvidence(e.target.value)} placeholder="provider-recorded consent identifier" /></Field>
            <Button type="submit" disabled={Boolean(recordPair) || isPending(FORM_KEYS.recordConsent)} aria-busy={isPending(FORM_KEYS.recordConsent)}>
              {recordPair ? "Switch to renew below" : "Record consent evidence"}
            </Button>
            {recordPair ? <p className="text-xs text-warning-foreground">A current consent already exists for this pair. Renew it below to keep the lineage singular.</p> : null}
            {formError(FORM_KEYS.recordConsent) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.recordConsent)}</p> : null}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Renew consent evidence</CardTitle>
          <CardDescription>Renewal walks the successor chain and only succeeds when <code>expected_current_consent_id</code> matches the live leaf. Stale renewals are preserved as conflict evidence.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!renewPair) return;
              const from = new Date();
              const until = new Date(Date.now() + 30 * 86400000);
              void call(FORM_KEYS.renewConsent, "cmd_admin_renew_consent", {
                p_organisation_id: organisationId,
                p_consent_id: renewPair.id,
                p_expected_current_consent_id: renewExpectedConsent || String(renewPair.id),
                p_purpose: renewPurpose,
                p_scope_categories: renewScope.split(",").map((s) => s.trim()).filter(Boolean),
                p_evidence_reference: renewEvidence,
                p_effective_from: from.toISOString(),
                p_effective_until: until.toISOString(),
                p_payload: { source: "admin-workspace", provider_recorded: true },
              }, {
                participant: renewParticipant,
                recipient: renewRecipient,
                expected: renewExpectedConsent || String(renewPair.id),
                purpose: renewPurpose,
                scope: renewScope,
                evidence: renewEvidence,
              });
            }}
          >
            <Field label="Participant">
              <select required value={renewParticipant} onChange={(e) => setRenewParticipant(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose participant</option>
                {data.participants.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.first_name)}</option>)}
              </select>
            </Field>
            <Field label="External recipient">
              <select required value={renewRecipient} onChange={(e) => setRenewRecipient(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose external recipient</option>
                {data.identities.filter((i) => i.role === "external").map((i) => {
                  const label = labelLookup(String(i.profile_id));
                  return <option key={String(i.profile_id)} value={String(i.profile_id)}>{label.label} · external</option>;
                })}
              </select>
            </Field>
            <Field label="Current consent (expected leaf)">
              <select required value={renewExpectedConsent} onChange={(e) => setRenewExpectedConsent(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Auto-fill from selected pair</option>
                {data.consents
                  .filter((c) => c.superseded_by == null)
                  .map((c) => {
                    const label = labelLookup(String(c.recipient_profile_id));
                    return (
                      <option key={String(c.id)} value={String(c.id)}>
                        v{String(c.version ?? "1")} · {label.label} · {String(c.purpose)}
                      </option>
                    );
                  })}
              </select>
            </Field>
            <Field label="Updated purpose"><Input required value={renewPurpose} onChange={(e) => setRenewPurpose(e.target.value)} /></Field>
            <Field label="Updated scope categories"><Input required value={renewScope} onChange={(e) => setRenewScope(e.target.value)} placeholder="service_summary,upcoming_visits" /></Field>
            <Field label="Updated evidence reference"><Input required value={renewEvidence} onChange={(e) => setRenewEvidence(e.target.value)} /></Field>
            <Button type="submit" disabled={!renewPair || isPending(FORM_KEYS.renewConsent)} aria-busy={isPending(FORM_KEYS.renewConsent)}>Renew consent evidence</Button>
            {renewPair ? <p className="text-xs text-muted-foreground">Live leaf: v{String(renewPair.version ?? "1")} · {String(renewPair.purpose)}</p> : <p className="text-xs text-warning-foreground">No current consent exists for this pair yet. Record one above first.</p>}
            {formError(FORM_KEYS.renewConsent) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.renewConsent)}</p> : null}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>External view-only grant</CardTitle>
          <CardDescription>Select the unique unsuperseded current consent. Grants are blocked from superseded evidence.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const selected = data.consents.find((c) => c.id === grantConsent);
              if (!selected) return;
              const from = new Date();
              const until = new Date(Math.min(Date.now() + 30 * 86400000, new Date(String(selected.effective_until)).getTime()));
              void call(FORM_KEYS.createGrant, "cmd_admin_create_grant", {
                p_organisation_id: organisationId,
                p_consent_id: grantConsent,
                p_effective_from: from.toISOString(),
                p_effective_until: new Date(until).toISOString(),
                p_payload: { source: "admin-workspace" },
              }, { consent: grantConsent });
            }}
          >
            <Field label="Consent evidence">
              <select required value={grantConsent} onChange={(e) => setGrantConsent(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose current consent evidence</option>
                {data.consents.filter((c) => c.status === "active" && c.superseded_by == null).map((c) => {
                  const label = labelLookup(String(c.recipient_profile_id));
                  return (
                    <option key={String(c.id)} value={String(c.id)}>
                      v{String(c.version ?? "1")} · {String(c.purpose)} · {label.label}
                    </option>
                  );
                })}
              </select>
            </Field>
            <Button type="submit" disabled={isPending(FORM_KEYS.createGrant)} aria-busy={isPending(FORM_KEYS.createGrant)}>Create view-only grant</Button>
            {formError(FORM_KEYS.createGrant) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.createGrant)}</p> : null}
          </form>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Current disclosures and authority</CardTitle>
          <CardDescription>Recipient labels come from the scoped identity projection; raw recipient identifiers are never rendered here.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {data.grants.map((grant) => {
              const recipient = labelLookup(String(grant.recipient_profile_id));
              return (
                <div key={String(grant.id)} className="rounded-lg border p-4">
                  <div className="flex justify-between gap-2"><strong>{String(grant.purpose)}</strong><span className="text-xs">{String(grant.status)}</span></div>
                  <p className="text-sm text-muted-foreground">Scope: {Array.isArray(grant.scope_categories) ? (grant.scope_categories as string[]).join(", ") : String(grant.scope_categories)}</p>
                  <p className="text-xs text-muted-foreground">Recipient: <span data-testid="recipient-label">{recipient.label}</span>{recipient.role ? ` · ${recipient.role}` : recipient.hasLabel === false ? ` · ${privacyFallback}` : ""} · expires {new Date(String(grant.effective_until)).toLocaleDateString("en-AU")}</p>
                  {grant.status === "active" ? (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="destructive"
                      disabled={isPending(FORM_KEYS.revokeGrant)}
                      aria-busy={isPending(FORM_KEYS.revokeGrant)}
                      onClick={() =>
                        void call(FORM_KEYS.revokeGrant, "cmd_admin_revoke_grant", {
                          p_organisation_id: organisationId,
                          p_grant_id: grant.id,
                          p_reason: "Withdrawn by authorised provider user",
                          p_payload: { source: "admin-workspace" },
                        })
                      }
                    >
                      Revoke grant
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {!data.grants.length ? <EmptyState text="No external disclosure grants recorded." /> : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Participant self-link</CardTitle>
          <CardDescription>Self-access is separate from external disclosure and representative authority.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void call(FORM_KEYS.linkSelf, "cmd_admin_link_participant", {
                p_organisation_id: organisationId,
                p_participant_id: selfParticipant,
                p_profile_id: selfProfile,
                p_evidence_reference: selfEvidence,
                p_payload: { source: "admin-workspace" },
              });
            }}
          >
            <Field label="Participant">
              <select required value={selfParticipant} onChange={(e) => setSelfParticipant(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose participant</option>
                {data.participants.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.first_name)}</option>)}
              </select>
            </Field>
            <Field label="Participant account">
              <select required value={selfProfile} onChange={(e) => setSelfProfile(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose invited participant</option>
                {data.identities.filter((i) => i.role === "participant").map((i) => {
                  const label = labelLookup(String(i.profile_id));
                  return <option key={String(i.profile_id)} value={String(i.profile_id)}>{label.label}</option>;
                })}
              </select>
            </Field>
            <Field label="Evidence reference"><Input required value={selfEvidence} onChange={(e) => setSelfEvidence(e.target.value)} /></Field>
            <Button type="submit" variant="outline" disabled={isPending(FORM_KEYS.linkSelf)} aria-busy={isPending(FORM_KEYS.linkSelf)}>Link self-access</Button>
            {formError(FORM_KEYS.linkSelf) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.linkSelf)}</p> : null}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Representative authority</CardTitle>
          <CardDescription>Record relationship, scope, evidence, issuer, and effective period independently.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const from = new Date();
              const until = new Date(Date.now() + 90 * 86400000);
              void call(FORM_KEYS.setAuthority, "cmd_admin_set_authority", {
                p_organisation_id: organisationId,
                p_participant_id: authorityParticipant,
                p_representative_profile_id: authorityProfile,
                p_authority_type: authorityType,
                p_scope_categories: authorityScope.split(",").map((s) => s.trim()).filter(Boolean),
                p_evidence_reference: evidence,
                p_issuer: "Provider admin",
                p_effective_from: from.toISOString(),
                p_effective_until: until.toISOString(),
                p_payload: { source: "admin-workspace" },
              }, {
                participant: authorityParticipant,
                representative: authorityProfile,
                type: authorityType,
                scope: authorityScope,
                evidence,
              });
            }}
          >
            <Field label="Participant">
              <select required value={authorityParticipant} onChange={(e) => setAuthorityParticipant(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose participant</option>
                {data.participants.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.first_name)}</option>)}
              </select>
            </Field>
            <Field label="Representative account">
              <select required value={authorityProfile} onChange={(e) => setAuthorityProfile(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
                <option value="">Choose invited representative</option>
                {data.identities.filter((i) => i.role === "nominee").map((i) => {
                  const label = labelLookup(String(i.profile_id));
                  return <option key={String(i.profile_id)} value={String(i.profile_id)}>{label.label}</option>;
                })}
              </select>
            </Field>
            <Field label="Authority type"><Input required value={authorityType} onChange={(e) => setAuthorityType(e.target.value)} /></Field>
            <Field label="Scope categories"><Input required value={authorityScope} onChange={(e) => setAuthorityScope(e.target.value)} /></Field>
            <Field label="Evidence reference"><Input required value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field>
            <Button type="submit" variant="outline" disabled={isPending(FORM_KEYS.setAuthority)} aria-busy={isPending(FORM_KEYS.setAuthority)}>Record representative authority</Button>
            {formError(FORM_KEYS.setAuthority) ? <p role="status" className="text-xs text-info-foreground">{formError(FORM_KEYS.setAuthority)}</p> : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Audit({ data }: { data: Data }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit timeline</CardTitle>
        <CardDescription>Read-only visibility for invitations, roster changes, authority, grants, and participant records.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {data.audit.length
            ? data.audit.map((entry) => (
                <li key={String(entry.id)} className="border-l-2 border-primary/30 pl-4">
                  <div className="flex flex-wrap justify-between gap-2"><strong>{String(entry.action)}</strong><time className="text-xs text-muted-foreground">{new Date(String(entry.created_at)).toLocaleString("en-AU")}</time></div>
                  <p className="text-xs text-muted-foreground">{String(entry.subject_type)} · {String(entry.subject_id)} · actor {String(entry.actor)}</p>
                </li>
              ))
            : <EmptyState text="Audit events will appear here after the first secure command." />}
        </ol>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const fieldId = useId();
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string; "aria-describedby"?: string }>, { id: fieldId })
    : children;
  return <div className="space-y-2"><Label htmlFor={fieldId}>{label}</Label>{control}</div>;
}
function EmptyState({ text }: { text: string }) { return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{text}</div>; }
