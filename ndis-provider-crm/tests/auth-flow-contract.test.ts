import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("magic-link authentication contract", () => {
  it("exchanges PKCE codes in a route handler so session cookies persist", () => {
    const callback = read("src/app/auth/callback/route.ts");
    expect(callback).toContain("exchangeCodeForSession(code)");
    expect(callback).toContain('url.searchParams.get("code")');
    expect(fs.existsSync(path.join(root, "src/app/auth/callback/page.tsx"))).toBe(
      false,
    );
  });

  it("accepts invitations only after the callback establishes a session", () => {
    const confirm = read("src/app/invite/[token]/confirm/route.ts");
    const callback = read("src/app/auth/callback/route.ts");
    expect(confirm).toContain('callbackUrl.searchParams.set("invitation", token)');
    expect(callback).toContain('"cmd_accept_invitation"');
    expect(callback).toContain("{ p_token: invitationToken }");
  });

  it("does not create unknown accounts from the ordinary sign-in form", () => {
    const signIn = read("src/app/sign-in/sign-in-form.tsx");
    expect(signIn).toContain("shouldCreateUser: false");
    expect(signIn).toContain("/auth/callback?next=/app");
  });

  it("rejects protocol-relative post-auth redirects", () => {
    const callback = read("src/app/auth/callback/route.ts");
    expect(callback).toContain('value.startsWith("//")');
  });
});
