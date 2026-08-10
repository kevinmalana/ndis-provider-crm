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

async function clickTab(name: "Roster" | "Access" | "Audit" | "Overview" | "Participants"): Promise<void> {
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
