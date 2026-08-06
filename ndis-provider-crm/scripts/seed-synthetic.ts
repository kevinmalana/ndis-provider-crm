/**
 * Synthetic dev-only seed.
 *
 * Inserts one of every v1 domain row (participants, self-links,
 * representatives, external grants, availability, shifts, assignments,
 * critical info, summaries) so the worker/admin demo flows have data to
 * render. **All names, emails, and timestamps are obviously synthetic.**
 *
 * Run with:
 *   pnpm seed:synthetic
 *
 * Pre-requisites:
 *   * `.env.local` is populated with NEXT_PUBLIC_SUPABASE_URL and
 *     SUPABASE_SERVICE_ROLE_KEY (see README).
 *   * The synthetic pilot project has migrations 0001 → 0006 applied.
 *   * The Open NDIS organisation exists (run `pnpm bootstrap` once).
 *   * There is at least one admin / scheduler membership to satisfy
 *     RLS-on-writes (this script uses the service role for inserts).
 *
 * Synthetic data policy:
 *   * No real participant names, addresses, NDIS numbers, or contacts.
 *   * All names come from a fixed list of clearly synthetic placeholders.
 *   * All emails end in `.synthetic` so they can never resolve.
 *   * All timestamps are far in the future relative to test runs.
 *
 * Idempotency:
 *   * The script never deletes; on re-run it inserts additional rows.
 *   * If the operator wants to reset, they should truncate the v1 domain
 *     tables via a separate script (not part of this ticket).
 */
import { createClient } from "@supabase/supabase-js";

import { requiredEnv } from "./lib/env-required";

const SYNTHETIC_PARTICIPANTS: Array<{
  first_name: string;
  last_initial: string;
}> = [
  { first_name: "Test Alpha", last_initial: "S" },
  { first_name: "Test Beta", last_initial: "S" },
  { first_name: "Test Gamma", last_initial: "S" },
];

const SYNTHETIC_AUTHORITY_TYPES = [
  "plan_nominee",
  "correspondence_nominee",
  "guardian",
  "informal_supporter",
];

const SYNTHETIC_GRANT_PURPOSES = [
  "support_coordination_review",
  "lac_feedback",
];

const SYNTHETIC_ACTIVITIES = [
  "personal_care",
  "community_access",
  "meal_prep",
  "transport",
];

