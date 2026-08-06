/**
 * Strongly-typed RPC wrappers for the v1 domain commands.
 *
 * The application never writes to the v1 domain tables via raw
 * `supabase.from('shifts').update(...)` — every sensitive state
 * transition goes through a transactional RPC defined in migration
 * 0005. This module centralises the call signatures so reviewers can
 * see exactly what each command does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ApplyCorrectionRpcArgs,
  CommandReceipt,
  CommandResult,
  RequestCorrectionRpcArgs,
  ResolveConflictRpcArgs,
  SubmitSummaryRpcArgs,
  VersionedCommandRpcArgs,
} from "@/lib/supabase/types.domain";

type RpcClient = SupabaseClient;

export async function cmdOnMyWay(
  client: RpcClient,
  args: Omit<VersionedCommandRpcArgs, "expected_version">,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_on_my_way", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdStartShift(
  client: RpcClient,
  args: VersionedCommandRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_start_shift", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdEndShift(
  client: RpcClient,
  args: VersionedCommandRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_end_shift", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdSubmitSummary(
  client: RpcClient,
  args: SubmitSummaryRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_submit_summary", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdFinaliseSummary(
  client: RpcClient,
  args: Omit<VersionedCommandRpcArgs, "claimed_at" | "client_tz" | "expected_version">,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_finalise_summary", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdResolveConflict(
  client: RpcClient,
  args: ResolveConflictRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_resolve_conflict", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdRequestCorrection(
  client: RpcClient,
  args: RequestCorrectionRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_request_correction", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdApplyCorrection(
  client: RpcClient,
  args: ApplyCorrectionRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_apply_correction", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function setActiveOrganisation(
  client: RpcClient,
  organisationId: string,
): Promise<void> {
  const { error } = await client.rpc("set_active_organisation", {
    organisation_id: organisationId,
  });
  if (error) throw error;
}

/**
 * Look up the caller's own command receipts — useful for client-side
 * idempotency caches (the same command_id is guaranteed to return the
 * same receipt, so the client only needs to read what it issued).
 */
export async function listMyReceipts(
  client: RpcClient,
): Promise<CommandReceipt[]> {
  const { data, error } = await client
    .from("command_receipts")
    .select("*")
    .order("server_received_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as CommandReceipt[];
}
