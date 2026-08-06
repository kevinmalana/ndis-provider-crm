/**
 * Hand-maintained TypeScript types for the v1 domain schema.
 *
 * Why hand-maintained rather than `supabase gen types typescript --linked`:
 *   * The forward-identity migration (ticket 04) must apply to the
 *     Supabase project without requiring a linked CLI session from CI.
 *   * The schema is itself reviewable; capturing it in code lets the
 *     application build before the database is migrated.
 *   * Keeping these as a thin interface over the database also lets us
 *     run integration tests against a local pglite instance (see
 *     tests/db) without ever reading remote secrets.
 *
 * This file is the contract the application code reads from
 * Supabase. When the schema changes, update this file in the same
 * commit so reviewers can spot the type drift.
 */

export type UUID = string;
export type IsoTimestamp = string;

export type OrganisationRole =
  | "admin"
  | "scheduler"
  | "worker"
  | "participant"
  | "external"
  | "nominee";

export type MembershipStatus = "active" | "suspended" | "withdrawn";

export type ShiftState =
  | "scheduled"
  | "in_transit"
  | "started"
  | "ended_summary_required"
  | "submitted_local"
  | "syncing"
  | "finalised"
  | "needs_review"
  | "cancelled"
  | "cancelled_needs_review"
  | "corrected";

export type CommandType =
  | "on_my_way"
  | "start_shift"
  | "end_shift"
  | "submit_summary"
  | "finalise_summary"
  | "cancel_shift"
  | "reassign_shift"
  | "resolve_conflict"
  | "request_correction"
  | "apply_correction"
  | "request_access"
  | "accept_invitation";

export type CommandStatus =
  | "accepted"
  | "rejected"
  | "conflict_preserved"
  | "duplicate_returned";

export type EvidenceReviewState =
  | "pending"
  | "accepted_exception"
  | "rejected_with_reason"
  | "needs_more_info";

export type CorrectionRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn";

export type CorrectionRequesterKind =
  | "workforce"
  | "participant_self"
  | "representative";

export type GrantConsentBasis =
  | "participant"
  | "authorised_representative"
  | "provider_internal_use";

export type RepresentativeStatus =
  | "active"
  | "superseded"
  | "revoked"
  | "disputed";

export type GrantStatus = "active" | "superseded" | "revoked" | "expired";

/* ---------- organisations + identity ---------- */

export interface Organisation {
  id: UUID;
  name: string;
  slug: string;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  deleted_at: IsoTimestamp | null;
}

