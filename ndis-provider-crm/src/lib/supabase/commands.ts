/**
 * Strongly-typed RPC wrappers for the v1 domain commands.
 *
 * The application never writes to the v1 domain tables via raw
 * `supabase.from('shifts').update(...)` — every sensitive state
 * transition goes through a transactional RPC defined in migration
 * 0005. This module centralises the call signatures so reviewers can
 * see exactly what each command does.
 *
 * Parameter names match the SQL function signatures exactly (p_ prefix
 * convention). PostgREST binds named arguments to function parameters;
 * the wrappers therefore send the same prefixed keys.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ApplyCorrectionRpcArgs,
  CommandReceipt,
  CommandResult,
  FinaliseSummaryRpcArgs,
  ReassignShiftRpcArgs,
  CancelShiftRpcArgs,
  RequestCorrectionRpcArgs,
  RequestAccessRpcArgs,
  ResolveConflictRpcArgs,
  SubmitSummaryRpcArgs,
  VersionedCommandRpcArgs,
  AdminCommandResult,
  AdminCreateParticipantRpcArgs,
  AdminCreateShiftRpcArgs,
  AdminHandoffRouteRpcArgs,
  AdminProviderScopeRpcArgs,
  AdminSupportCapabilityRpcArgs,
  AdminCatalogueItemRpcArgs,
  AdminIdentifierRpcArgs,
  AdminServiceContextRpcArgs,
  ProviderReadinessRpcArgs,
  WorkerHandoffRpcArgs,
} from "@/lib/supabase/types.domain";

type RpcClient = SupabaseClient;

export async function cmdOnMyWay(
  client: RpcClient,
  args: Omit<VersionedCommandRpcArgs, "p_expected_version">,
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
  args: FinaliseSummaryRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_finalise_summary", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdCancelShift(
  client: RpcClient,
  args: CancelShiftRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_cancel_shift", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdReassignShift(
  client: RpcClient,
  args: ReassignShiftRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_reassign_shift", args);
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

export async function cmdRequestAccess(
  client: RpcClient,
  args: RequestAccessRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_request_access", args);
  if (error) throw error;
  return data as CommandResult;
}

export async function cmdAcceptInvitation(
  client: RpcClient,
  token: string,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_accept_invitation", {
    p_token: token,
  });
  if (error) throw error;
  return data as CommandResult;
}

export async function setActiveOrganisation(
  client: RpcClient,
  organisationId: string,
): Promise<void> {
  const { error } = await client.rpc("set_active_organisation", {
    p_organisation_id: organisationId,
  });
  if (error) throw error;
}

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

async function adminRpc(client: RpcClient, name: string, args: Record<string, unknown>): Promise<AdminCommandResult> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as AdminCommandResult;
}

export const cmdAdminInvite = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_invite", args);

export const cmdAdminCreateParticipant = (
  client: RpcClient,
  args: AdminCreateParticipantRpcArgs,
) => adminRpc(client, "cmd_admin_create_participant", args as unknown as Record<string, unknown>);

export const cmdAdminSetAuthority = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_set_authority", args);

export const cmdAdminCreateGrant = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_create_grant", args);

export const cmdAdminRevokeGrant = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_revoke_grant", args);

export const cmdAdminSetAvailability = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_set_availability", args);

export const cmdAdminCreateServiceReadyShift = (client: RpcClient, args: AdminCreateShiftRpcArgs) =>
  adminRpc(client, "cmd_admin_create_service_ready_shift", args as unknown as Record<string, unknown>);

export const cmdAdminCreateHandoffRoute = (client: RpcClient, args: AdminHandoffRouteRpcArgs) =>
  adminRpc(client, "cmd_admin_create_handoff_route", args as unknown as Record<string, unknown>);

export const cmdAdminRevealParticipantNdisIdentifier = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_reveal_participant_ndis_identifier", args);

export const cmdAdminSetParticipantNdisIdentifier = (client: RpcClient, args: AdminIdentifierRpcArgs) =>
  adminRpc(client, "cmd_admin_set_ndis_identifier", args as unknown as Record<string, unknown>);

export const cmdAdminCreateServiceContext = (client: RpcClient, args: AdminServiceContextRpcArgs) =>
  adminRpc(client, "cmd_admin_create_service_context", args as unknown as Record<string, unknown>);

export const cmdAdminCreateProviderScopeVersion = (client: RpcClient, args: AdminProviderScopeRpcArgs) =>
  adminRpc(client, "cmd_admin_create_provider_scope_version", args as unknown as Record<string, unknown>);

export const cmdAdminCreateSupportCapability = (client: RpcClient, args: AdminSupportCapabilityRpcArgs) =>
  adminRpc(client, "cmd_admin_create_support_capability", args as unknown as Record<string, unknown>);

export const cmdAdminCreateCatalogueItem = (client: RpcClient, args: AdminCatalogueItemRpcArgs) =>
  adminRpc(client, "cmd_admin_create_catalogue_item", args as unknown as Record<string, unknown>);

export const cmdAdminRecordWorkerVerification = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_record_worker_verification", args);

export const cmdAdminCreateRiskRole = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_create_risk_role", args);

export const cmdAdminCreateScreeningPolicy = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_create_screening_policy", args);

export const cmdAdminCreateCompetenceRequirement = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_create_competence_requirement", args);

export const cmdAdminRecordWorkerPathway = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_record_worker_pathway", args);

export const cmdAdminRecordCompetenceEvidence = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_record_competence_evidence", args);

export const cmdAdminUpdateServiceContextState = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_update_service_context_state", args);

export const cmdAdminRecordAcknowledgement = (client: RpcClient, args: Record<string, unknown>) =>
  adminRpc(client, "cmd_admin_record_acknowledgement", args);

export async function listAdminProviderReadiness(client: RpcClient, args: ProviderReadinessRpcArgs): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("list_admin_provider_readiness", args);
  if (error) throw error;
  return (data ?? {}) as Record<string, unknown>;
}

export async function listAdminAcknowledgementLedger(client: RpcClient, organisationId: string, shiftId: string | null): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.rpc("list_admin_acknowledgement_ledger", { p_organisation_id: organisationId, p_shift_id: shiftId });
  if (error) throw error;
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function cmdWorkerRecordHandoff(
  client: RpcClient,
  args: WorkerHandoffRpcArgs,
): Promise<CommandResult> {
  const { data, error } = await client.rpc("cmd_worker_record_handoff", args);
  if (error) throw error;
  return data as CommandResult;
}
