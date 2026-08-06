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
];

export default MIGRATION_NAMES.map((name) =>
  path.join(MIGRATIONS_DIR, name),
);
