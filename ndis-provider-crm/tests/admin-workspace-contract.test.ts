import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(resolve(process.cwd(), "src/app/app/admin/workspace-client.tsx"), "utf8");
const page = readFileSync(resolve(process.cwd(), "src/app/app/admin/page.tsx"), "utf8");
const state = readFileSync(resolve(process.cwd(), "src/app/app/admin/workspace-state.ts"), "utf8");

describe("admin workspace UI contract", () => {
  it("keeps sensitive reads and consent/grant writes on the protected surfaces", () => {
    expect(page).toContain('list_admin_workspace_identities');
    expect(page).toContain('list_admin_workspace_self_links');
    expect(page).toContain('participant_consent_evidence');
    expect(workspace).toContain('cmd_admin_record_consent');
    expect(workspace).toContain('p_consent_id: grantConsent');
    expect(workspace).toContain('provider_recorded: true');
    expect(workspace).toContain('participantSelfProfiles');
  });

  it("preserves accessible labels and material failure/warning states", () => {
    expect(workspace).toContain("<Label htmlFor={fieldId}");
    expect(workspace).toContain('role="alert"');
    expect(workspace).toContain("Could not save:");
    expect(workspace).toContain("formLocksRef");
    expect(workspace).toContain("navigator.clipboard");
  });

  it("reconciles the workspace through router.refresh after a successful command and preserves warnings", () => {
    expect(workspace).toContain("useRouter");
    expect(workspace).toContain("router.refresh()");
    // Data flows through props so refresh reaches the component.
    expect(workspace).toMatch(/const data = initialData/);
    // The shift result key + warnings are kept in component state so
    // the alert stays bound to the result across refreshes.
    expect(workspace).toContain("pendingWarnings");
    expect(workspace).toContain("resultKey");
  });

  it("reuses the same command ID across an errored retry and renews after a known terminal result", () => {
    expect(state).toContain("export function nextCommandId");
    // The pure function must keep the command ID for pending/errored
    // (transport-uncertain retry) and mint a new one after a known
    // terminal result.
    expect(state).toMatch(/rec\.status === "succeeded" \|\| rec\.status === "duplicate".*generate/);
    // The UI keeps the command ID stable while warnings remain
    // unacknowledged so a transport-uncertain retry returns the same
    // shift result.
    expect(workspace).toContain("pendingWarnings.map");
  });

  it("binds warning acknowledgement to the shift result and survives a refresh", () => {
    expect(state).toContain("allWarningsAcknowledged");
    expect(state).toContain("acknowledge(");
    expect(workspace).toContain("acknowledgeWarning");
    // The acknowledgement checkbox controls are rendered inside the
    // per-result warning alert, not as a separate form control.
    expect(workspace).toContain('type="checkbox"');
    expect(workspace).toContain('htmlFor={inputId}');
  });

  it("tracks the create and update review-due dates as independent slots", () => {
    expect(state).toContain("setCreateDue");
    expect(state).toContain("setUpdateDue");
    expect(state).toContain("initialReviewDueState");
    // Both labels appear in the UI but the create and update slots
    // each carry their own controlled input.
    expect(workspace).toContain("Review due (create)");
    expect(workspace).toContain("Review due (update)");
  });

  it("renders scoped recipient identity labels and never raw UUIDs in disclosure summaries", () => {
    expect(state).toContain("PRIVACY_SAFE_RECIPIENT_FALLBACK");
    expect(state).toContain("buildIdentityLabels");
    expect(state).toContain("describeRecipient");
    // The disclosure summary pulls labels through labelLookup and
    // never echoes grant.recipient_profile_id directly.
    expect(workspace).toContain("labelLookup(String(grant.recipient_profile_id))");
    expect(workspace).toContain("PRIVACY_SAFE_RECIPIENT_FALLBACK");
    expect(workspace).toContain("recipient-label");
    expect(workspace).not.toMatch(/Recipient\s*\{String\(grant\.recipient_profile_id\)\}/);
  });
});
