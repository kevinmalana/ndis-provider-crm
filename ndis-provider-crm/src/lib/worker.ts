import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadMembershipContext } from "@/lib/membership";

export type WorkerTodayShift = {
  shift_id: string;
  participant_id: string;
  participant_first_name: string;
  location_hint: string;
  scheduled_start: string;
  scheduled_end: string;
  state: string;
  version: number;
  has_emergency_route: boolean;
  has_incident_route: boolean;
};

export type WorkerShiftDetail =
  | {
      kind: "blocked";
      reason: string;
    }
  | {
      kind: "ready";
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

export async function loadWorkerShellContext() {
  const ctx = await loadMembershipContext();
  if (ctx.kind !== "ready" || !ctx.active || ctx.active.role !== "worker") {
    return null;
  }
  return ctx;
}

export async function loadWorkerToday(): Promise<WorkerTodayShift[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_worker_today_shifts");
  if (error) throw error;
  return (data ?? []) as WorkerTodayShift[];
}

export async function loadWorkerShiftDetail(shiftId: string): Promise<WorkerShiftDetail> {
  const supabase = await createSupabaseServerClient();

  const { data: shift, error: shiftError } = await supabase
    .from("shifts")
    .select("id,organisation_id,participant_id,scheduled_start,scheduled_end,state,version")
    .eq("id", shiftId)
    .maybeSingle();

  if (shiftError) throw shiftError;
  if (!shift) {
    return {
      kind: "blocked",
      reason: "This shift is no longer available under your current assignment. Contact the provider if you already captured evidence.",
    };
  }

  const participantId = String(shift.participant_id);
  const summaryHeaderPromise = supabase
    .from("service_summaries")
    .select("id,current_version_id,finalised_at,has_correction")
    .eq("shift_id", shiftId)
    .maybeSingle();

  const [
    participantResult,
    criticalCardResult,
    snapshotResult,
    summaryHeaderResult,
    handoffRoutesResult,
    handoffReceiptsResult,
    commandReceiptsResult,
    acknowledgementResult,
  ] = await Promise.all([
    supabase
      .from("participants")
      .select("id,first_name,last_initial,location_hint,full_address,access_instructions")
      .eq("id", participantId)
      .maybeSingle(),
    supabase
      .from("critical_info_cards")
      .select("id,content_text,reviewed_at,review_due_at,status")
      .eq("participant_id", participantId)
      .eq("status", "active")
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("shift_service_snapshots")
      .select("id,service_context_id,item_code,item_name,support_category,service_kind,time_unit,goal_reference,goal_display,scheduled_start,scheduled_end")
      .eq("shift_id", shiftId)
      .maybeSingle(),
    summaryHeaderPromise,
    supabase.rpc("list_worker_shift_handoff_routes", { p_shift_id: shiftId }),
    supabase
      .from("worker_handoff_receipts")
      .select("id,route_type,handoff_event,selected_channel,failure_code,claimed_at,command_receipt_id,created_at")
      .eq("shift_id", shiftId)
      .order("created_at"),
    supabase
      .from("command_receipts")
      .select("id,command_type,claimed_at,server_received_at,status,outcome")
      .eq("subject_shift_id", shiftId)
      .in("command_type", ["on_my_way", "start_shift", "end_shift", "submit_summary", "worker_handoff"])
      .order("server_received_at"),
    supabase.rpc("get_worker_shift_acknowledgement", { p_shift_id: shiftId }),
  ]);

  const firstError = [
    participantResult,
    criticalCardResult,
    snapshotResult,
    summaryHeaderResult,
    handoffRoutesResult,
    handoffReceiptsResult,
    commandReceiptsResult,
    acknowledgementResult,
  ].find((result) => result.error)?.error;

  if (firstError) throw firstError;

  const summaryHeader = summaryHeaderResult.data;
  let currentSummaryVersion: Record<string, unknown> | null = null;
  if (summaryHeader?.id) {
    const { data, error } = await supabase
      .from("service_summary_current_versions")
      .select("id,summary_id,version_number,activities,summary_text,audience_categories,created_at,is_correction,correction_reason")
      .eq("summary_id", summaryHeader.id)
      .maybeSingle();
    if (error) throw error;
    currentSummaryVersion = (data ?? null) as Record<string, unknown> | null;
  }

  return {
    kind: "ready",
    shift: shift as Record<string, unknown>,
    participant: (participantResult.data ?? {}) as Record<string, unknown>,
    criticalCard: (criticalCardResult.data ?? null) as Record<string, unknown> | null,
    snapshot: (snapshotResult.data ?? null) as Record<string, unknown> | null,
    summary: (summaryHeader ?? null) as Record<string, unknown> | null,
    currentSummaryVersion,
    handoffRoutes: (handoffRoutesResult.data ?? []) as Array<Record<string, unknown>>,
    handoffReceipts: (handoffReceiptsResult.data ?? []) as Array<Record<string, unknown>>,
    commandReceipts: (commandReceiptsResult.data ?? []) as Array<Record<string, unknown>>,
    acknowledgement: ((acknowledgementResult.data as Array<Record<string, unknown>> | null) ?? [])[0] ?? null,
  };
}
