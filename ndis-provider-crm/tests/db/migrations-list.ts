/**
 * Tests run against an isolated pglite instance. This file lists every
 * migration SQL file in apply order. The parser check in
 * scripts/parse-migrations.mjs uses the same list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests/db/migrations-list.ts → repo root is ../../ (relative to tests/db)
const REPO_ROOT = path.resolve(HERE, "..", "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const MIGRATION_NAMES = [
  "0001_init_organisations_and_profiles.sql",
  "0002_auth_and_invitations.sql",
  "0003_forward_identity.sql",
  "0004_v1_domain_tables.sql",
  "0005_sensitive_command_rpcs.sql",
  "0006_access_matrix_rls.sql",
  "0007_synthetic_seed_rpc.sql",
  "0008_admin_workspace_rpcs.sql",
  "0009_provider_readiness_service_evidence.sql",
  "20260811000001_admin_repeat_review_db_fixup.sql",
  "20260811000002_admin_final_security_lineage_fixup.sql",
  "20260813000001_provider_readiness_ordering_fix.sql",
  "20260813000002_worker_urgent_handoff_and_worker_flow.sql",
  "20260813000003_ticket06_first_pass_review_fixup.sql",
];

const diskMigrationNames = fs.readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (JSON.stringify(MIGRATION_NAMES) !== JSON.stringify(diskMigrationNames)) {
  throw new Error("Migration test order must exactly match Supabase's lexicographic apply order.");
}

export default MIGRATION_NAMES.map((name) =>
  path.join(MIGRATIONS_DIR, name),
);
