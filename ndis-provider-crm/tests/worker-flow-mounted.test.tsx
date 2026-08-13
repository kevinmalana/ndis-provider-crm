/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const routerMock = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

const rpcMock = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createSupabaseBrowserClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
  }),
}));

import { WorkerShiftDetailClient } from "@/app/worker/shift-detail-client";

const openMock = vi.fn(() => ({}));

beforeEach(() => {
  rpcMock.mockReset();
  routerMock.refresh.mockReset();
  vi.stubGlobal("open", openMock);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseDetail = {
  shift: {
    id: "shift-1",
    state: "ended_summary_required",
    version: 3,
    scheduled_start: "2026-08-12T09:00:00Z",
    scheduled_end: "2026-08-12T10:00:00Z",
  },
  participant: {
    first_name: "Maya",
    last_initial: "R",
    location_hint: "Fairfield",
    full_address: "12 Acacia St, Fairfield NSW 2165",
    access_instructions: "Ring the side gate.",
  },
  criticalCard: {
    content_text: "Monitor fatigue.",
    reviewed_at: "2026-08-10T00:00:00Z",
    review_due_at: "2026-09-10T00:00:00Z",
  },
  snapshot: {
    item_code: "TIME-1",
    item_name: "Individual time support",
    support_category: "daily_living",
    service_kind: "individual_time",
    time_unit: "hour",
    goal_reference: "GOAL-1",
    goal_display: "Community participation",
  },
  summary: null,
  currentSummaryVersion: null,
  handoffRoutes: [
    {
      route_version_id: "route-emergency",
      route_type: "emergency",
      owner_role_label: "On-call manager",
      guidance_text: "Call the provider emergency line after immediate danger is addressed.",
      primary_label: "Call emergency coordinator",
      primary_contact_uri: "tel:+61255501000",
      fallback_phone: "02 5550 1099",
    },
    {
      route_version_id: "route-incident",
      route_type: "incident",
      owner_role_label: "Incident lead",
      guidance_text: "Open the incident guide for urgent provider escalation.",
      primary_label: "Open incident guide",
      primary_contact_uri: "https://example.test/incident",
      fallback_phone: "02 5550 1088",
    },
  ],
  handoffReceipts: [],
  commandReceipts: [
    {
      command_type: "start_shift",
      status: "accepted",
      claimed_at: "2026-08-12T09:02:00Z",
      server_received_at: "2026-08-12T09:02:05Z",
      outcome: {},
    },
    {
      command_type: "end_shift",
      status: "accepted",
      claimed_at: "2026-08-12T10:01:31Z",
      server_received_at: "2026-08-12T09:58:05Z",
      outcome: {},
    },
  ],
  acknowledgement: null,
};

describe("WorkerShiftDetailClient", () => {
  it("submits the participant-readable summary with the immutable activity and audience contract", async () => {
    rpcMock.mockResolvedValueOnce({
      data: { status: "accepted", new_state: "finalised", version: 4 },
      error: null,
    });

    render(<WorkerShiftDetailClient detail={baseDetail} />);

    fireEvent.change(screen.getByLabelText("Plain-English summary"), {
      target: { value: "Supported Maya with community access and documented the outcome clearly." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit summary" }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][0]).toBe("cmd_submit_summary");
    expect(rpcMock.mock.calls[0][1]).toMatchObject({
      p_shift_id: "shift-1",
      p_expected_version: 3,
      p_activities: ["Individual time support"],
      p_audience: ["participant", "service_summary"],
    });
    expect(routerMock.refresh).toHaveBeenCalled();
  });

  it("records urgent handoff initiation before opening the provider route", async () => {
    rpcMock.mockResolvedValueOnce({
      data: { status: "accepted", route_type: "incident", event_type: "initiated" },
      error: null,
    });

    render(<WorkerShiftDetailClient detail={{ ...baseDetail, shift: { ...baseDetail.shift, state: "scheduled", version: 1 } }} />);

    fireEvent.click(screen.getByRole("button", { name: "Open primary route" }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock.mock.calls[0][0]).toBe("cmd_worker_record_handoff");
    expect(rpcMock.mock.calls[0][1]).toMatchObject({
      p_shift_id: "shift-1",
      p_route_version_id: "route-incident",
      p_event_type: "initiated",
      p_selected_channel: "primary",
    });
    expect(openMock).toHaveBeenCalledWith(
      "https://example.test/incident",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("fails closed when current emergency and incident routes are not both present", () => {
    render(
      <WorkerShiftDetailClient
        detail={{
          ...baseDetail,
          handoffRoutes: [
            {
              route_version_id: "route-emergency",
              route_type: "emergency",
              owner_role_label: "On-call manager",
              guidance_text: "Call the provider emergency line after immediate danger is addressed.",
              primary_label: "Call emergency coordinator",
              primary_contact_uri: "tel:+61255501000",
              fallback_phone: "02 5550 1099",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText(/Current emergency and incident provider routes are required before delivery actions can continue/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit summary" })).not.toBeInTheDocument();
  });

  it("shows the exact accepted elapsed duration without minute rounding", () => {
    render(<WorkerShiftDetailClient detail={baseDetail} />);

    expect(screen.getByText(/exact elapsed 59m 31s/i)).toBeInTheDocument();
  });

  it("keeps recovery actions available during urgent provider review", () => {
    const { rerender } = render(
      <WorkerShiftDetailClient
        detail={{
          ...baseDetail,
          shift: { ...baseDetail.shift, state: "urgent_provider_review", version: 4 },
          commandReceipts: [
            {
              command_type: "start_shift",
              status: "accepted",
              claimed_at: "2026-08-12T09:02:00Z",
              server_received_at: "2026-08-12T09:02:05Z",
              outcome: {},
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "End shift" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit summary" })).not.toBeInTheDocument();

    rerender(
      <WorkerShiftDetailClient
        detail={{
          ...baseDetail,
          shift: { ...baseDetail.shift, state: "urgent_provider_review", version: 5 },
          commandReceipts: [
            {
              command_type: "start_shift",
              status: "accepted",
              claimed_at: "2026-08-12T09:02:00Z",
              server_received_at: "2026-08-12T09:02:05Z",
              outcome: {},
            },
            {
              command_type: "end_shift",
              status: "accepted",
              claimed_at: "2026-08-12T10:01:31Z",
              server_received_at: "2026-08-12T10:01:35Z",
              outcome: { new_state: "urgent_provider_review" },
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "End shift" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit summary" })).toBeInTheDocument();
  });
});
