/**
 * Remote development-only browser validation for the complete synthetic
 * admin/provider-readiness journey.
 *
 * The script deliberately creates an isolated organisation and auth users
 * whose names/emails end in `.synthetic`. It never prints secrets, account
 * identifiers, record identifiers, invitation tokens, or magic-link hashes.
 * Existing organisations are not selected or modified.
 *
 * Required process guards (do not put these in production environments):
 *   RUN_REMOTE_SYNTHETIC_VALIDATION=true
 *   SUPABASE_PROJECT_ENV=development
 *
 * Optional:
 *   SYNTHETIC_VALIDATION_APP_URL=http://localhost:3000
 *   SYNTHETIC_VALIDATION_OUTPUT_DIR=<local screenshot/report directory>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium, type Locator, type Page, type Response } from "playwright";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import { requiredEnv } from "./lib/env-required";

const ORGANISATION_NAME = "Traycer Synthetic Validation";
const ORGANISATION_SLUG = "traycer-validation.synthetic";
const ADMIN_EMAIL = "admin@traycer-validation.synthetic";
const WORKER_A_EMAIL = "worker-a@traycer-validation.synthetic";
const WORKER_B_EMAIL = "worker-b@traycer-validation.synthetic";

type Role = "admin" | "worker";
type PreparedIdentity = { user: User; membershipId: string };

function guardRemoteDevelopment(url: string): void {
  if (process.env.RUN_REMOTE_SYNTHETIC_VALIDATION !== "true") {
    throw new Error("Remote synthetic validation refused: explicit run guard is not enabled.");
  }
  if (process.env.SUPABASE_PROJECT_ENV !== "development") {
    throw new Error("Remote synthetic validation refused: project environment is not development.");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error("Remote synthetic validation refused: Supabase URL is invalid.");
  }
  for (const value of [ORGANISATION_SLUG, ADMIN_EMAIL, WORKER_A_EMAIL, WORKER_B_EMAIL]) {
    if (!value.endsWith(".synthetic")) {
      throw new Error("Remote synthetic validation refused: every identity must be dedicated synthetic data.");
    }
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, "<synthetic-email>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-jwt>")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9._-]+\b/g, "<redacted-key>")
    .replace(/(token|key|hash)=?[^\s&]+/gi, "$1=<redacted>");
}

function logStep(step: string): void {
  process.stdout.write(`[synthetic-admin] ${step}\n`);
}

async function findUser(admin: SupabaseClient, email: string): Promise<User | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 1000) return null;
  }
  throw new Error("Synthetic identity lookup exceeded the guarded page limit.");
}

async function ensureIdentity(
  admin: SupabaseClient,
  organisationId: string,
  email: string,
  fullName: string,
  role: Role,
): Promise<PreparedIdentity> {
  let user = await findUser(admin, email);
  if (user && user.user_metadata?.synthetic_only !== true) {
    throw new Error("Synthetic identity guard failed: a reserved email belongs to an unmarked identity.");
  }
  if (!user) {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: fullName, synthetic_only: true },
    });
    if (created.error || !created.data.user) throw created.error ?? new Error("Synthetic auth identity was not created.");
    user = created.data.user;
  }

  const profile = await admin.from("global_profiles").upsert({
    id: user.id,
    full_name: fullName,
    email,
    deleted_at: null,
  }, { onConflict: "id" });
  if (profile.error) throw profile.error;

  const membership = await admin.from("organisation_memberships").upsert({
    organisation_id: organisationId,
    profile_id: user.id,
    role,
    status: "active",
    effective_until: null,
    withdrawn_at: null,
    withdrawn_reason: null,
  }, { onConflict: "organisation_id,profile_id" }).select("id").single();
  if (membership.error || !membership.data) throw membership.error ?? new Error("Synthetic membership was not created.");

  const roleResult = await admin.from("organisation_membership_roles").upsert({
    membership_id: membership.data.id,
    role,
    status: "active",
    effective_until: null,
  }, { onConflict: "membership_id,role" });
  if (roleResult.error) throw roleResult.error;

  const context = await admin.from("active_organisation_context").upsert({
    profile_id: user.id,
    organisation_id: organisationId,
  }, { onConflict: "profile_id" });
  if (context.error) throw context.error;

  return { user, membershipId: String(membership.data.id) };
}

async function prepareSyntheticTenant(admin: SupabaseClient): Promise<{
  organisationId: string;
  adminIdentity: PreparedIdentity;
  workerA: PreparedIdentity;
  workerB: PreparedIdentity;
}> {
  const existing = await admin.from("organisations")
    .select("id,name,deleted_at")
    .eq("slug", ORGANISATION_SLUG)
    .maybeSingle();
  if (existing.error) throw existing.error;

  let organisationId: string;
  if (existing.data) {
    if (existing.data.deleted_at || existing.data.name !== ORGANISATION_NAME) {
      throw new Error("Synthetic organisation guard failed: the reserved slug is unavailable.");
    }
    organisationId = String(existing.data.id);
  } else {
    const inserted = await admin.from("organisations")
      .insert({ name: ORGANISATION_NAME, slug: ORGANISATION_SLUG })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) throw inserted.error ?? new Error("Synthetic organisation was not created.");
    organisationId = String(inserted.data.id);
  }

  const adminIdentity = await ensureIdentity(admin, organisationId, ADMIN_EMAIL, "Synthetic Admin", "admin");
  const workerA = await ensureIdentity(admin, organisationId, WORKER_A_EMAIL, "Synthetic Worker A", "worker");
  const workerB = await ensureIdentity(admin, organisationId, WORKER_B_EMAIL, "Synthetic Worker B", "worker");
  return { organisationId, adminIdentity, workerA, workerB };
}

async function waitForOption(select: Locator, value: string): Promise<void> {
  await select.locator(`option[value="${value}"]`).waitFor({ state: "attached", timeout: 15_000 });
}

async function fill(selectOrInput: Locator, value: string): Promise<void> {
  const tag = await selectOrInput.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") await selectOrInput.selectOption(value);
  else await selectOrInput.fill(value);
}

async function submitRpc(page: Page, buttonName: string, rpcName: string): Promise<Record<string, unknown>> {
  const button = page.getByRole("button", { name: buttonName, exact: true });
  await button.waitFor({ state: "visible" });
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().includes(`/rest/v1/rpc/${rpcName}`),
  );
  await button.click();
  const response = await responsePromise;
  const payload = await readRpcResponse(response, rpcName);
  const refreshedForm = page.getByRole("button", { name: buttonName, exact: true }).locator("xpath=ancestor::form");
  const status = refreshedForm.locator('[role="status"]').first();
  await status.waitFor({ state: "visible", timeout: 15_000 });
  const statusText = (await status.textContent()) ?? "";
  if (statusText.includes("Could not save")) throw new Error(`${rpcName} was rejected by the mounted form.`);
  await page.waitForTimeout(200);
  return payload;
}

async function readRpcResponse(response: Response, rpcName: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok()) {
    let reason = `HTTP ${response.status()}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      reason = parsed.message || reason;
    } catch {
      // The status code remains enough; never echo an unstructured body.
    }
    throw new Error(`${rpcName} failed: ${reason}`);
  }
  const parsed = text ? JSON.parse(text) : {};
  return (parsed ?? {}) as Record<string, unknown>;
}

function requireResultId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key] ?? (payload.outcome as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected ${key} was absent from the accepted command result.`);
  return value;
}

function localDateTime(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

async function signIn(
  page: Page,
  admin: SupabaseClient,
  appUrl: string,
): Promise<void> {
  await page.goto(`${appUrl}/sign-in`, { waitUntil: "networkidle" });
  const generated = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const hash = generated.data.properties?.hashed_token;
  if (generated.error || !hash) throw generated.error ?? new Error("Synthetic sign-in link was not generated.");
  const callback = `${appUrl}/auth/callback?token_hash=${encodeURIComponent(hash)}&type=magiclink&next=/app/admin`;
  await page.goto(callback, { waitUntil: "networkidle" });
  try {
    await page.getByRole("heading", { name: "Admin workspace" }).waitFor({ timeout: 20_000 });
  } catch {
    const finalPath = new URL(page.url()).pathname;
    throw new Error(`Synthetic auth callback did not establish a browser session (final path ${finalPath}).`);
  }
}

async function verifyRemoteJourney(
  admin: SupabaseClient,
  organisationId: string,
  run: {
    participantName: string;
    registrationGroup: string;
    supportCategory: string;
    itemCode: string;
    roleTitle: string;
    workerCheckA: string;
    workerCheckB: string;
    pathwayReference: string;
    requirementType: string;
    evidenceReference: string;
    goalReference: string;
    shiftId: string;
  },
): Promise<void> {
  const checks = await Promise.all([
    admin.from("participants").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("first_name", run.participantName),
    admin.from("organisation_provider_scope_versions").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("registration_group", run.registrationGroup),
    admin.from("organisation_support_capabilities").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("support_category", run.supportCategory),
    admin.from("provider_support_items").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("item_code", run.itemCode),
    admin.from("risk_assessed_role_versions").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("title", run.roleTitle),
    admin.from("worker_screening_verification_versions").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).in("application_or_check_reference", [run.workerCheckA, run.workerCheckB]),
    admin.from("worker_screening_pathway_versions").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("application_placement_contract_reference", run.pathwayReference),
    admin.from("role_competence_requirements").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("evidence_type", run.requirementType),
    admin.from("worker_competence_evidence_versions").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("evidence_reference", run.evidenceReference),
    admin.from("participant_service_context_versions").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("goal_reference", run.goalReference).eq("lifecycle_state", "active"),
    admin.from("shift_service_snapshots").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("shift_id", run.shiftId).eq("item_code", run.itemCode),
    admin.from("service_acknowledgement_events").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).eq("shift_id", run.shiftId).eq("event_class", "attempt"),
  ]);
  for (const result of checks) {
    if (result.error) throw result.error;
    if (!result.count || result.count < 1) throw new Error("Remote verification did not find every expected synthetic journey record.");
  }
  if ((checks[5].count ?? 0) < 2) throw new Error("Remote verification did not find both synthetic worker screening records.");
}

async function run(): Promise<void> {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  guardRemoteDevelopment(url);
  const linkedProjectRef = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
  const configuredProjectRef = new URL(url).hostname.split(".")[0];
  if (!linkedProjectRef || linkedProjectRef !== configuredProjectRef) {
    throw new Error("Remote synthetic validation refused: the linked project and configured URL do not match.");
  }
  const configuredAppUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const appUrl = (process.env.SYNTHETIC_VALIDATION_APP_URL ?? configuredAppUrl).replace(/\/$/, "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(appUrl)) {
    throw new Error("Synthetic browser validation refused: app URL must be local.");
  }
  if (new URL(appUrl).origin !== new URL(configuredAppUrl).origin) {
    throw new Error("Synthetic browser validation refused: app URL must match NEXT_PUBLIC_APP_URL exactly.");
  }

  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const prepared = await prepareSyntheticTenant(admin);
  logStep("isolated synthetic tenant and three dedicated identities are ready");

  const runTag = Date.now().toString().slice(-9);
  const participantName = `Synthetic ${runTag}`;
  const registrationGroup = `synthetic-${runTag}`;
  const supportCategory = `daily_living_${runTag}`;
  const itemCode = `SYN-${runTag}`;
  const roleTitle = `Synthetic worker ${runTag}`;
  const workerCheckA = `SYN-CHECK-A-${runTag}`;
  const workerCheckB = `SYN-CHECK-B-${runTag}`;
  const pathwayReference = `SYN-PATH-${runTag}`;
  const requirementType = `induction_${runTag}`;
  const evidenceReference = `SYN-COMP-${runTag}`;
  const goalReference = `SYN-GOAL-${runTag}`;
  const identifier = `430${runTag.slice(-8)}`;
  const now = new Date();
  const yesterday = localDateTime(new Date(now.getTime() - 86_400_000));
  const availabilityFrom = localDateTime(new Date(now.getTime() - 3_600_000));
  const availabilityUntil = localDateTime(new Date(now.getTime() + 7 * 86_400_000));
  const scheduledStart = localDateTime(new Date(now.getTime() + 24 * 3_600_000));
  const scheduledEnd = localDateTime(new Date(now.getTime() + 25 * 3_600_000));
  const evidenceExpiry = localDateTime(new Date(now.getTime() + 300 * 86_400_000));

  const browser = await chromium.launch({ headless: true });
  const outputDir = process.env.SYNTHETIC_VALIDATION_OUTPUT_DIR ?? path.join(os.tmpdir(), "ndis-provider-crm-synthetic-validation");
  await mkdir(outputDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.on("dialog", (dialog) => void dialog.dismiss());

  try {
    await signIn(page, admin, appUrl);
    logStep("1/12 signed in through the real callback and loaded the protected admin workspace");

    await page.getByRole("button", { name: "Participants", exact: true }).click();
    await page.getByLabel("First name", { exact: true }).fill(participantName);
    await page.getByLabel("Last initial", { exact: true }).fill("S");
    await page.getByLabel("Critical support and safety handoff", { exact: true }).fill("Synthetic handoff only; no real participant information.");
    await page.getByLabel("Review due (create)", { exact: true }).fill(evidenceExpiry);
    const participantResult = await submitRpc(page, "Create secure record", "cmd_admin_create_participant");
    const participantId = requireResultId(participantResult, "participant_id");
    logStep("2/12 created the participant and separate critical handoff through the UI");

    await page.getByRole("button", { name: "Roster", exact: true }).click();
    const availabilityButton = page.getByRole("button", { name: "Publish availability", exact: true });
    const availabilityForm = availabilityButton.locator("xpath=ancestor::form");
    await fill(availabilityForm.getByLabel("Worker", { exact: true }), prepared.workerA.membershipId);
    await availabilityForm.getByLabel("Note", { exact: true }).fill(`Synthetic availability ${runTag}`);
    await availabilityForm.getByLabel("Available from", { exact: true }).fill(availabilityFrom);
    await availabilityForm.getByLabel("Available until", { exact: true }).fill(availabilityUntil);
    await submitRpc(page, "Publish availability", "cmd_admin_set_availability");
    logStep("3/12 published the synthetic worker availability window");

    await page.getByRole("button", { name: "Readiness", exact: true }).click();
    await page.getByLabel("Registration group", { exact: true }).fill(registrationGroup);
    await page.getByLabel("Class of support", { exact: true }).fill("individual");
    await fill(page.getByLabel("Scope reviewer", { exact: true }), prepared.adminIdentity.user.id);
    await page.getByLabel("Jurisdictions", { exact: true }).fill("NSW");
    const scopeResult = await submitRpc(page, "Save provider scope version", "cmd_admin_create_provider_scope_version");
    const scopeId = requireResultId(scopeResult, "scope_version_id");
    await waitForOption(page.getByLabel("Scope version", { exact: true }), scopeId);
    await fill(page.getByLabel("Scope version", { exact: true }), scopeId);
    await page.getByLabel("Support category", { exact: true }).fill(supportCategory);
    const capabilityResult = await submitRpc(page, "Add individual time capability", "cmd_admin_create_support_capability");
    const capabilityId = requireResultId(capabilityResult, "capability_id");
    logStep("4/12 created reviewed scope and the supported individual-time capability");

    await page.getByLabel("Catalogue source", { exact: true }).fill(`Synthetic catalogue ${runTag}`);
    await page.getByLabel("Catalogue version", { exact: true }).fill(`v-${runTag}`);
    await page.getByLabel("Item code", { exact: true }).fill(itemCode);
    await page.getByLabel("Item name", { exact: true }).fill(`Synthetic individual support ${runTag}`);
    const catalogueResult = await submitRpc(page, "Add time-based supported item", "cmd_admin_create_catalogue_item");
    const catalogueItemId = requireResultId(catalogueResult, "catalogue_item_id");
    logStep("5/12 created the provider-owned time-based catalogue item");

    await page.getByLabel("Risk-assessed role title", { exact: true }).fill(roleTitle);
    await page.getByLabel("Role definition basis", { exact: true }).fill("Synthetic provider risk assessment");
    await page.getByLabel("Role description", { exact: true }).fill("Synthetic individual support role");
    await page.getByLabel("Role assessor", { exact: true }).fill("Synthetic Admin");
    await page.getByLabel("Assessor title", { exact: true }).fill("Synthetic validation lead");
    await page.getByLabel("Assessment date", { exact: true }).fill(yesterday);
    const roleResult = await submitRpc(page, "Define risk-assessed role", "cmd_admin_create_risk_role");
    const roleId = requireResultId(roleResult, "role_version_id");
    await waitForOption(page.getByLabel("Risk-assessed role", { exact: true }), roleId);
    await fill(page.getByLabel("Risk-assessed role", { exact: true }), roleId);
    await page.getByLabel("Policy owner", { exact: true }).fill("Synthetic Admin");
    await page.getByLabel("Policy reason", { exact: true }).fill("Synthetic registered risk-role policy");
    await submitRpc(page, "Save registered/unregistered screening policy", "cmd_admin_create_screening_policy");
    logStep("6/12 defined the risk role and strict screening policy");

    const workerSelect = page.getByLabel("Worker", { exact: true });
    await fill(workerSelect, prepared.workerB.membershipId);
    await page.getByLabel("Screening verifier", { exact: true }).fill("Synthetic Admin");
    await page.getByLabel("Application/check reference", { exact: true }).fill(workerCheckB);
    await submitRpc(page, "Record current screening verification", "cmd_admin_record_worker_verification");
    await fill(workerSelect, prepared.workerA.membershipId);
    await page.getByLabel("Application/check reference", { exact: true }).fill(workerCheckA);
    await submitRpc(page, "Record current screening verification", "cmd_admin_record_worker_verification");
    await page.getByLabel("Named pathway application/placement/contract reference", { exact: true }).fill(pathwayReference);
    await fill(page.getByLabel("Cleared supervisor", { exact: true }), prepared.workerB.membershipId);
    await page.getByLabel("Supervisor clearance reference", { exact: true }).fill(workerCheckB);
    await page.getByLabel("Risk plan reference", { exact: true }).fill(`SYN-RISK-${runTag}`);
    await submitRpc(page, "Record named pathway evidence", "cmd_admin_record_worker_pathway");
    logStep("7/12 recorded two clearances and a named supervised pathway");

    await page.getByLabel("Competence evidence type", { exact: true }).fill(requirementType);
    await page.getByLabel("Assessment method", { exact: true }).fill("synthetic_provider_assessed");
    await page.getByLabel("Requirement owner", { exact: true }).fill("Synthetic Admin");
    const requirementResult = await submitRpc(page, "Define competence requirement", "cmd_admin_create_competence_requirement");
    const requirementId = requireResultId(requirementResult, "requirement_id");
    await waitForOption(page.getByLabel("Required competence", { exact: true }), requirementId);
    await fill(page.getByLabel("Required competence", { exact: true }), requirementId);
    await page.getByLabel("Evidence issuer", { exact: true }).fill("Synthetic training provider");
    await page.getByLabel("Evidence verifier", { exact: true }).fill("Synthetic Admin");
    await page.getByLabel("Evidence reference", { exact: true }).fill(evidenceReference);
    await page.getByLabel("Evidence expiry", { exact: true }).fill(evidenceExpiry);
    await submitRpc(page, "Record competence evidence", "cmd_admin_record_competence_evidence");
    logStep("8/12 created the hard competence requirement and current met evidence");

    await waitForOption(page.getByLabel("Identifier participant", { exact: true }), participantId);
    await fill(page.getByLabel("Identifier participant", { exact: true }), participantId);
    await page.getByLabel("Synthetic NDIS identifier", { exact: true }).fill(identifier);
    await submitRpc(page, "Save masked identifier", "cmd_admin_set_ndis_identifier");
    await page.getByLabel("Reveal reason", { exact: true }).fill("Synthetic validation of audited reveal");
    await submitRpc(page, "Reveal full identifier with audit", "cmd_admin_reveal_participant_ndis_identifier");
    await page.getByText(identifier, { exact: false }).waitFor();
    logStep("9/12 verified masked storage and the reason-required audited reveal");

    await waitForOption(page.getByLabel("Context participant", { exact: true }), participantId);
    await fill(page.getByLabel("Context participant", { exact: true }), participantId);
    await waitForOption(page.getByLabel("Context capability", { exact: true }), capabilityId);
    await fill(page.getByLabel("Context capability", { exact: true }), capabilityId);
    await waitForOption(page.getByLabel("Context catalogue item", { exact: true }), catalogueItemId);
    await fill(page.getByLabel("Context catalogue item", { exact: true }), catalogueItemId);
    await waitForOption(page.getByLabel("Context risk role", { exact: true }), roleId);
    await fill(page.getByLabel("Context risk role", { exact: true }), roleId);
    await fill(page.getByLabel("Context owner", { exact: true }), prepared.adminIdentity.user.id);
    await page.getByLabel("External agreement reference", { exact: true }).fill(`SYN-AGREEMENT-${runTag}`);
    await page.getByLabel("Plan reference", { exact: true }).fill(`SYN-PLAN-${runTag}`);
    await page.getByLabel("Goal reference", { exact: true }).fill(goalReference);
    await page.getByLabel("Goal display", { exact: true }).fill(`Synthetic community participation ${runTag}`);
    const contextResult = await submitRpc(page, "Create service context", "cmd_admin_create_service_context");
    const contextId = requireResultId(contextResult, "service_context_id");
    await waitForOption(page.getByLabel("Service context", { exact: true }), contextId);
    await fill(page.getByLabel("Service context", { exact: true }), contextId);
    await fill(page.getByLabel("Lifecycle state", { exact: true }), "active");
    await fill(page.getByLabel("Lifecycle reviewer", { exact: true }), prepared.adminIdentity.user.id);
    await fill(page.getByLabel("Lifecycle role", { exact: true }), roleId);
    await page.getByLabel("Lifecycle jurisdiction", { exact: true }).fill("NSW");
    await submitRpc(page, "Save context lifecycle", "cmd_admin_update_service_context_state");
    logStep("10/12 created a draft service context and explicitly reviewed it active");

    await fill(page.getByLabel("Readiness worker", { exact: true }), prepared.workerA.membershipId);
    await waitForOption(page.getByLabel("Readiness context", { exact: true }), contextId);
    await fill(page.getByLabel("Readiness context", { exact: true }), contextId);
    await page.getByLabel("Readiness start", { exact: true }).fill(scheduledStart);
    await page.getByLabel("Readiness end", { exact: true }).fill(scheduledEnd);
    const readinessResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/rest/v1/rpc/list_admin_provider_readiness"));
    await page.getByRole("button", { name: "Check readiness", exact: true }).click();
    const readiness = await readRpcResponse(await readinessResponse, "list_admin_provider_readiness");
    if (readiness.ready !== true) throw new Error(`Provider readiness remained blocked: ${String(readiness.reason ?? "unknown_reason")}`);
    await page.getByText(/Readiness result:\s*Ready\./).waitFor({ timeout: 15_000 });
    const shiftResult = await submitRpc(page, "Create service-ready shift", "cmd_admin_create_service_ready_shift");
    const shiftId = requireResultId(shiftResult, "shift_id");
    logStep("11/12 obtained a server-ready result and created the immutable service-ready shift");

    await waitForOption(page.getByLabel("Service record", { exact: true }), shiftId);
    await fill(page.getByLabel("Service record", { exact: true }), shiftId);
    const snapshotPanel = page.getByText("Immutable service snapshot", { exact: true }).locator("xpath=..");
    await snapshotPanel.getByText(itemCode, { exact: false }).waitFor();
    await page.getByLabel("Acknowledgement reason", { exact: true }).fill("Synthetic acknowledgement attempt");
    await submitRpc(page, "Record provider acknowledgement", "cmd_admin_record_acknowledgement");
    await page.getByText(/not participant-authenticated/i).last().waitFor();
    logStep("12/12 inspected the immutable snapshot and recorded truthful provider attempt history");

    await page.screenshot({ path: path.join(outputDir, `synthetic-admin-${runTag}-completed.png`), fullPage: true });

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Admin workspace" }).waitFor();
    await page.getByRole("button", { name: "Readiness", exact: true }).click();
    await page.screenshot({ path: path.join(outputDir, `synthetic-admin-${runTag}-persisted.png`), fullPage: true });

    await verifyRemoteJourney(admin, prepared.organisationId, {
      participantName,
      registrationGroup,
      supportCategory,
      itemCode,
      roleTitle,
      workerCheckA,
      workerCheckB,
      pathwayReference,
      requirementType,
      evidenceReference,
      goalReference,
      shiftId,
    });
    await writeFile(path.join(outputDir, `synthetic-admin-${runTag}.json`), JSON.stringify({
      status: "passed",
      syntheticOnly: true,
      steps: 12,
      browser: "chromium",
      screenshots: 2,
      remoteVerification: "passed",
      createdAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    logStep("PASS: browser journey and independent remote verification completed with synthetic data only");
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  process.stderr.write(`[synthetic-admin] FAIL: ${safeError(error)}\n`);
  process.exit(1);
});
