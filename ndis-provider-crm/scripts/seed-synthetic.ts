/**
 * Deterministic, synthetic-only development seed.
 *
 * All writes happen in the single `seed_synthetic_demo` SECURITY DEFINER RPC,
 * so PostgreSQL rolls back the complete seed if any row fails. The script is
 * deliberately only a guard + lookup + RPC call; it has no raw table writes.
 */
import { createClient } from "@supabase/supabase-js";

import { requiredEnv } from "./lib/env-required";

async function main(): Promise<void> {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (process.env.SUPABASE_SYNTHETIC_SEED !== "true") {
    throw new Error(
      "Synthetic seed refused: set SUPABASE_SYNTHETIC_SEED=true in the development environment.",
    );
  }
  if (!/localhost|127\.0\.0\.1/.test(url) && process.env.SUPABASE_PROJECT_ENV !== "development") {
    throw new Error(
      "Synthetic seed refused: SUPABASE_PROJECT_ENV must be development for non-local Supabase URLs.",
    );
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgErr } = await admin
    .from("organisations")
    .select("id")
    .eq("slug", "opendis")
    .is("deleted_at", null)
    .maybeSingle();
  if (orgErr || !org) {
    throw new Error(`Could not find Open NDIS organisation: ${orgErr?.message ?? "missing"}`);
  }

  const { data: memberships, error: memErr } = await admin
    .from("organisation_memberships")
    .select("id, organisation_id, profile_id, role, status")
    .eq("organisation_id", org.id)
    .eq("status", "active")
    .eq("role", "worker")
    .limit(2);
  if (memErr) throw new Error(`Membership lookup failed: ${memErr.message}`);
  if (!memberships || memberships.length !== 1) {
    throw new Error(
      "Synthetic seed requires exactly one active worker membership; create a dedicated .synthetic identity first.",
    );
  }

  const membership = memberships[0];
  const { data: profile, error: profileErr } = await admin
    .from("global_profiles")
    .select("email")
    .eq("id", membership.profile_id)
    .maybeSingle();
  if (profileErr || !profile?.email?.endsWith(".synthetic")) {
    throw new Error("Synthetic seed requires a dedicated .synthetic worker identity.");
  }

  const { data, error } = await admin.rpc("seed_synthetic_demo", {
    p_worker_membership_id: membership.id,
  });
  if (error) throw new Error(`Synthetic seed transaction rolled back: ${error.message}`);
  process.stdout.write(`[seed] ${JSON.stringify(data)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[seed] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