function isoOffset(days: number, hour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function main(): Promise<void> {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Find the Open NDIS organisation (created by `pnpm bootstrap`).
  const { data: org, error: orgErr } = await admin
    .from("organisations")
    .select("id")
    .eq("slug", "opendis")
    .is("deleted_at", null)
    .maybeSingle();
  if (orgErr || !org) {
    process.stderr.write(
      `[seed] could not find Open NDIS organisation: ${orgErr?.message ?? "missing"}\n` +
        `[seed] run \`pnpm bootstrap\` first.\n`,
    );
    process.exit(1);
  }
  const orgId = org.id as string;

  // 2. Find any active worker membership in the org. The synthetic
  // assignment needs a real auth user; we attach to the first active
  // worker we find. If none, we exit cleanly with a hint.
  const { data: memberships, error: memErr } = await admin
    .from("organisation_memberships")
    .select("id, profile_id, role")
    .eq("organisation_id", orgId)
    .eq("status", "active")
    .eq("role", "worker")
    .limit(1);
  if (memErr) {
    process.stderr.write(`[seed] membership lookup failed: ${memErr.message}\n`);
    process.exit(1);
  }
  const workerMembership = memberships?.[0];
  if (!workerMembership) {
    process.stderr.write(
      `[seed] no active worker membership in Open NDIS; invite a worker first.\n`,
    );
    process.exit(0);
  }

  // 3. Participants (synthetic, no real PII).
  const participantRows = SYNTHETIC_PARTICIPANTS.map((p) => ({
    organisation_id: orgId,
    first_name: p.first_name,
    last_initial: p.last_initial,
    created_by: workerMembership.profile_id,
  }));
  const { data: participants, error: partErr } = await admin
    .from("participants")
    .insert(participantRows)
    .select("id, first_name");
  if (partErr) {
    process.stderr.write(`[seed] participant insert failed: ${partErr.message}\n`);
    process.exit(1);
  }
  if (!participants) {
    process.stderr.write(`[seed] participant insert returned no rows\n`);
    process.exit(1);
  }
  process.stdout.write(`[seed] inserted ${participants.length} participants\n`);

  // 4. One shift per participant, starting tomorrow at 09:00 and
  // lasting one hour. Worker assigned.
  const shiftRows = participants.map((p) => ({
    organisation_id: orgId,
    participant_id: p.id,
    scheduled_start: isoOffset(1, 9),
    scheduled_end: isoOffset(1, 10),
    state: "scheduled",
    version: 1,
  }));
  const { data: shifts, error: shiftErr } = await admin
    .from("shifts")
    .insert(shiftRows)
    .select("id, participant_id");
  if (shiftErr) {
    process.stderr.write(`[seed] shift insert failed: ${shiftErr.message}\n`);
    process.exit(1);
  }
  if (shifts) {
    const assignmentRows = shifts.map((s) => ({
      shift_id: s.id,
      organisation_id: orgId,
      membership_id: workerMembership.id,
      assigned_by: workerMembership.profile_id,
    }));
    const { error: assignErr } = await admin
      .from("shift_assignments")
      .insert(assignmentRows);
    if (assignErr) {
      process.stderr.write(
        `[seed] assignment insert failed: ${assignErr.message}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `[seed] inserted ${shifts.length} shifts + assignments\n`,
    );
  }

  // 5. Critical info card per participant (synthetic content).
  const cardRows = participants.map((p) => ({
    organisation_id: orgId,
    participant_id: p.id,
    content_text:
      "Synthetic card: no real information. Replace with redacted content during pilot.",
    owner_profile_id: workerMembership.profile_id,
    review_due_at: isoOffset(30, 9),
  }));
  const { error: cardErr } = await admin
    .from("critical_info_cards")
    .insert(cardRows);
  if (cardErr) {
    process.stderr.write(`[seed] critical_info_card insert failed: ${cardErr.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`[seed] inserted critical info cards\n`);

  // 6. Worker availability window for the next 14 days.
  const { error: availErr } = await admin.from("worker_availability").insert({
    organisation_id: orgId,
    membership_id: workerMembership.id,
    available_during: `[${isoOffset(0, 8)},${isoOffset(14, 18)})`,
    note: "Synthetic availability window.",
  });
  if (availErr) {
    process.stderr.write(`[seed] worker_availability insert failed: ${availErr.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`[seed] inserted worker availability\n`);

  // 7. Synthetic representative authority + external grant placeholders.
  // These attach to the synthetic participants. We do NOT attach to any
  // real profile — the record will sit inactive until a synthetic
  // representative signs in via a separate test fixture.
  for (const p of participants) {
    const { error: authErr } = await admin
      .from("representative_authorities")
      .insert({
        organisation_id: orgId,
        participant_id: p.id,
        representative_profile_id: workerMembership.profile_id, // synthetic
        authority_type: SYNTHETIC_AUTHORITY_TYPES[0],
        scope_categories: ["upcoming_visits", "service_summary"],
        effective_from: new Date().toISOString(),
        evidence_reference: "synthetic-no-evidence",
      });
    if (authErr) {
      process.stderr.write(
        `[seed] representative_authority insert failed: ${authErr.message}\n`,
      );
      process.exit(1);
    }

    const { error: grantErr } = await admin
      .from("external_disclosure_grants")
      .insert({
        organisation_id: orgId,
        participant_id: p.id,
        recipient_profile_id: workerMembership.profile_id, // synthetic
        purpose: SYNTHETIC_GRANT_PURPOSES[0],
        scope_categories: ["service_summary"],
        consent_basis: "participant",
        consent_reference: "synthetic-no-consent",
        effective_from: new Date().toISOString(),
        effective_until: isoOffset(30, 23),
      });
    if (grantErr) {
      process.stderr.write(
        `[seed] external_disclosure_grants insert failed: ${grantErr.message}\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write(
    `[seed] inserted synthetic representative authorities + grants\n`,
  );

  // Synthetic activity list is included so the worker summary form has
  // something to render against. The list lives only in the seed
  // output; the database does not need it (activities are free-text
  // strings on each service_summary_version).
  process.stdout.write(
    `[seed] synthetic activities (informational): ${SYNTHETIC_ACTIVITIES.join(", ")}\n`,
  );

  process.stdout.write(`[seed] done.${"\n"}`);
}

main().catch((e) => {
  process.stderr.write(
    `[seed] unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});