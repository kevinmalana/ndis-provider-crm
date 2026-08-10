import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(resolve(process.cwd(), "src/app/app/admin/workspace-client.tsx"), "utf8");
const page = readFileSync(resolve(process.cwd(), "src/app/app/admin/page.tsx"), "utf8");

describe("admin workspace UI contract", () => {
  it("keeps sensitive reads and consent/grant writes on the protected surfaces", () => {
    expect(page).toContain('list_admin_workspace_identities');
    expect(page).toContain('participant_consent_evidence');
    expect(workspace).toContain('cmd_admin_record_consent');
    expect(workspace).toContain('p_consent_id: grantConsent');
    expect(workspace).toContain('provider_recorded: true');
  });

  it("preserves accessible labels and material failure/warning states", () => {
    expect(workspace).toContain("<Label htmlFor={fieldId}");
    expect(workspace).toContain('role="alert"');
    expect(workspace).toContain("Could not save:");
    expect(workspace).toContain("pendingRef");
    expect(workspace).toContain("navigator.clipboard");
  });
});
