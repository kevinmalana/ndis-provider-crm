"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessibleStatus, FormError, StickyActionLayout } from "@/components/ui/accessibility";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  cmdEndShift,
  cmdOnMyWay,
  cmdStartShift,
  cmdSubmitSummary,
  cmdWorkerRecordHandoff,
} from "@/lib/supabase/commands";

type ReadyWorkerShiftDetail = {
  shift: Record<string, unknown>;
  participant: Record<string, unknown>;
  criticalCard: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  currentSummaryVersion: Record<string, unknown> | null;
  handoffRoutes: Array<Record<string, unknown>>;
  handoffReceipts: Array<Record<string, unknown>>;
  commandReceipts: Array<Record<string, unknown>>;
  acknowledgement: Record<string, unknown> | null;
};

function displayState(state: string): string {
  switch (state) {
    case "scheduled":
      return "Scheduled";
    case "in_transit":
      return "On my way";
    case "started":
      return "Started";
    case "ended_summary_required":
      return "Summary required";
    case "finalised":
      return "Finalised";
    case "needs_review":
      return "Needs review";
    case "urgent_provider_review":
      return "Urgent provider review";
    case "cancelled":
      return "Cancelled";
    case "cancelled_needs_review":
      return "Cancelled — evidence under review";
    case "corrected":
      return "Corrected";
    default:
      return state.replaceAll("_", " ");
  }
}

function mapConflictReason(reason: string | undefined): string {
  switch (reason) {
    case "not_assigned":
      return "Your evidence was preserved, but this shift is no longer assigned to you. Contact the provider.";
    case "stale_version":
      return "The shift changed before the server accepted your action. Your evidence was preserved for provider review.";
    case "invalid_state":
      return "That action is no longer valid for the current shift state.";
    case "urgent_routes_not_current":
      return "Current provider emergency and incident routes are required before delivery can continue. Contact the provider.";
    default:
      return "The server preserved your evidence for provider review.";
  }
}

function formatDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = Math.floor(ms / 3600000);
  const remainingAfterHours = ms - hours * 3600000;
  const minutes = Math.floor(remainingAfterHours / 60000);
  const remainingAfterMinutes = remainingAfterHours - minutes * 60000;
  const seconds = remainingAfterMinutes / 1000;
  const secondsLabel = Number.isInteger(seconds)
    ? `${seconds}s`
    : `${seconds.toFixed(3).replace(/\.?0+$/, "")}s`;
  if (hours === 0) return `${minutes}m ${secondsLabel}`;
  return `${hours}h ${minutes}m ${secondsLabel}`;
}

function acceptedReceiptTime(
  receipts: Array<Record<string, unknown>>,
  commandType: string,
): string | null {
  const match = [...receipts]
    .reverse()
    .find(
      (receipt) =>
        String(receipt.command_type) === commandType &&
        String(receipt.status) === "accepted",
    );
  return match ? String(match.claimed_at) : null;
}

function commandReceiptStatus(receipts: Array<Record<string, unknown>>): string | null {
  const latest = [...receipts].reverse()[0];
  if (!latest) return null;
  if (String(latest.status) === "conflict_preserved") {
    return mapConflictReason(String(latest.outcome && (latest.outcome as Record<string, unknown>).reason));
  }
  return null;
}

function launchUri(uri: string): boolean {
  if (typeof window === "undefined") return false;
  if (uri.startsWith("tel:")) {
    window.location.href = uri;
    return true;
  }
  const opened = window.open(uri, "_blank", "noopener,noreferrer");
  return opened !== null;
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}

