/**
 * Tests run against an isolated pglite instance. This file lists every
 * migration SQL file in apply order. The parser check in
 * scripts/parse-migrations.mjs uses the same list.
 */
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
  "0008b_admin_repeat_review_db_fixup.sql",
  "0008c_admin_final_security_lineage_fixup.sql",
];

export default MIGRATION_NAMES.map((name) =>
  path.join(MIGRATIONS_DIR, name),
);
