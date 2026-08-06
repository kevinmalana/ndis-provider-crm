/**
 * Bootstrap the founding tenant.
 *
 * This script is run ONCE on a fresh database to create the platform
 * operator's first tenant ("Open NDIS") and issue the first admin
 * invitation. The invitation URL is printed to stdout and handed to the
 * founding operator out-of-band — never through chat or any artifact.
 *
 * Why this script (not a SQL seed):
 *   * The "Open NDIS" organisation is created by a trusted server-side
 *     action. Putting it in a SQL migration would mean a future
 *     migration diff shows up as if a database author had inserted the
 *     row; here the audit_trail correctly identifies the bootstrap
 *     script as the actor (the script itself does not write to
 *     audit_log because the founding-tenant creation is not a
 *     per-organisation sensitive action; the subsequent invitation
 *     acceptance does).
 *   * It reads env vars (FOUNDING_ADMIN_EMAIL) so the operator's email
 *     is not committed to source.
 *   * It is idempotent on slug: re-running is safe.
 *
 * Required env vars (loaded from .env.local by the npm script via
 * `--env-file=.env-local`):
 *   * NEXT_PUBLIC_SUPABASE_URL
 *   * SUPABASE_SERVICE_ROLE_KEY
 *   * NEXT_PUBLIC_APP_URL
 *   * FOUNDING_ADMIN_EMAIL
 *
 * Optional (with locked-decision defaults):
 *   * FOUNDING_ORG_NAME   — defaults to "Open NDIS"
 *   * FOUNDING_ORG_SLUG   — defaults to "opendis"
 *
 * Usage:
 *   pnpm bootstrap
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    process.stderr.write(
      `[bootstrap] missing required env var: ${name}\n` +
        `[bootstrap] set it in .env.local and re-run.\n`,
    );
    process.exit(1);
  }
  return value;
}

async function main() {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const appUrl = requiredEnv("NEXT_PUBLIC_APP_URL");
  const adminEmail = requiredEnv("FOUNDING_ADMIN_EMAIL");
  const orgName = process.env.FOUNDING_ORG_NAME?.trim() || "Open NDIS";
  const orgSlug = process.env.FOUNDING_ORG_SLUG?.trim() || "opendis";

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Idempotent organisation insert.
  const { data: existing } = await admin
    .from("organisations")
    .select("id, name, slug, deleted_at")
    .eq("slug", orgSlug)
    .maybeSingle();

  let organisationId: string;
  if (existing) {
    if (existing.deleted_at) {
      process.stderr.write(
        `[bootstrap] refusing to proceed: organisation "${orgSlug}" exists but is soft-deleted.\n` +
          `[bootstrap] restore it via the platform admin tooling, or pick a different FOUNDING_ORG_SLUG.\n`,
      );
      process.exit(1);
    }
    if (existing.name !== orgName) {
      process.stderr.write(
        `[bootstrap] refusing to proceed: organisation slug "${orgSlug}" already exists with name "${existing.name}".\n` +
          `[bootstrap] expected "${orgName}" per decision-log/2026-08-06 (Platform operator).\n` +
          `[bootstrap] do NOT silently overwrite; reconcile manually.\n`,
      );
      process.exit(1);
    }
    organisationId = existing.id;
  } else {
    const { data: inserted, error } = await admin
      .from("organisations")
      .insert({ name: orgName, slug: orgSlug })
      .select("id")
      .single();
    if (error || !inserted) {
      process.stderr.write(
        `[bootstrap] failed to insert organisation: ${error?.message ?? "unknown"}\n`,
      );
      process.exit(1);
    }
    organisationId = inserted.id;
  }

  // 2. Generate an admin invitation for the founding admin.
  // Token is 32 bytes URL-safe; expires in 30 days. No issued_by because
  // there is no admin profile yet (this script bootstraps the first one).
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const { data: invitation, error: inviteError } = await admin
    .from("invitations")
    .insert({
      organisation_id: organisationId,
      email: adminEmail,
      role: "admin",
      token,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (inviteError || !invitation) {
    process.stderr.write(
      `[bootstrap] failed to insert invitation: ${inviteError?.message ?? "unknown"}\n`,
    );
    process.exit(1);
  }

  // 3. Print the invitation URL to stdout ONLY.
  // The URL goes to Kevin's terminal and is never pasted back into chat
  // or committed to the repo.
  const inviteUrl = `${appUrl.replace(/\/$/, "")}/invite/${token}`;
  process.stdout.write(`${inviteUrl}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `[bootstrap] unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});