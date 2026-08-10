/**
 * @vitest-environment happy-dom
 *
 * Mounted AdminWorkspace integration tests. Helper / static contract
 * tests alone do not prove that the real component behaves correctly
 * when the browser calls into Supabase and Next.js — these tests
 * mount the actual AdminWorkspace with a mocked Supabase client and a
 * mocked router, then exercise the scenarios the prior rounds left
 * open:
 *
 *   1. Normal success: form values stay preserved and the success
 *      banner is rendered; subsequent clicks send the same logical
 *      arguments with the same command ID.
 *   2. Committed-but-response-lost retry: the same command ID is
 *      reused; the next attempt sees the server's duplicate_returned
 *      outcome normalized back into the same shift result and
 *      warning set.
 *   3. Duplicate warning outcome: warnings are tied to the shift
 *      result and survive both the duplicate retry and a simulated
 *      data refresh.
 *   4. Ack / new-intent rotation: acknowledging every warning for a
 *      shift result mints a fresh command ID for the next submission.
 *   5. Preserved form arguments: a transport-uncertain retry sends
 *      exactly the same form values, never the cleared values from a
 *      previous successful submission.
 *   6. Simultaneous unrelated forms: submitting one form does not
 *      disable or block the others — every submitting control
 *      visibly reflects its own pending state via aria-busy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const routerMock = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createSupabaseBrowserClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  }),
}));

const clipboardMock = vi.fn().mockResolvedValue(undefined);
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardMock },
    configurable: true,
    writable: true,
  });
}

import { AdminWorkspace } from "@/app/app/admin/workspace-client";

type RpcResponse = {
  status?: "accepted" | "duplicate_returned";
  receipt_id?: string;
  shift_id?: string;
  warnings?: string[];
  outcome?: {
    shift_id?: string;
    warnings?: string[];
    invitation_id?: string;
    token?: string;
    role?: string;
    email?: string;
    expires_at?: string;
  };
  token?: string;
  invitation_id?: string;
  email?: string;
  role?: string;
  expires_at?: string;
};

const initialData = {
  participants: [
    { id: "p-1", first_name: "Maya", last_initial: "R", created_at: "2026-08-01T00:00:00Z" },
  ],
  cards: [
    { id: "c-1", participant_id: "p-1", content_text: "x", reviewed_at: "2026-08-01", review_due_at: "2026-09-01", status: "active" },
  ],
  memberships: [],
  identities: [
    { profile_id: "worker-1", full_name: "Wendy Worker", email: "worker@example.test", role: "worker", membership_id: "m-worker-1" },
    { profile_id: "ext-1", full_name: "Eli External", email: "external@example.test", role: "external" },
    { profile_id: "rep-1", full_name: "Rita Rep", email: "rep@example.test", role: "nominee" },
    { profile_id: "participant-1", full_name: "Maya Account", email: "maya@example.test", role: "participant" },
  ],
  shifts: [],
  assignments: [],
  authorities: [],
  selfLinks: [{ participant_id: "p-1", profile_id: "participant-1", status: "active" }],
  grants: [],
  consents: [],
  availability: [],
  audit: [],
  serviceContexts: [{ id: "ctx-1", participant_id: "p-1", goal_reference: "Goal 1", lifecycle_state: "active" }],
};

const organisation = { id: "org-1", name: "Test Org", role: "scheduler" };

function mockRpcSequence(responses: RpcResponse[]): void {
  // Queue additional responses on the mock without resetting it,
  // so the cumulative call history across the test reflects every
  // rpc invocation. Earlier queued responses should already have
  // been consumed by their respective submissions.
  for (const response of responses) {
    rpcMock.mockResolvedValueOnce({ data: response, error: null });
  }
}
function mockRpcError(message: string): void {
  rpcMock.mockResolvedValueOnce({ data: null, error: { message } });
}

beforeEach(() => {
  rpcMock.mockReset();
  routerMock.refresh.mockReset();
  clipboardMock.mockReset();
  clipboardMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardMock },
    configurable: true,
    writable: true,
  });
});

const readinessData = {
  ...initialData,
  identities: [
    ...initialData.identities,
    { profile_id: "admin-1", full_name: "Alice Admin", email: "admin@example.test", role: "admin", membership_id: "m-admin-1" },
    { profile_id: "scheduler-1", full_name: "Sam Scheduler", email: "scheduler@example.test", role: "scheduler", membership_id: "m-scheduler-1" },
  ],
  shifts: [{ id: "shift-ready", participant_id: "p-1", scheduled_start: "2026-09-01T09:00:00Z", scheduled_end: "2026-09-01T10:00:00Z", state: "scheduled" }],
  serviceContexts: [{ id: "ctx-1", participant_id: "p-1", capability_id: "cap-1", catalogue_item_id: "item-1", role_version_id: "role-1", jurisdiction: "NSW", owner_profile_id: "admin-1", reviewer_profile_id: "scheduler-1", goal_reference: "Goal 1", lifecycle_state: "active" }],
  providerScopes: [{ id: "scope-1", registration_state: "registered", jurisdictions: ["NSW"], status: "active" }],
  capabilities: [{ id: "cap-1", support_category: "daily_living", service_kind: "individual_time", capability: "individual_time_supported", status: "active" }],
  catalogues: [{ id: "catalogue-1", source_label: "Provider catalogue", source_version: "2026.1", status: "active" }],
  catalogueItems: [{ id: "item-1", catalogue_version_id: "catalogue-1", item_code: "TIME-1", item_name: "Individual time", support_category: "daily_living", service_kind: "individual_time", time_unit: "hour", status: "active" }],
  roles: [{ id: "role-1", title: "Support worker", risk_assessed: true, status: "active" }],
  screeningPolicies: [],
  screeningVerifications: [{ id: "verify-1", worker_membership_id: "m-worker-1", role_version_id: "role-1", source_checked: "State register", verifier_name: "Verifier A", verified_at: "2026-08-01", application_or_check_reference: "CHECK-1", clearance_status: "current", interim_bar: true, suspension: false, exclusion: false, revocation: false, effective_from: "2026-08-01", effective_until: "2026-09-01" }],
  screeningPathways: [],
  competenceRequirements: [{ id: "requirement-1", role_version_id: "role-1", evidence_type: "induction", support_category: "daily_living", requirement_state: "required", assessment_method: "provider_assessed", review_owner: "Clinical lead", effective_from: "2026-08-01" }],
  competenceEvidence: [{ id: "evidence-1", worker_membership_id: "m-worker-1", requirement_id: "requirement-1", evidence_reference: "COMP-1", issuer: "Training provider", verifier_name: "Verifier B", assessed_state: "met", effective_from: "2026-08-01" }],
  maskedIdentifiers: [{ participant_id: "p-1", masked_identifier: "*******0123" }],
  snapshots: [{ shift_id: "shift-ready", catalogue_version_id: "catalogue-1", item_code: "TIME-1", item_name: "Individual time", support_category: "daily_living", service_kind: "individual_time", time_unit: "hour", goal_reference: "Goal 1", goal_display: "Community access" }],
  ackLedger: [{ id: "ack-current", shift_id: "shift-ready", event_class: "conclusive", event_type: "external_signed_evidence", source_channel: "provider_recorded", recorder_profile_id: "admin-1", reported_signer_profile_id: "participant-1", authority_type: "participant_self", authority_source_type: "participant_self_link", authority_source_id: "self-link-1", method: "signed form", external_evidence_reference: "ACK-1", occurred_at: "2026-09-01T10:05:00Z", reason: "Initial evidence", current_leaf: true, review_only: false }],
};

describe("mounted AdminWorkspace — complete provider readiness surface", () => {
  it("submits controlled catalogue values while unrelated readiness forms remain independently usable", async () => {
    let release: ((value: unknown) => void) | undefined;
    rpcMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={readinessData} />);
    await clickTab("Readiness");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Catalogue source"), { target: { value: "Controlled source" } });
      fireEvent.change(screen.getByLabelText("Catalogue version"), { target: { value: "2026.9" } });
      fireEvent.change(screen.getByLabelText("Item code"), { target: { value: "CONTROLLED-9" } });
      fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "Controlled individual support" } });
      fireEvent.change(screen.getByLabelText("Time unit"), { target: { value: "minute" } });
      fireEvent.submit(screen.getByRole("button", { name: "Add time-based supported item" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][0]).toBe("cmd_admin_create_catalogue_item");
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_source_label: "Controlled source", p_source_version: "2026.9", p_item_code: "CONTROLLED-9", p_item_name: "Controlled individual support", p_time_unit: "minute" });
    expect(screen.getByRole("button", { name: "Add time-based supported item" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record current screening verification" })).not.toBeDisabled();
    await act(async () => release?.({ data: { status: "accepted" }, error: null }));
  });

  it("creates a reviewed role/jurisdiction-bound context and renders a server readiness recovery reason", async () => {
    rpcMock.mockResolvedValueOnce({ data: { status: "accepted", service_context_id: "ctx-new" }, error: null });
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={readinessData} />);
    await clickTab("Readiness");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Context participant"), { target: { value: "p-1" } });
      fireEvent.change(screen.getByLabelText("Context capability"), { target: { value: "cap-1" } });
      fireEvent.change(screen.getByLabelText("Context catalogue item"), { target: { value: "item-1" } });
      fireEvent.change(screen.getByLabelText("Context risk role"), { target: { value: "role-1" } });
      fireEvent.change(screen.getByLabelText("Context jurisdiction"), { target: { value: "NSW" } });
      fireEvent.change(screen.getByLabelText("Context owner"), { target: { value: "admin-1" } });
      fireEvent.change(screen.getByLabelText("Active reviewer"), { target: { value: "scheduler-1" } });
      fireEvent.change(screen.getByLabelText("External agreement reference"), { target: { value: "AGREEMENT-9" } });
      fireEvent.change(screen.getByLabelText("Goal reference"), { target: { value: "GOAL-9" } });
      fireEvent.change(screen.getByLabelText("Goal display"), { target: { value: "Community participation" } });
      fireEvent.submit(screen.getByRole("button", { name: "Create service context" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_role_version_id: "role-1", p_jurisdiction: "NSW", p_reviewer_profile_id: "scheduler-1", p_lifecycle_state: "active" });
    rpcMock.mockResolvedValueOnce({ data: { ready: false, reason: "catalogue_version_not_current" }, error: null });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Readiness worker"), { target: { value: "m-worker-1" } });
      fireEvent.change(screen.getByLabelText("Readiness context"), { target: { value: "ctx-1" } });
      fireEvent.submit(screen.getByRole("button", { name: "Check readiness" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(screen.getByText(/Create a current catalogue version whose window contains the item and shift/i)).toBeInTheDocument());
    expect(rpcMock.mock.calls[1][0]).toBe("list_admin_provider_readiness");
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ p_worker_membership_id: "m-worker-1", p_participant_id: "p-1", p_context_id: "ctx-1" });
  });

  it("reveals identifiers through the audited RPC and corrects the current acknowledgement leaf", async () => {
    rpcMock.mockResolvedValueOnce({ data: { status: "accepted", identifier: "43000000123" }, error: null });
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={readinessData} />);
    await clickTab("Readiness");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Identifier participant"), { target: { value: "p-1" } });
      fireEvent.change(screen.getByLabelText("Reveal reason"), { target: { value: "Acceptance evidence review" } });
      fireEvent.submit(screen.getByRole("button", { name: "Reveal full identifier with audit" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(screen.getByText(/43000000123/)).toBeInTheDocument());
    expect(rpcMock.mock.calls[0][0]).toBe("cmd_admin_reveal_participant_ndis_identifier");
    expect(screen.getByText(/\*\*\*\*\*\*\*0123/)).toBeInTheDocument();
    rpcMock.mockResolvedValueOnce({ data: { status: "accepted", event_id: "ack-corrected" }, error: null });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Service record"), { target: { value: "shift-ready" } });
      fireEvent.change(screen.getByLabelText("Acknowledgement event"), { target: { value: "correction" } });
      fireEvent.change(screen.getByLabelText("Reported signer authority"), { target: { value: "participant-1|participant_self" } });
      fireEvent.change(screen.getByLabelText("External acknowledgement evidence reference"), { target: { value: "ACK-CORRECTION-1" } });
      fireEvent.change(screen.getByLabelText("Evidence method"), { target: { value: "signed_external_form" } });
      fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Supersede incorrect signed outcome" } });
      fireEvent.submit(screen.getByRole("button", { name: "Record provider acknowledgement" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ p_expected_current_event_id: "ack-current", p_method: "signed_external_form", p_reason: "Supersede incorrect signed outcome", p_event_type: "external_decline_evidence" });
    expect(screen.getByText(/current outcome/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider catalogue · 2026.1 · hour/i)).toBeInTheDocument();
  });

  it("hydrates lifecycle fields, invalidates stale readiness and role-gates scheduler controls", async () => {
    rpcMock.mockResolvedValueOnce({ data: { ready: true }, error: null });
    render(<AdminWorkspace organisation={organisation} initialData={readinessData} />);
    await clickTab("Readiness");
    expect(screen.getByRole("button", { name: "Save provider scope version" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save context lifecycle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record current screening verification" })).not.toBeDisabled();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Service context"), { target: { value: "ctx-1" } });
    });
    expect(screen.getByLabelText("Lifecycle reviewer")).toHaveValue("scheduler-1");
    expect(screen.getByLabelText("Lifecycle role")).toHaveValue("role-1");
    expect(screen.getByLabelText("Lifecycle jurisdiction")).toHaveValue("NSW");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Readiness worker"), { target: { value: "m-worker-1" } });
      fireEvent.change(screen.getByLabelText("Readiness context"), { target: { value: "ctx-1" } });
      fireEvent.submit(screen.getByRole("button", { name: "Check readiness" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create service-ready shift" })).not.toBeDisabled());
    await act(async () => fireEvent.change(screen.getByLabelText("Readiness end"), { target: { value: "2026-09-02T11:00" } }));
    expect(screen.getByRole("button", { name: "Create service-ready shift" })).toBeDisabled();
    expect(screen.getByText(/Inputs changed — run readiness again/i)).toBeInTheDocument();
  });

  it("submits controlled adverse screening and limited competence evidence values", async () => {
    rpcMock.mockResolvedValue({ data: { status: "accepted" }, error: null });
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={readinessData} />);
    await clickTab("Readiness");
    fireEvent.change(screen.getByLabelText("Service record"), { target: { value: "shift-ready" } });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Worker"), { target: { value: "m-worker-1" } });
      fireEvent.change(screen.getByLabelText("Risk-assessed role"), { target: { value: "role-1" } });
      fireEvent.change(screen.getByLabelText("Screening verifier"), { target: { value: "Reviewer A" } });
      fireEvent.change(screen.getByLabelText("Application/check reference"), { target: { value: "CHECK-ADVERSE" } });
      fireEvent.click(screen.getByLabelText("Interim bar"));
      fireEvent.submit(screen.getByRole("button", { name: "Record current screening verification" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_interim_bar: true, p_verifier_name: "Reviewer A", p_application_or_check_reference: "CHECK-ADVERSE" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Required competence"), { target: { value: "requirement-1" } });
      fireEvent.change(screen.getByLabelText("Evidence issuer"), { target: { value: "Issuer A" } });
      fireEvent.change(screen.getByLabelText("Evidence verifier"), { target: { value: "Verifier A" } });
      fireEvent.change(screen.getByLabelText("Evidence state"), { target: { value: "not_met" } });
      fireEvent.change(screen.getByLabelText("Evidence limitation"), { target: { value: "Supervised duties only" } });
      fireEvent.change(screen.getByLabelText("Evidence reference"), { target: { value: "COMP-LIMITED" } });
      fireEvent.submit(screen.getByRole("button", { name: "Record competence evidence" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ p_assessed_state: "not_met", p_limitation: "Supervised duties only", p_issuer: "Issuer A" });
    expect(screen.getByText(/adverse: bar/i)).toBeInTheDocument();
    expect(screen.getByText(/authority participant_self/i)).toBeInTheDocument();
    expect(screen.getByText(/Recorded by: Alice Admin/i)).toBeInTheDocument();
    expect(screen.getByText(/participant_self_link \/ self-link-1/i)).toBeInTheDocument();
    expect(screen.getByText(/record COMP-1 · issuer Training provider · verifier Verifier B/i)).toBeInTheDocument();
  });

  it("submits non-default controlled assessment and competence expiry dates", async () => {
    rpcMock.mockResolvedValue({ data: { status: "accepted" }, error: null });
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={readinessData} />);
    await clickTab("Readiness");

    const assessmentDate = "2026-07-14T09:30";
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Risk-assessed role title"), { target: { value: "Complex support worker" } });
      fireEvent.change(screen.getByLabelText("Role definition basis"), { target: { value: "Provider risk review" } });
      fireEvent.change(screen.getByLabelText("Role description"), { target: { value: "Complex supports" } });
      fireEvent.change(screen.getByLabelText("Role assessor"), { target: { value: "Assessment Lead" } });
      fireEvent.change(screen.getByLabelText("Assessor title"), { target: { value: "Clinical Director" } });
      fireEvent.change(screen.getByLabelText("Assessment date"), { target: { value: assessmentDate } });
      fireEvent.submit(screen.getByRole("button", { name: "Define risk-assessed role" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][0]).toBe("cmd_admin_create_risk_role");
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_assessed_at: new Date(assessmentDate).toISOString() });

    const evidenceExpiry = "2027-02-03T17:45";
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Worker"), { target: { value: "m-worker-1" } });
      fireEvent.change(screen.getByLabelText("Required competence"), { target: { value: "requirement-1" } });
      fireEvent.change(screen.getByLabelText("Evidence issuer"), { target: { value: "Training Provider" } });
      fireEvent.change(screen.getByLabelText("Evidence verifier"), { target: { value: "Verifier A" } });
      fireEvent.change(screen.getByLabelText("Evidence reference"), { target: { value: "COMP-DATED" } });
      fireEvent.change(screen.getByLabelText("Evidence expiry"), { target: { value: evidenceExpiry } });
      fireEvent.submit(screen.getByRole("button", { name: "Record competence evidence" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(rpcMock.mock.calls[1][0]).toBe("cmd_admin_record_competence_evidence");
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ p_expires_at: new Date(evidenceExpiry).toISOString() });
  });

  it("keeps lifecycle context values isolated from readiness context selection", async () => {
    const twoContextData = {
      ...readinessData,
      serviceContexts: [
        ...readinessData.serviceContexts,
        { id: "ctx-2", participant_id: "p-1", capability_id: "cap-1", catalogue_item_id: "item-1", role_version_id: "role-2", jurisdiction: "VIC", owner_profile_id: "admin-1", reviewer_profile_id: "admin-1", goal_reference: "Goal 2", lifecycle_state: "review_required" },
      ],
      roles: [...readinessData.roles, { id: "role-2", title: "Alternate worker", risk_assessed: true, status: "active" }],
    };
    rpcMock.mockResolvedValue({ data: { status: "accepted" }, error: null });
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={twoContextData} />);
    await clickTab("Readiness");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Service context"), { target: { value: "ctx-1" } });
      fireEvent.change(screen.getByLabelText("Readiness context"), { target: { value: "ctx-2" } });
      fireEvent.submit(screen.getByRole("button", { name: "Save context lifecycle" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][0]).toBe("cmd_admin_update_service_context_state");
    expect(rpcMock.mock.calls[0][1]).toMatchObject({
      p_context_id: "ctx-1",
      p_reviewer_profile_id: "scheduler-1",
      p_role_version_id: "role-1",
      p_jurisdiction: "NSW",
    });
    expect(rpcMock.mock.calls[0][1]).not.toMatchObject({ p_context_id: "ctx-2" });
    expect(rpcMock.mock.calls[0][1]).not.toMatchObject({ p_reviewer_profile_id: "admin-1" });
    expect(rpcMock.mock.calls[0][1]).not.toMatchObject({ p_role_version_id: "role-2" });
    expect(rpcMock.mock.calls[0][1]).not.toMatchObject({ p_jurisdiction: "VIC" });
  });

  it("renders clearance expiry and pathway validity windows in the audit card", async () => {
    const auditWindowData = {
      ...readinessData,
      screeningVerifications: [{ ...readinessData.screeningVerifications[0], clearance_expires_at: "2027-06-30T23:59:00Z" }],
      screeningPathways: [{ id: "pathway-1", worker_membership_id: "m-worker-1", role_version_id: "role-1", pathway: "working_on_application", jurisdiction: "NSW", application_placement_contract_reference: "APP-1", pathway_start: "2026-08-15T00:00:00Z", pathway_end: "2026-12-15T23:59:00Z", supervisor_membership_id: "m-admin-1", supervisor_clearance_reference: "SUP-1", risk_management_plan_reference: "RISK-1", effective_from: "2026-08-01T00:00:00Z", effective_until: "2027-01-01T00:00:00Z" }],
    };
    render(<AdminWorkspace organisation={{ ...organisation, role: "admin" }} initialData={auditWindowData} />);
    await clickTab("Readiness");

    expect(screen.getByText(/Clearance expires 2027-06-30T23:59:00Z/)).toBeInTheDocument();
    expect(screen.getByText(/Pathway valid from 2026-08-15T00:00:00Z/)).toBeInTheDocument();
    expect(screen.getByText(/Pathway valid to 2026-12-15T23:59:00Z/)).toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
});

async function clickByRole(role: string, name: RegExp | string): Promise<HTMLElement> {
  const element = screen.getByRole(role, { name: name instanceof RegExp ? name : new RegExp(name) });
  await act(async () => {
    fireEvent.click(element);
  });
  return element;
}

async function clickByText(text: RegExp | string): Promise<HTMLElement> {
  const element = screen.getByText(text instanceof RegExp ? text : new RegExp(text));
  await act(async () => {
    fireEvent.click(element);
  });
  return element;
}

async function submitShiftForm(): Promise<void> {
  // Submitting a <button type="submit"> via fireEvent.click does not
  // always trigger the form's onSubmit in happy-dom; firing submit
  // on the form element is the most reliable path. Fall back to
  // click when the form cannot be located.
  const button = screen.getByRole("button", { name: /^Create shift$/ }) as HTMLButtonElement;
  const form = button.closest("form") as HTMLFormElement | null;
  if (form) {
    await act(async () => {
      fireEvent.submit(form);
    });
  } else {
    await act(async () => {
      fireEvent.click(button);
    });
  }
}

async function fillCreateShift(): Promise<void> {
  // The Roster tab renders three forms; the labels "Worker",
  // "Participant", "Scheduled start", etc. appear on multiple
  // forms. Use the first matching control for the create-shift form.
  await act(async () => {
    const participants = screen.getAllByLabelText("Participant");
    fireEvent.change(participants[0], { target: { value: "p-1" } });
    const workers = screen.getAllByLabelText("Worker");
    fireEvent.change(workers[0], { target: { value: "m-worker-1" } });
    fireEvent.change(screen.getByLabelText("Reviewed service context"), { target: { value: "ctx-1" } });
    fireEvent.change(screen.getByLabelText("Scheduled start"), { target: { value: "2026-09-01T09:00" } });
    fireEvent.change(screen.getByLabelText("Scheduled end"), { target: { value: "2026-09-01T10:00" } });
  });
}

async function clickTab(name: "Roster" | "Readiness" | "Access" | "Audit" | "Overview" | "Participants"): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("mounted AdminWorkspace — normal success preserves form and triggers refresh", () => {
  it("retries a rejected/uncertain shift with the exact same arguments and command ID, then refreshes on duplicate", async () => {
    rpcMock.mockRejectedValueOnce(new Error("response lost after commit"));
    mockRpcSequence([{
      status: "duplicate_returned",
      duplicate: true,
      receipt_id: "r-1",
      outcome: { shift_id: "shift-1", warnings: [] },
    }]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Roster");
    await fillCreateShift();
    await submitShiftForm();

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledTimes(1);
    });
    const firstCall = rpcMock.mock.calls[0] as unknown[];
    const firstArgs = firstCall[1] as Record<string, unknown>;
    expect(firstArgs.p_command_id).toBeDefined();
    const firstCommandId = firstArgs.p_command_id as string;
    expect(firstArgs.p_participant_id).toBe("p-1");
    expect(firstArgs.p_worker_membership).toBe("m-worker-1");

    await waitFor(() => expect(screen.getByText(/Could not save: response lost after commit/i)).toBeInTheDocument());

    // Submit again without changing anything — same form values,
    // same command ID. The server replies duplicate_returned and the
    // UI normalizes it back to the accepted shape.
    await submitShiftForm();

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    const secondCall = rpcMock.mock.calls[1] as unknown[];
    const secondArgs = secondCall[1] as Record<string, unknown>;
    expect(secondArgs.p_command_id).toBe(firstCommandId);
    expect(secondArgs.p_participant_id).toBe("p-1");
    expect(secondArgs.p_worker_membership).toBe("m-worker-1");
    expect(secondArgs.p_scheduled_start).toBe(firstArgs.p_scheduled_start);
    expect(secondArgs.p_scheduled_end).toBe(firstArgs.p_scheduled_end);

    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
  });
});

describe("mounted AdminWorkspace — duplicate warning outcome keeps the alert bound to the same result", () => {
  it("renders the warnings on first success and again on duplicate retry, bound to the same shift_id", async () => {
    mockRpcSequence([
      { status: "accepted", receipt_id: "r-2", shift_id: "shift-99", warnings: ["worker_overlap", "outside_published_availability"] },
      {
        status: "duplicate_returned",
        duplicate: true,
        receipt_id: "r-2",
        outcome: { shift_id: "shift-99", warnings: ["worker_overlap", "outside_published_availability"] },
      },
    ]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Roster");
    await fillCreateShift();
    await submitShiftForm();

    await waitFor(() => {
      expect(screen.getByText(/Roster warnings require review/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/worker has another overlapping assignment/i)).toBeInTheDocument();
    expect(screen.getByText(/outside the worker’s published availability/i)).toBeInTheDocument();

    // Transport-uncertain retry: duplicate_returned with the same
    // shift_id + warnings. The warning alert stays bound to the same
    // shift_id.
    await submitShiftForm();

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByText(/Roster warnings require review/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Tied to shift result/)).toBeInTheDocument();
  });

  it("mints a fresh command ID only after every warning is acknowledged", async () => {
    mockRpcSequence([
      { status: "accepted", receipt_id: "r-3", shift_id: "shift-ack", warnings: ["worker_overlap"] },
    ]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Roster");
    await fillCreateShift();
    await submitShiftForm();

    await waitFor(() => {
      expect(screen.getByText(/Roster warnings require review/i)).toBeInTheDocument();
    });
    const beforeAck = (rpcMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    const beforeCommandId = beforeAck.p_command_id as string;

    // Acknowledge the warning → the command ID rotates.
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      fireEvent.click(checkbox);
    });

    // Wait for the first submit to complete (button re-enabled)
    // before clicking again. Without this the second click races
    // the first submit's pending → errored transition and is dropped
    // by the per-form lock.
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /^Create shift$/ }) as HTMLButtonElement).disabled).toBe(false);
    });
    // Submit a new shift with the same form values: command ID must
    // have rotated because every warning has been acknowledged.
    mockRpcSequence([
      { status: "accepted", receipt_id: "r-3-new", shift_id: "shift-ack-2", warnings: [] },
    ]);
    await submitShiftForm();
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    const afterAck = (rpcMock.mock.calls[1] as unknown[])[1] as Record<string, unknown>;
    expect(afterAck.p_command_id).not.toBe(beforeCommandId);
    expect(afterAck.p_command_id).toBeDefined();
  });
});

describe("mounted AdminWorkspace — invitation duplicate retry preserves the actor-bound copy link", () => {
  it("recovers the same single-use token on a duplicate_returned outcome without exposing it before submit", async () => {
    mockRpcSequence([
      { status: "accepted", receipt_id: "r-invite", invitation_id: "inv-1", token: "tok-1", role: "worker", email: "w@y.test" },
      {
        status: "duplicate_returned",
        duplicate: true,
        receipt_id: "r-invite",
        outcome: { invitation_id: "inv-1", token: "tok-1", role: "worker", email: "w@y.test" },
      },
    ]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Access");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "w@y.test" } });
    });
    await clickByText(/^Issue invitation$/);

    await waitFor(() => {
      expect(screen.getByText(/Invitation created/i)).toBeInTheDocument();
    });
    expect(clipboardMock).toHaveBeenCalledWith(expect.stringContaining("/invite/tok-1"));

    // Resubmit without changing the email — server returns the same
    // token in the duplicate outcome.
    await clickByText(/^Issue invitation$/);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    expect(clipboardMock).toHaveBeenCalledTimes(2);
    expect(clipboardMock.mock.calls[1][0]).toContain("/invite/tok-1");
  });

  it("renders a selectable URL when the Clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true, writable: true });
    mockRpcSequence([{ status: "accepted", receipt_id: "r-invite-missing", invitation_id: "inv-missing", token: "tok-missing", role: "worker", email: "missing@y.test" }]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Access");
    await act(async () => fireEvent.change(screen.getByLabelText("Email"), { target: { value: "missing@y.test" } }));
    await clickByText(/^Issue invitation$/);
    await waitFor(() => expect((screen.getByLabelText("Selectable invitation URL") as HTMLInputElement).value).toContain("/invite/tok-missing"));
  });

  it("renders a selectable URL when clipboard permission is rejected", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true, writable: true });
    mockRpcSequence([{ status: "accepted", receipt_id: "r-invite-denied", invitation_id: "inv-denied", token: "tok-denied", role: "worker", email: "denied@y.test" }]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Access");
    await act(async () => fireEvent.change(screen.getByLabelText("Email"), { target: { value: "denied@y.test" } }));
    await clickByText(/^Issue invitation$/);
    await waitFor(() => expect((screen.getByLabelText("Selectable invitation URL") as HTMLInputElement).value).toContain("/invite/tok-denied"));
  });

  it("clears the previous fallback when a genuinely new invite fails", async () => {
    mockRpcSequence([{ status: "accepted", receipt_id: "r-first", invitation_id: "inv-first", token: "tok-first", role: "worker", email: "first@y.test" }]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Access");
    const email = screen.getByLabelText("Email");
    await act(async () => fireEvent.change(email, { target: { value: "first@y.test" } }));
    await clickByText(/^Issue invitation$/);
    await waitFor(() => expect((screen.getByLabelText("Selectable invitation URL") as HTMLInputElement).value).toContain("tok-first"));

    rpcMock.mockRejectedValueOnce(new Error("second invite failed"));
    await act(async () => fireEvent.change(email, { target: { value: "second@y.test" } }));
    await clickByText(/^Issue invitation$/);
    await waitFor(() => expect(screen.getByText(/Could not save: second invite failed/i)).toBeInTheDocument());
    expect(screen.queryByLabelText("Selectable invitation URL")).not.toBeInTheDocument();
  });
});

describe("mounted AdminWorkspace — duplicate warning is terminal and acknowledgement rotates", () => {
  it("retries reject→duplicate, acknowledges the duplicate warning, then submits a fresh intent", async () => {
    rpcMock.mockRejectedValueOnce(new Error("response lost"));
    mockRpcSequence([
      { status: "duplicate_returned", duplicate: true, receipt_id: "r-dup", outcome: { shift_id: "shift-dup", warnings: ["worker_overlap"] } },
      { status: "accepted", receipt_id: "r-new", shift_id: "shift-new", warnings: [] },
    ]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Roster");
    await fillCreateShift();
    await submitShiftForm();
    const firstId = ((rpcMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>).p_command_id;
    await waitFor(() => expect(screen.getByText(/Could not save: response lost/i)).toBeInTheDocument());
    await submitShiftForm();
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Roster warnings require review/i)).toBeInTheDocument());
    const retryId = ((rpcMock.mock.calls[1] as unknown[])[1] as Record<string, unknown>).p_command_id;
    expect(retryId).toBe(firstId);
    await act(async () => fireEvent.click(screen.getByRole("checkbox")));
    await waitFor(() => expect((screen.getByRole("button", { name: /^Create shift$/ }) as HTMLButtonElement).disabled).toBe(false));
    await submitShiftForm();
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(3));
    const newId = ((rpcMock.mock.calls[2] as unknown[])[1] as Record<string, unknown>).p_command_id;
    expect(newId).not.toBe(firstId);
  });
});

describe("mounted AdminWorkspace — per-form pending lets unrelated forms stay usable", () => {
  it("disables only the submitting form while the others remain interactive", async () => {
    let resolveShift: (value: unknown) => void = () => {};
    rpcMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveShift = resolve;
        }),
    );
    rpcMock.mockResolvedValueOnce({ data: { status: "accepted", receipt_id: "r-4" }, error: null });

    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Roster");
    await fillCreateShift();
    // Click Create shift without resolving the mock yet.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create shift/ }));
    });

    const createShiftButton = screen.getByRole("button", { name: /Create shift/ }) as HTMLButtonElement;
    expect(createShiftButton.disabled).toBe(true);
    expect(createShiftButton.getAttribute("aria-busy")).toBe("true");

    // The "Publish availability" form is in a different form on the
    // same tab and must remain interactive.
    const publishAvailability = screen.getByRole("button", { name: /Publish availability/ }) as HTMLButtonElement;
    expect(publishAvailability.disabled).toBe(false);

    // Resolve the in-flight call.
    await act(async () => {
      resolveShift({ data: { status: "accepted", receipt_id: "r-4", shift_id: "shift-pending", warnings: [] }, error: null });
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /Create shift/ }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("surfaces the form-level error message after a failed call and clears it after a successful retry", async () => {
    mockRpcError("network down");
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Roster");
    await fillCreateShift();
    await submitShiftForm();

    await waitFor(() => {
      expect(screen.getByText(/Could not save: network down/i)).toBeInTheDocument();
    });

    mockRpcSequence([
      { status: "accepted", receipt_id: "r-5", shift_id: "shift-1", warnings: [] },
    ]);
    await submitShiftForm();

    await waitFor(() => {
      expect(screen.queryByText(/Could not save: network down/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Saved and added to the audit timeline/i)).toBeInTheDocument();
  });
});

describe("mounted AdminWorkspace — consent record vs renew routes by current-leaf presence", () => {
  it("disables the record form when a current consent exists and enables the renew form with expected_current_consent_id", async () => {
    const dataWithCurrent = {
      ...initialData,
      consents: [
        {
          id: "cons-current",
          participant_id: "p-1",
          recipient_profile_id: "ext-1",
          authorising_profile_id: "p-1",
          consent_basis: "participant",
          purpose: "v1",
          scope_categories: ["service_summary"],
          evidence_reference: "e1",
          effective_from: "2026-08-01T00:00:00Z",
          effective_until: "2026-12-01T00:00:00Z",
          status: "active",
          representative_authority_id: null,
          version: 1,
          superseded_by: null,
        },
      ],
    };
    rpcMock.mockResolvedValue({ data: { status: "accepted", receipt_id: "r-6", consent_id: "cons-new", version: 2 }, error: null });
    render(<AdminWorkspace organisation={organisation} initialData={dataWithCurrent} />);
    await clickTab("Access");
    await act(async () => {
      // The Access tab has two consent forms (record + renew). Use
      // scoped indices so we drive the right one.
      const participants = screen.getAllByLabelText("Participant");
      fireEvent.change(participants[0], { target: { value: "p-1" } });
      const recipients = screen.getAllByLabelText("External recipient");
      fireEvent.change(recipients[0], { target: { value: "ext-1" } });
    });
    const recordButton = screen.getByRole("button", { name: /Switch to renew below/ }) as HTMLButtonElement;
    expect(recordButton.disabled).toBe(true);
    expect(screen.getByText(/A current consent already exists for this pair/i)).toBeInTheDocument();

    // Use the renew form: it must submit cmd_admin_renew_consent
    // with expected_current_consent_id = cons-current.
    await act(async () => {
      const participants = screen.getAllByLabelText("Participant");
      fireEvent.change(participants[1], { target: { value: "p-1" } });
      const recipients = screen.getAllByLabelText("External recipient");
      fireEvent.change(recipients[1], { target: { value: "ext-1" } });
      const renewSelect = screen.getByLabelText(/Current consent \(expected leaf\)/) as HTMLSelectElement;
      fireEvent.change(renewSelect, { target: { value: "cons-current" } });
      fireEvent.change(screen.getByLabelText("Updated purpose"), { target: { value: "v2" } });
      fireEvent.change(screen.getByLabelText("Updated scope categories"), { target: { value: "service_summary" } });
      fireEvent.change(screen.getByLabelText("Updated evidence reference"), { target: { value: "e2" } });
    });
    await clickByRole("button", /^Renew consent evidence$/);

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalled();
    });
    const renewCall = rpcMock.mock.calls.find(
      (call) => (call[0] as string) === "cmd_admin_renew_consent",
    ) as unknown[];
    const renewArgs = renewCall[1] as Record<string, unknown>;
    expect(renewArgs.p_consent_id).toBe("cons-current");
    expect(renewArgs.p_expected_current_consent_id).toBe("cons-current");
  });

  it("records representative consent with the selected current authority, then creates a grant from that consent", async () => {
    const authority = {
      id: "authority-1",
      participant_id: "p-1",
      representative_profile_id: "rep-1",
      authority_type: "plan_nominee",
      scope_categories: ["service_summary"],
      evidence_reference: "authority-evidence",
      effective_from: "2026-08-01T00:00:00Z",
      effective_until: "2026-12-01T00:00:00Z",
      status: "active",
    };
    const withAuthority = { ...initialData, authorities: [authority] };
    rpcMock.mockResolvedValueOnce({ data: { status: "accepted", receipt_id: "r-consent", consent_id: "cons-rep", version: 1 }, error: null });
    const rendered = render(<AdminWorkspace organisation={organisation} initialData={withAuthority} />);
    await clickTab("Access");
    await act(async () => {
      const participants = screen.getAllByLabelText("Participant");
      fireEvent.change(participants[0], { target: { value: "p-1" } });
      const recipients = screen.getAllByLabelText("External recipient");
      fireEvent.change(recipients[0], { target: { value: "ext-1" } });
      fireEvent.change(screen.getByLabelText("Consent basis"), { target: { value: "authorised_representative" } });
      fireEvent.change(screen.getByLabelText("Representative authority"), { target: { value: "authority-1" } });
      fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "coordinate" } });
      fireEvent.change(screen.getAllByLabelText("Scope categories")[0], { target: { value: "service_summary" } });
      fireEvent.change(screen.getAllByLabelText("Evidence reference")[0], { target: { value: "consent-rep-evidence" } });
    });
    await clickByRole("button", /^Record consent evidence$/);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    const consentArgs = rpcMock.mock.calls[0][1] as Record<string, unknown>;
    expect(consentArgs.p_consent_basis).toBe("authorised_representative");
    expect(consentArgs.p_representative_authority_id).toBe("authority-1");
    expect(consentArgs.p_authorising_profile_id).toBe("rep-1");

    const withConsent = {
      ...withAuthority,
      consents: [{
        id: "cons-rep", participant_id: "p-1", recipient_profile_id: "ext-1",
        authorising_profile_id: "rep-1", consent_basis: "authorised_representative",
        purpose: "coordinate", scope_categories: ["service_summary"], evidence_reference: "consent-rep-evidence",
        effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-12-01T00:00:00Z",
        status: "active", representative_authority_id: "authority-1", version: 1, superseded_by: null,
      }],
    };
    rpcMock.mockResolvedValueOnce({ data: { status: "accepted", receipt_id: "r-grant", grant_id: "grant-rep" }, error: null });
    rendered.rerender(<AdminWorkspace organisation={organisation} initialData={withConsent} />);
    const grantSelect = screen.getByLabelText("Consent evidence") as HTMLSelectElement;
    await act(async () => fireEvent.change(grantSelect, { target: { value: "cons-rep" } }));
    await clickByRole("button", /^Create view-only grant$/);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    const grantArgs = rpcMock.mock.calls[1][1] as Record<string, unknown>;
    expect(grantArgs.p_consent_id).toBe("cons-rep");
  });

  it("reuses exact consent timestamps after reject→duplicate when visible intent is unchanged", async () => {
    rpcMock.mockRejectedValueOnce(new Error("consent response lost"));
    mockRpcSequence([{ status: "duplicate_returned", duplicate: true, receipt_id: "r-consent-retry", outcome: { consent_id: "cons-retry" } }]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Access");
    await act(async () => {
      const participants = screen.getAllByLabelText("Participant");
      fireEvent.change(participants[0], { target: { value: "p-1" } });
      fireEvent.change(screen.getAllByLabelText("External recipient")[0], { target: { value: "ext-1" } });
      fireEvent.change(screen.getByLabelText("Consent basis"), { target: { value: "participant" } });
      fireEvent.change(screen.getByLabelText("Participant authoriser"), { target: { value: "participant-1" } });
      fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "consent retry" } });
      fireEvent.change(screen.getAllByLabelText("Scope categories")[0], { target: { value: "service_summary" } });
      fireEvent.change(screen.getAllByLabelText("Evidence reference")[0], { target: { value: "consent-retry-evidence" } });
    });
    await clickByRole("button", /^Record consent evidence$/);
    await waitFor(() => expect(screen.getByText(/Could not save: consent response lost/i)).toBeInTheDocument());
    const first = rpcMock.mock.calls[0][1] as Record<string, unknown>;
    await clickByRole("button", /^Record consent evidence$/);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    const retry = rpcMock.mock.calls[1][1] as Record<string, unknown>;
    expect(retry.p_command_id).toBe(first.p_command_id);
    expect(retry.p_effective_from).toBe(first.p_effective_from);
    expect(retry.p_effective_until).toBe(first.p_effective_until);
  });

  it("reuses exact grant timestamps after a thrown RPC and duplicate response", async () => {
    const dataWithConsent = {
      ...initialData,
      consents: [{ id: "cons-grant-retry", participant_id: "p-1", recipient_profile_id: "ext-1", purpose: "grant retry", scope_categories: ["service_summary"], status: "active", effective_from: "2026-08-01T00:00:00Z", effective_until: "2026-12-01T00:00:00Z", version: 1, superseded_by: null }],
    };
    rpcMock.mockImplementationOnce(() => { throw new Error("grant response lost"); });
    mockRpcSequence([{ status: "duplicate_returned", duplicate: true, receipt_id: "r-grant-retry", outcome: { grant_id: "grant-retry" } }]);
    render(<AdminWorkspace organisation={organisation} initialData={dataWithConsent} />);
    await clickTab("Access");
    await act(async () => fireEvent.change(screen.getByLabelText("Consent evidence"), { target: { value: "cons-grant-retry" } }));
    await clickByRole("button", /^Create view-only grant$/);
    await waitFor(() => expect(screen.getByText(/Could not save: grant response lost/i)).toBeInTheDocument());
    const first = rpcMock.mock.calls[0][1] as Record<string, unknown>;
    await clickByRole("button", /^Create view-only grant$/);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    const retry = rpcMock.mock.calls[1][1] as Record<string, unknown>;
    expect(retry.p_command_id).toBe(first.p_command_id);
    expect(retry.p_effective_from).toBe(first.p_effective_from);
    expect(retry.p_effective_until).toBe(first.p_effective_until);
  });

  it("reuses exact authority timestamps after reject→duplicate when visible intent is unchanged", async () => {
    rpcMock.mockRejectedValueOnce(new Error("authority response lost"));
    mockRpcSequence([{ status: "duplicate_returned", duplicate: true, receipt_id: "r-authority-retry", outcome: { authority_id: "authority-retry" } }]);
    render(<AdminWorkspace organisation={organisation} initialData={initialData} />);
    await clickTab("Access");
    await act(async () => {
      const participants = screen.getAllByLabelText("Participant");
      fireEvent.change(participants.at(-1) as HTMLElement, { target: { value: "p-1" } });
      fireEvent.change(screen.getByLabelText("Representative account"), { target: { value: "rep-1" } });
      fireEvent.change(screen.getByLabelText("Authority type"), { target: { value: "plan_nominee" } });
      fireEvent.change(screen.getAllByLabelText("Scope categories").at(-1) as HTMLElement, { target: { value: "service_summary" } });
      fireEvent.change(screen.getAllByLabelText("Evidence reference").at(-1) as HTMLElement, { target: { value: "authority-retry-evidence" } });
    });
    await clickByRole("button", /^Record representative authority$/);
    await waitFor(() => expect(screen.getByText(/Could not save: authority response lost/i)).toBeInTheDocument());
    const first = rpcMock.mock.calls[0][1] as Record<string, unknown>;
    await clickByRole("button", /^Record representative authority$/);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
    const retry = rpcMock.mock.calls[1][1] as Record<string, unknown>;
    expect(retry.p_command_id).toBe(first.p_command_id);
    expect(retry.p_effective_from).toBe(first.p_effective_from);
    expect(retry.p_effective_until).toBe(first.p_effective_until);
  });

  it("offers participant authorisers only from active self-links for the selected participant", async () => {
    const scopedData = {
      ...initialData,
      participants: [
        ...initialData.participants,
        { id: "p-2", first_name: "Other", last_initial: "Q", created_at: "2026-08-01T00:00:00Z" },
      ],
      identities: [
        ...initialData.identities,
        { profile_id: "participant-2", full_name: "Other Account", email: "other@example.test", role: "participant" },
      ],
      selfLinks: [
        { participant_id: "p-1", profile_id: "participant-1", status: "active" },
        { participant_id: "p-2", profile_id: "participant-2", status: "active" },
      ],
    };
    render(<AdminWorkspace organisation={organisation} initialData={scopedData} />);
    await clickTab("Access");
    await act(async () => {
      fireEvent.change(screen.getAllByLabelText("Participant")[0], { target: { value: "p-1" } });
    });
    const authoriser = screen.getByLabelText("Participant authoriser");
    expect(within(authoriser).getByRole("option", { name: "Maya Account" })).toBeInTheDocument();
    expect(within(authoriser).queryByRole("option", { name: "Other Account" })).not.toBeInTheDocument();
  });
});