export function WorkerShiftDetailClient({ detail }: { detail: ReadyWorkerShiftDetail }) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(commandReceiptStatus(detail.commandReceipts));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const shiftId = String(detail.shift.id);
  const state = String(detail.shift.state);
  const version = Number(detail.shift.version);
  const participantName = `${String(detail.participant.first_name ?? "Participant")}${detail.participant.last_initial ? ` ${String(detail.participant.last_initial)}.` : ""}`;
  const routes = detail.handoffRoutes;
  const hasEmergencyRoute = routes.some((route) => String(route.route_type) === "emergency");
  const hasIncidentRoute = routes.some((route) => String(route.route_type) === "incident");
  const routeReady = hasEmergencyRoute && hasIncidentRoute;
  const actualStart = acceptedReceiptTime(detail.commandReceipts, "start_shift");
  const actualEnd = acceptedReceiptTime(detail.commandReceipts, "end_shift");
  const hasAcceptedEnd = actualEnd !== null;
  const elapsedDuration = formatDuration(actualStart, actualEnd);
  const acknowledgement = detail.acknowledgement;
  const currentSummary = detail.currentSummaryVersion;
  const summaryBlocked =
    !routeReady ||
    !detail.snapshot ||
    !["ended_summary_required", "finalised", "corrected", "needs_review", "urgent_provider_review"].includes(state);
  const blockedReason =
    !routeReady
      ? "Current emergency and incident provider routes are required before delivery actions can continue."
      : !detail.snapshot
        ? "This shift is missing its immutable service snapshot. Contact the provider before continuing."
        : state === "legacy_incomplete"
          ? "Legacy incomplete shifts are not actionable in the worker flow."
          : null;

  async function runAction(actionKey: string, run: () => Promise<Record<string, unknown>>) {
    setBusyAction(actionKey);
    setErrorMessage(null);
    try {
      const result = await run();
      if (String(result.status) === "conflict_preserved") {
        setStatusMessage(mapConflictReason(typeof result.reason === "string" ? result.reason : undefined));
      } else if (String(result.new_state) === "urgent_provider_review") {
        setStatusMessage("Saved. Provider review remains active, and your evidence has been preserved.");
      } else {
        setStatusMessage("Saved. The server receipt is now the authoritative state.");
      }
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusyAction(null);
    }
  }

  async function recordHandoff(
    routeVersionId: string,
    eventType: "initiated" | "worker_confirmed" | "failed",
    selectedChannel: "primary" | "fallback",
    failureCode: "launch_failed" | "worker_cancelled" | null,
    afterSuccess?: () => void,
  ) {
    await runAction(`handoff-${routeVersionId}-${eventType}-${selectedChannel}`, async () => {
      const result = await cmdWorkerRecordHandoff(supabase, {
        p_command_id: crypto.randomUUID(),
        p_shift_id: shiftId,
        p_route_version_id: routeVersionId,
        p_event_type: eventType,
        p_selected_channel: selectedChannel,
        p_failure_code: failureCode,
        p_claimed_at: new Date().toISOString(),
        p_client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        p_payload: { source: "worker-detail" },
      });
      if (String(result.status) === "accepted" && afterSuccess) afterSuccess();
      if (String(result.status) === "accepted") {
        if (eventType === "initiated") setStatusMessage("Urgent handoff launch recorded. The product does not infer connection or provider acknowledgement.");
        if (eventType === "worker_confirmed") setStatusMessage("Worker confirmation recorded. This is not provider acknowledgement.");
        if (eventType === "failed") setStatusMessage("Launch failure recorded. The fallback route remains available.");
      }
      return result as unknown as Record<string, unknown>;
    });
  }

  const canOnMyWay = !blockedReason && state === "scheduled";
  const canStart = !blockedReason && (state === "scheduled" || state === "in_transit");
  const canEnd = !blockedReason && !hasAcceptedEnd && (state === "started" || state === "urgent_provider_review");
  const canSubmitSummary =
    !summaryBlocked &&
    (state === "ended_summary_required" || (state === "urgent_provider_review" && hasAcceptedEnd));

  return (
    <StickyActionLayout
      height="calc(100dvh - 8rem)"
      actionBar={
        <div className="flex flex-wrap justify-end gap-2 p-3">
          <Button asChild variant="outline" className="worker-control">
            <Link href="/worker">Back to Today</Link>
          </Button>
          {canOnMyWay ? (
            <Button
              variant="outline"
              className="worker-control"
              disabled={busyAction === "on-my-way"}
              aria-busy={busyAction === "on-my-way"}
              onClick={() =>
                runAction("on-my-way", async () =>
                  (await cmdOnMyWay(supabase, {
                    p_command_id: crypto.randomUUID(),
                    p_shift_id: shiftId,
                    p_claimed_at: new Date().toISOString(),
                    p_client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    p_payload: { source: "worker-detail" },
                  })) as unknown as Record<string, unknown>,
                )
              }
            >
              On my way
            </Button>
          ) : null}
          {canStart ? (
            <Button
              className="worker-control"
              disabled={busyAction === "start"}
              aria-busy={busyAction === "start"}
              onClick={() =>
                runAction("start", async () =>
                  (await cmdStartShift(supabase, {
                    p_command_id: crypto.randomUUID(),
                    p_shift_id: shiftId,
                    p_expected_version: version,
                    p_claimed_at: new Date().toISOString(),
                    p_client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    p_payload: { source: "worker-detail" },
                  })) as unknown as Record<string, unknown>,
                )
              }
            >
              Start shift
            </Button>
          ) : null}
          {canEnd ? (
            <Button
              className="worker-control"
              disabled={busyAction === "end"}
              aria-busy={busyAction === "end"}
              onClick={() =>
                runAction("end", async () =>
                  (await cmdEndShift(supabase, {
                    p_command_id: crypto.randomUUID(),
                    p_shift_id: shiftId,
                    p_expected_version: version,
                    p_claimed_at: new Date().toISOString(),
                    p_client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    p_payload: { source: "worker-detail" },
                  })) as unknown as Record<string, unknown>,
                )
              }
            >
              End shift
            </Button>
          ) : null}
          {canSubmitSummary ? (
            <Button
              className="worker-control"
              disabled={busyAction === "summary"}
              aria-busy={busyAction === "summary"}
              onClick={() => {
                if (!summaryText.trim()) {
                  setErrorMessage("Write a participant-readable summary before submitting.");
                  return;
                }
                void runAction("summary", async () =>
                  (await cmdSubmitSummary(supabase, {
                    p_command_id: crypto.randomUUID(),
                    p_shift_id: shiftId,
                    p_expected_version: version,
                    p_claimed_at: new Date().toISOString(),
                    p_client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    p_activities: [String(detail.snapshot?.item_name ?? "Delivered support")],
                    p_summary_text: summaryText.trim(),
                    p_audience: ["participant", "service_summary"],
                    p_payload: { source: "worker-detail" },
                  })) as unknown as Record<string, unknown>,
                );
              }}
            >
              Submit summary
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 pb-4">
        <header className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Assigned shift</p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{participantName}</h1>
              <p className="text-sm text-muted-foreground">
                {new Date(String(detail.shift.scheduled_start)).toLocaleString("en-AU")} –{" "}
                {new Date(String(detail.shift.scheduled_end)).toLocaleTimeString("en-AU", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
            <span className="rounded-full border px-3 py-1 text-sm font-medium">
              {displayState(state)}
            </span>
          </div>
          {actualStart || actualEnd ? (
            <p className="text-sm text-muted-foreground">
              Accepted time {actualStart ? new Date(actualStart).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"} –{" "}
              {actualEnd ? new Date(actualEnd).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}
              {elapsedDuration ? ` · exact elapsed ${elapsedDuration}` : ""}
            </p>
          ) : null}
        </header>

        {statusMessage ? <AccessibleStatus>{statusMessage}</AccessibleStatus> : null}
        {errorMessage ? <FormError id="worker-action-error">{errorMessage}</FormError> : null}
        {blockedReason ? <AccessibleStatus assertive>{blockedReason}</AccessibleStatus> : null}

        <Card>
          <CardHeader>
            <CardTitle>Urgent concern</CardTitle>
            <CardDescription>
              `000` is for immediate danger. Provider routes record only that the handoff was launched, confirmed by the worker, or failed to launch.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
              <p className="text-base font-semibold">Immediate danger — call `000`</p>
              <p className="mt-1 text-sm text-muted-foreground">Emergency services remain separate from provider process configuration.</p>
              <div className="mt-3">
                <Button asChild className="worker-control">
                  <a href="tel:000">Call 000</a>
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {routes.map((route) => {
                const routeId = String(route.route_version_id);
                const routeType = String(route.route_type);
                const primaryUri = String(route.primary_contact_uri);
                return (
                  <div key={routeId} className="rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-2">
                      <strong className="capitalize">{routeType}</strong>
                      <span className="rounded-full bg-muted px-2 py-1 text-xs">{String(route.owner_role_label)}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{String(route.guidance_text)}</p>
                    <p className="mt-2 text-sm">{String(route.primary_label)}</p>
                    <p className="text-xs text-muted-foreground">{primaryUri}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Fallback {String(route.fallback_phone)}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        className="worker-control"
                        disabled={busyAction === `handoff-${routeId}-initiated-primary`}
                        aria-busy={busyAction === `handoff-${routeId}-initiated-primary`}
                        onClick={() =>
                          void recordHandoff(routeId, "initiated", "primary", null, () => {
                            const launched = launchUri(primaryUri);
                            if (!launched) {
                              void recordHandoff(routeId, "failed", "primary", "launch_failed");
                            }
                          })
                        }
                      >
                        {primaryUri.startsWith("tel:") ? "Call primary route" : "Open primary route"}
                      </Button>
                      <Button
                        variant="outline"
                        className="worker-control"
                        disabled={busyAction === `handoff-${routeId}-initiated-fallback`}
                        aria-busy={busyAction === `handoff-${routeId}-initiated-fallback`}
                        onClick={() =>
                          void recordHandoff(routeId, "initiated", "fallback", null, () => {
                            launchUri(telHref(String(route.fallback_phone)));
                          })
                        }
                      >
                        Call fallback
                      </Button>
                      <Button
                        variant="outline"
                        className="worker-control"
                        onClick={() => void recordHandoff(routeId, "worker_confirmed", "primary", null)}
                      >
                        I followed these instructions
                      </Button>
                      <Button
                        variant="outline"
                        className="worker-control"
                        onClick={() => void recordHandoff(routeId, "failed", "primary", "launch_failed")}
                      >
                        Record launch issue
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rounded-lg border p-4 text-sm">
              <strong>Handoff evidence</strong>
              {detail.handoffReceipts.length === 0 ? (
                <p className="mt-2 text-muted-foreground">No urgent-handoff receipts for this shift yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {detail.handoffReceipts.map((receipt) => (
                    <div key={String(receipt.id)} className="rounded bg-muted/30 p-2">
                      <p>{String(receipt.route_type)} · {String(receipt.handoff_event).replaceAll("_", " ")} · channel {String(receipt.selected_channel)}</p>
                      <p className="text-xs text-muted-foreground">
                        Claimed {new Date(String(receipt.claimed_at)).toLocaleString("en-AU")} · failure code {String(receipt.failure_code ?? "none")}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Location and access</CardTitle>
              <CardDescription>Full address and access instructions stay inside the assigned shift detail.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><strong>Location hint:</strong> {String(detail.participant.location_hint ?? "Not recorded")}</p>
              <p><strong>Full address:</strong> {String(detail.participant.full_address ?? "Not recorded")}</p>
              <p><strong>Access instructions:</strong> {String(detail.participant.access_instructions ?? "Not recorded")}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Critical support and safety</CardTitle>
              <CardDescription>A missing or stale card stays visible and does not silently cancel essential support.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {detail.criticalCard ? (
                <>
                  <p>{String(detail.criticalCard.content_text)}</p>
                  <p className="text-muted-foreground">
                    Reviewed {new Date(String(detail.criticalCard.reviewed_at)).toLocaleString("en-AU")} · due {new Date(String(detail.criticalCard.review_due_at)).toLocaleString("en-AU")}
                  </p>
                </>
              ) : (
                <AccessibleStatus assertive>Critical support and safety information is missing. Contact the provider immediately.</AccessibleStatus>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Immutable service snapshot</CardTitle>
            <CardDescription>The worker cannot replace this item/goal snapshot with free text or enter billable time.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <p><strong>Support item</strong></p>
              <p>{String(detail.snapshot?.item_code ?? "—")} · {String(detail.snapshot?.item_name ?? "Snapshot missing")}</p>
            </div>
            <div>
              <p><strong>Category / kind</strong></p>
              <p>{String(detail.snapshot?.support_category ?? "—")} · {String(detail.snapshot?.service_kind ?? "—")}</p>
            </div>
            <div>
              <p><strong>Unit</strong></p>
              <p>{String(detail.snapshot?.time_unit ?? "—")}</p>
            </div>
            <div>
              <p><strong>Participant goal</strong></p>
              <p>{String(detail.snapshot?.goal_reference ?? "—")} · {String(detail.snapshot?.goal_display ?? "—")}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Service summary</CardTitle>
            <CardDescription>
              Participant-readable, text-only, and separate from incident reporting. Actual delivery time is derived from accepted Start and End.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <strong>Who will see this?</strong>
              <p className="mt-1 text-muted-foreground">Visible to the participant after successful finalisation. External access stays consent- and grant-scoped.</p>
            </div>
            <div className="rounded-md border p-3 text-sm">
              <strong>Support provided</strong>
              <p className="mt-1">{String(detail.snapshot?.item_name ?? "Snapshot missing")}</p>
            </div>
            {state === "ended_summary_required" ? (
              <div className="space-y-2">
                <label className="block text-sm font-medium" htmlFor="worker-summary-text">
                  Plain-English summary
                </label>
                <textarea
                  id="worker-summary-text"
                  value={summaryText}
                  onChange={(event) => setSummaryText(event.target.value)}
                  className="min-h-32 w-full rounded-md border bg-transparent p-3 text-base"
                  placeholder="Describe the support provided and the relevant outcome. Do not use this box for urgent incident reporting."
                />
              </div>
            ) : currentSummary ? (
              <div className="rounded-md border p-3 text-sm">
                <strong>Current summary</strong>
                <p className="mt-2">{String(currentSummary.summary_text ?? "No current summary text")}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Version {String(currentSummary.version_number ?? "—")} · activities {Array.isArray(currentSummary.activities) ? (currentSummary.activities as string[]).join(", ") : "—"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No current participant-readable summary is available yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acknowledgement source and status</CardTitle>
            <CardDescription>The acknowledgement path is separate from summary finalisation and never overclaims participant authentication.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {acknowledgement ? (
              <div className="rounded-md border p-3">
                <p><strong>Status:</strong> {String(acknowledgement.status_kind).replaceAll("_", " ")}</p>
                <p><strong>Event:</strong> {String(acknowledgement.event_type).replaceAll("_", " ")}</p>
                <p><strong>Source:</strong> {String(acknowledgement.source_label)}</p>
                <p><strong>Occurred:</strong> {new Date(String(acknowledgement.occurred_at)).toLocaleString("en-AU")}</p>
                {acknowledgement.reason ? <p><strong>Reason:</strong> {String(acknowledgement.reason)}</p> : null}
              </div>
            ) : (
              <AccessibleStatus>No provider-recorded acknowledgement is available yet. Missing acknowledgement does not roll an accepted summary back to pending.</AccessibleStatus>
            )}
          </CardContent>
        </Card>
      </div>
    </StickyActionLayout>
  );
}