export interface GlobalProfile {
  id: UUID;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  deleted_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface OrganisationMembership {
  id: UUID;
  organisation_id: UUID;
  profile_id: UUID;
  role: OrganisationRole;
  status: MembershipStatus;
  effective_from: IsoTimestamp;
  effective_until: IsoTimestamp | null;
  withdrawn_at: IsoTimestamp | null;
  withdrawn_by: UUID | null;
  withdrawn_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ActiveOrganisationContext {
  profile_id: UUID;
  organisation_id: UUID;
  updated_at: IsoTimestamp;
}

/* ---------- invitations + audit + soft-delete ---------- */

export interface Invitation {
  id: UUID;
  organisation_id: UUID;
  email: string;
  role: OrganisationRole;
  token: string;
  expires_at: IsoTimestamp;
  accepted_at: IsoTimestamp | null;
  revoked_at: IsoTimestamp | null;
  issued_by: UUID | null;
  created_at: IsoTimestamp;
}

/* ---------- v1 domain ---------- */

export interface Participant {
  id: UUID;
  organisation_id: UUID;
  first_name: string;
  last_initial: string | null;
  archived_at: IsoTimestamp | null;
  created_by: UUID | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type ParticipantSelfLinkStatus = "active" | "withdrawn";

export interface ParticipantSelfLink {
  id: UUID;
  organisation_id: UUID;
  participant_id: UUID;
  profile_id: UUID;
  status: ParticipantSelfLinkStatus;
  linked_at: IsoTimestamp;
  withdrawn_at: IsoTimestamp | null;
  withdrawn_by: UUID | null;
  withdrawn_reason: string | null;
  evidence_reference: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface RepresentativeAuthority {
  id: UUID;
  organisation_id: UUID;
  participant_id: UUID;
  representative_profile_id: UUID;
  authority_type: string;
  scope_categories: string[];
  evidence_reference: string | null;
  issuer: string | null;
  issuer_profile_id: UUID | null;
  effective_from: IsoTimestamp;
  effective_until: IsoTimestamp | null;
  status: RepresentativeStatus;
  superseded_by: UUID | null;
  withdrawn_at: IsoTimestamp | null;
  withdrawn_by: UUID | null;
  withdrawn_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ExternalDisclosureGrant {
  id: UUID;
  organisation_id: UUID;
  participant_id: UUID;
  recipient_profile_id: UUID;
  purpose: string;
  scope_categories: string[];
  issuer: string | null;
  issuer_profile_id: UUID | null;
  consent_basis: GrantConsentBasis;
  consent_reference: string | null;
  evidence_reference: string | null;
  effective_from: IsoTimestamp;
  effective_until: IsoTimestamp;
  status: GrantStatus;
  superseded_by: UUID | null;
  withdrawn_at: IsoTimestamp | null;
  withdrawn_by: UUID | null;
  withdrawn_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface WorkerAvailability {
  id: UUID;
  organisation_id: UUID;
  membership_id: UUID;
  available_during: string; // tstzrange literal
  note: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface Shift {
  id: UUID;
  organisation_id: UUID;
  participant_id: UUID;
  scheduled_start: IsoTimestamp;
  scheduled_end: IsoTimestamp;
  state: ShiftState;
  version: number;
  cancellation_reason: string | null;
  cancelled_at: IsoTimestamp | null;
  cancelled_by: UUID | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ShiftAssignment {
  id: UUID;
  shift_id: UUID;
  organisation_id: UUID;
  membership_id: UUID;
  effective_from: IsoTimestamp;
  effective_until: IsoTimestamp | null;
  withdrawn_at: IsoTimestamp | null;
  reassignment_reason: string | null;
  assigned_by: UUID | null;
  superseded_by: UUID | null;
  version: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface CriticalInfoCard {
  id: UUID;
  organisation_id: UUID;
  participant_id: UUID;
  version: number;
  content_text: string;
  owner_profile_id: UUID | null;
  reviewed_at: IsoTimestamp;
  review_due_at: IsoTimestamp;
  superseded_by: UUID | null;
  status: "active" | "superseded";
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ServiceSummary {
  id: UUID;
  shift_id: UUID;
  current_version_id: UUID | null;
  finalised_at: IsoTimestamp | null;
  has_correction: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ServiceSummaryVersion {
  id: UUID;
  summary_id: UUID;
  version_number: number;
  activities: string[];
  summary_text: string;
  audience_categories: string[];
  author_membership_id: UUID;
  is_correction: boolean;
  correction_reason: string | null;
  superseded_by: UUID | null;
  created_at: IsoTimestamp;
}

/** Non-recursive current-version projection (used by participant / representative / external reads). */
export interface ServiceSummaryCurrentVersion
  extends Omit<ServiceSummaryVersion, "superseded_by"> {
  superseded_by: null;
}

export interface CommandReceipt {
  id: UUID;
  command_id: string;
  command_type: CommandType;
  organisation_id: UUID;
  actor_membership_id: UUID | null;
  actor_profile_id: UUID;
  subject_shift_id: UUID | null;
  subject_review_id: UUID | null;
  subject_request_id: UUID | null;
  subject_invitation_id: UUID | null;
  expected_version: number | null;
  claimed_at: IsoTimestamp;
  client_tz: string | null;
  server_received_at: IsoTimestamp;
  completed_at: IsoTimestamp | null;
  status: CommandStatus;
  outcome: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface EvidenceReviewQueue {
  id: UUID;
  receipt_id: UUID;
  organisation_id: UUID;
  state: EvidenceReviewState;
  original_payload: Record<string, unknown>;
  conflicting_context: Record<string, unknown>;
  decision_reason: string | null;
  decided_by: UUID | null;
  decided_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface CorrectionRequest {
  id: UUID;
  organisation_id: UUID;
  summary_id: UUID | null;
  shift_id: UUID | null;
  requester_kind: CorrectionRequesterKind;
  requester_profile_id: UUID;
  reason: string;
  requested_changes: string | null;
  status: CorrectionRequestStatus;
  decided_by: UUID | null;
  decided_at: IsoTimestamp | null;
  decision_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface AccessRequest {
  id: UUID;
  organisation_id: UUID;
  requester_profile_id: UUID;
  participant_id: UUID | null;
  scope_categories: string[];
  reason: string;
  requested_at: IsoTimestamp;
  status: CorrectionRequestStatus;
  decision_reason: string | null;
  decided_by: UUID | null;
  decided_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type ShiftEventType =
  | "on_my_way"
  | "start"
  | "end"
  | "summary_submitted"
  | "summary_finalised"
  | "cancelled"
  | "reassigned"
  | "corrected"
  | "conflicted"
  | "resolved";

export interface ShiftEvent {
  id: UUID;
  organisation_id: UUID;
  shift_id: UUID;
  event_type: ShiftEventType;
  occurred_at: IsoTimestamp;
  actor_membership_id: UUID | null;
  payload: Record<string, unknown>;
  created_at: IsoTimestamp;
}

/* ---------- RPC parameter + result signatures ---------- *
 * Every SQL parameter uses a `p_` prefix; the application code sends
 * the same prefixed keys. PostgREST matches named arguments exactly.
 */

export interface CommandRpcArgs {
  p_command_id: string;
  p_shift_id: UUID;
  p_claimed_at: IsoTimestamp;
  p_client_tz: string;
  p_payload: Record<string, unknown>;
}

export interface VersionedCommandRpcArgs extends CommandRpcArgs {
  p_expected_version: number;
}

export interface CommandResult {
  status: CommandStatus;
  duplicate?: boolean;
  receipt_id?: UUID;
  server_received_at?: IsoTimestamp;
  reason?: string;
  state?: ShiftState;
  current_version?: number;
  new_state?: ShiftState;
  version?: number;
  summary_id?: UUID;
  current_version_id?: UUID;
  previous_version_id?: UUID;
  new_version_id?: UUID;
  review_id?: UUID;
  decision?: string;
  original_receipt_id?: UUID;
  authoritative_state?: ShiftState;
  authoritative_version?: number;
  request_id?: UUID;
  requester_kind?: CorrectionRequesterKind;
  new_assignment_id?: UUID;
  previous_assignment_id?: UUID;
  outcome?: Record<string, unknown>;
}

export interface SubmitSummaryRpcArgs extends VersionedCommandRpcArgs {
  p_activities: string[];
  p_summary_text: string;
  p_audience: string[];
}

export interface FinaliseSummaryRpcArgs {
  p_command_id: string;
  p_shift_id: UUID;
  p_payload: Record<string, unknown>;
}

export interface CancelShiftRpcArgs extends VersionedCommandRpcArgs {
  p_reason: string;
}

export interface ReassignShiftRpcArgs extends VersionedCommandRpcArgs {
  p_new_worker_membership: UUID;
  p_reason: string;
}

export interface ResolveConflictRpcArgs {
  p_command_id: string;
  p_review_id: UUID;
  p_decision: "accept_exception" | "reject" | "needs_more_info";
  p_reason: string;
  p_payload: Record<string, unknown>;
}

export interface RequestCorrectionRpcArgs {
  p_command_id: string;
  p_shift_id: UUID;
  p_reason: string;
  p_requested_changes: string;
  p_payload: Record<string, unknown>;
}

export interface RequestAccessRpcArgs {
  p_command_id: string;
  p_participant_id: UUID;
  p_scope_categories: string[];
  p_reason: string;
  p_payload: Record<string, unknown>;
}

export interface ApplyCorrectionRpcArgs {
  p_command_id: string;
  p_request_id: UUID;
  p_expected_version: number;
  p_claimed_at: IsoTimestamp;
  p_client_tz: string;
  p_activities: string[];
  p_summary_text: string;
  p_audience: string[];
  p_reason: string;
  p_payload: Record<string, unknown>;
}
