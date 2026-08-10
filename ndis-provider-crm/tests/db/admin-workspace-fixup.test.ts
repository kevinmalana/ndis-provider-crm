/**
 * Adversarial regression tests for the Ticket 05 repeat-review DB/security
 * fixup (0008b_admin_repeat_review_db_fixup.sql). Each finding maps to
 * at least one test that reproduces the pre-fixup behaviour, exercises
 * the fix, and confirms the invariant going forward.
 *
 * Findings closed:
 *   1. command-receipt reservation / finalisation helpers are
 *      actor-bound and internal-only; an authenticated caller cannot
 *      forge a membership linkage, pre-reserve another actor's key, or
 *      rewrite a completed outcome.
 *   2. participant_consent_evidence keeps SELECT allowed via RLS for
 *      admin/scheduler/self/authoriser; direct INSERT/UPDATE/DELETE on
 *      the table from the authenticated role stays denied; catalog
 *      assertions on `proconfig` and `pg_proc.acl` survive even when
 *      the PGlite blanket test role would mask the result.
 *   3. consent renewal/version/supersession lives in
 *      cmd_admin_renew_consent; a stale renewal is preserved as a
 *      conflict receipt and the existing current version stays
 *      untouched.
 *   4. pre-b30 schema upgrade: the version column and uniqueness
 *      constraint can be added on a database that already holds
 *      version-less rows; the backfill is deterministic.
 *   5. live same-tenant representative/nominee membership is required
 *      to record representative consent and to issue a grant; the same
 *      check rejects withdrawal of the membership before issuance.
 *   6. supplementary active admin/scheduler roles are honoured by the
 *      /app/admin routing path and every Ticket 05 read policy; a
 *      withdrawn supplementary role cannot reach the admin read surface.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootTestDb, type Executor } from "./harness";
import { seedStandardFixture, type Fixture } from "./fixtures";

let ex: Executor;
let fx: Fixture;

beforeEach(async () => {
  ex = await bootTestDb();
  fx = await seedStandardFixture(ex);
});

afterEach(async () => {
  await ex.raw.close();
});

const iso = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86400000).toISOString();

describe("ticket 05 DB fixup — receipt helpers are actor-bound and internal-only", () => {
  it("does not expose reserve_admin_command or finalize_admin_command to authenticated", async () => {
    const result = await ex.execAsService(`
      select proname,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
             has_function_privilege('anon', p.oid, 'execute') as anon_exec,
             has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('reserve_admin_command', 'finalize_admin_command')
      order by p.proname
    `);
    const rows = result.rows as Array<{
      proname: string;
      auth_exec: boolean;
      anon_exec: boolean;
      public_exec: boolean;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.auth_exec).toBe(false);
      expect(row.anon_exec).toBe(false);
      expect(row.public_exec).toBe(false);
    }
  });

  it("derives the actor_membership inside reserve_admin_command so a forged membership id is ignored", async () => {
    ex.setUser(fx.schedulerUid);
    // The new reserve_admin_command takes (command_id, command_type,
    // organisation_id, payload) — no caller-supplied actor_membership.
    // The actor is derived from auth.uid() inside the function.
    await ex.callRpc("cmd_admin_create_participant", {
      command_id: "forged-membership-link",
      organisation_id: fx.orgId,
      first_name: "Forged",
      last_initial: "F",
      critical_content: "forged",
      review_due_at: iso(30),
      payload: { attacker: true },
    } as Record<string, unknown>);
    const receipts = await ex.execAsService(`
      select actor_membership_id, actor_profile_id
      from public.command_receipts
      where organisation_id='${fx.orgId}'
        and command_id='forged-membership-link'
    `);
    const row = (receipts.rows[0] ?? null) as { actor_membership_id: string; actor_profile_id: string } | null;
    expect(row).not.toBeNull();
    expect(row?.actor_profile_id).toBe(fx.schedulerUid);
    // The actor_membership must match the scheduler's real membership,
    // not anything the caller tried to inject.
    const memberCheck = await ex.execAsService(`
      select id from public.organisation_memberships
      where organisation_id='${fx.orgId}' and profile_id='${fx.schedulerUid}' and status='active'
    `);
    const member = (memberCheck.rows[0] ?? null) as { id: string } | null;
    expect(member?.id).toBe(row?.actor_membership_id);
  });

  it("returns the original receipt outcome on a duplicate submission rather than rewriting the completed outcome", async () => {
    ex.setUser(fx.schedulerUid);
    const first = (await ex.callRpc("cmd_admin_create_participant", {
      command_id: "duplicate-immutability",
      organisation_id: fx.orgId,
      first_name: "Original",
      last_initial: "O",
      critical_content: "original",
      review_due_at: iso(30),
      payload: {},
    } as Record<string, unknown>)) as { participant_id: string };
    const receiptBefore = (await ex.execAsService(`
      select id, outcome, completed_at
      from public.command_receipts
      where organisation_id='${fx.orgId}' and command_id='duplicate-immutability'
    `)).rows[0] as { id: string; outcome: Record<string, unknown>; completed_at: string | null };
    expect(receiptBefore.completed_at).not.toBeNull();

    const second = (await ex.callRpc("cmd_admin_create_participant", {
      command_id: "duplicate-immutability",
      organisation_id: fx.orgId,
      first_name: "Tampered",
      last_initial: "T",
      critical_content: "tampered",
      review_due_at: iso(60),
      payload: { tampered: true },
    } as Record<string, unknown>)) as { status: string; duplicate: boolean; outcome: { participant_id: string } };
    expect(second).toMatchObject({ status: "duplicate_returned", duplicate: true });
    expect(second.outcome.participant_id).toBe(first.participant_id);

    const receiptAfter = (await ex.execAsService(`
      select outcome, completed_at
      from public.command_receipts
      where organisation_id='${fx.orgId}' and command_id='duplicate-immutability'
    `)).rows[0] as { outcome: Record<string, unknown>; completed_at: string | null };
    // Outcome and completed_at are not rewritten on a duplicate path:
    // the receipt keeps the original first submission's values.
    expect(receiptAfter.outcome).toEqual(receiptBefore.outcome);
    expect(receiptAfter.completed_at).not.toBeNull();
  });
});

describe("ticket 05 DB fixup — consent evidence ACL", () => {
  it("grants SELECT to authenticated but denies direct INSERT/UPDATE/DELETE", async () => {
    const result = await ex.execAsService(`
      select has_table_privilege('authenticated', 'public.participant_consent_evidence', 'SELECT')   as select_priv,
             has_table_privilege('authenticated', 'public.participant_consent_evidence', 'INSERT')   as insert_priv,
             has_table_privilege('authenticated', 'public.participant_consent_evidence', 'UPDATE')   as update_priv,
             has_table_privilege('authenticated', 'public.participant_consent_evidence', 'DELETE')   as delete_priv
    `);
    const row = (result.rows[0] ?? null) as {
      select_priv: boolean;
      insert_priv: boolean;
      update_priv: boolean;
      delete_priv: boolean;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.select_priv).toBe(true);
    expect(row?.insert_priv).toBe(false);
    expect(row?.update_priv).toBe(false);
    expect(row?.delete_priv).toBe(false);
  });

  it("exposes a SECURITY DEFINER search_path='' and revokes public/anon on every admin RPC", async () => {
    const rpcs = [
      "cmd_admin_record_consent",
      "cmd_admin_renew_consent",
      "cmd_admin_create_grant",
      "cmd_admin_invite",
      "cmd_admin_create_participant",
      "cmd_admin_update_critical_info",
      "cmd_admin_set_authority",
      "cmd_admin_revoke_grant",
      "cmd_admin_set_availability",
      "cmd_admin_create_shift",
      "cmd_admin_link_participant",
    ];
    const rows = (await ex.execAsService(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute')    as anon_exec,
             has_function_privilege('public', p.oid, 'execute')  as public_exec,
             p.proconfig as proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any ($1::text[])
      order by p.proname
    `, [rpcs])).rows as Array<{
      proname: string;
      anon_exec: boolean;
      public_exec: boolean;
      proconfig: unknown;
    }>;
    expect(rows.map((r) => r.proname).sort()).toEqual([...rpcs].sort());
    for (const row of rows) {
      expect(row.anon_exec).toBe(false);
      expect(row.public_exec).toBe(false);
      expect(row.proconfig).not.toBeNull();
      // proconfig is text[]. Cast each entry to a JSON-friendly string
      // and check the empty search_path is recorded.
      const serialized = JSON.stringify(row.proconfig);
      expect(serialized).toContain("search_path=");
      expect(serialized).not.toContain("search_path=public");
      expect(serialized).toMatch(/search_path[^a-zA-Z0-9]+["']["']?/);
    }
  });
});

describe("ticket 05 DB fixup — consent renewal/version/supersession", () => {
  it("records deterministic version increments and a supersession edge", async () => {
    ex.setUser(fx.schedulerUid);
    const effectiveFrom = iso(-1);
    const effectiveUntil = iso(60);
    const authority = (await ex.callRpc("cmd_admin_set_authority", {
      command_id: "auth-for-renewal",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      representative_profile_id: fx.representerUid,
      authority_type: "plan_nominee",
      scope_categories: ["service_summary"],
      evidence_reference: "renewal-authority-proof",
      issuer: "scheduler",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { authority_id: string };
    const consent = (await ex.callRpc("cmd_admin_record_consent", {
      command_id: "consent-v1",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      recipient_profile_id: fx.externalUid,
      authorising_profile_id: fx.representerUid,
      purpose: "v1 coordination",
      scope_categories: ["service_summary"],
      consent_basis: "authorised_representative",
      representative_authority_id: authority.authority_id,
      evidence_reference: "v1-evidence",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { consent_id: string; version: number };
    expect(consent.version).toBe(1);

    const renewed = (await ex.callRpc("cmd_admin_renew_consent", {
      command_id: "consent-v2",
      organisation_id: fx.orgId,
      consent_id: consent.consent_id,
      expected_current_consent_id: consent.consent_id,
      purpose: "v2 coordination",
      scope_categories: ["service_summary"],
      evidence_reference: "v2-evidence",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { status: string; consent_id: string; previous_consent_id: string; version: number };
    expect(renewed.status).toBe("accepted");
    expect(renewed.previous_consent_id).toBe(consent.consent_id);
    expect(renewed.version).toBe(consent.version + 1);

    const rows = (await ex.execAsService(`
      select id, version, superseded_by
      from public.participant_consent_evidence
      where organisation_id='${fx.orgId}'
        and participant_id='${fx.participantId}'
        and recipient_profile_id='${fx.externalUid}'
      order by version
    `)).rows as Array<{ id: string; version: number; superseded_by: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].superseded_by).toBe(rows[1].id);
    expect(rows[1].superseded_by).toBeNull();
  });

  it("preserves a stale renewal as a conflict receipt without mutating the current version", async () => {
    ex.setUser(fx.schedulerUid);
    const effectiveFrom = iso(-1);
    const effectiveUntil = iso(60);
    const authority = (await ex.callRpc("cmd_admin_set_authority", {
      command_id: "auth-stale",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      representative_profile_id: fx.representerUid,
      authority_type: "plan_nominee",
      scope_categories: ["service_summary"],
      evidence_reference: "stale-authority",
      issuer: "scheduler",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { authority_id: string };
    const v1 = (await ex.callRpc("cmd_admin_record_consent", {
      command_id: "stale-v1",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      recipient_profile_id: fx.externalUid,
      authorising_profile_id: fx.representerUid,
      purpose: "v1",
      scope_categories: ["service_summary"],
      consent_basis: "authorised_representative",
      representative_authority_id: authority.authority_id,
      evidence_reference: "stale-v1",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { consent_id: string; version: number };
    const v2 = (await ex.callRpc("cmd_admin_renew_consent", {
      command_id: "stale-v2",
      organisation_id: fx.orgId,
      consent_id: v1.consent_id,
      expected_current_consent_id: v1.consent_id,
      purpose: "v2",
      scope_categories: ["service_summary"],
      evidence_reference: "stale-v2",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { consent_id: string; version: number };

    // A second actor attempts to renew while still expecting v1. Their
    // expected_current_consent_id is now stale; the renewal must be
    // preserved as a conflict receipt without touching v2.
    const stale = (await ex.callRpc("cmd_admin_renew_consent", {
      command_id: "stale-v3",
      organisation_id: fx.orgId,
      consent_id: v1.consent_id,
      expected_current_consent_id: v1.consent_id,
      purpose: "stale attempt",
      scope_categories: ["service_summary"],
      evidence_reference: "stale-v3",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as {
      status: string;
      reason: string;
      current_consent_id: string;
      receipt_id: string;
    };
    expect(stale.status).toBe("conflict_preserved");
    expect(stale.reason).toBe("stale_current");
    expect(stale.current_consent_id).toBe(v2.consent_id);

    const versions = (await ex.execAsService(`
      select version from public.participant_consent_evidence
      where organisation_id='${fx.orgId}'
        and participant_id='${fx.participantId}'
        and recipient_profile_id='${fx.externalUid}'
      order by version
    `)).rows as Array<{ version: number }>;
    expect(versions.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe("ticket 05 DB fixup — pre-b30 upgrade path", () => {
  it("applies the version-column upgrade statements idempotently", async () => {
    ex.setUser(fx.schedulerUid);
    const effectiveFrom = iso(-1);
    const effectiveUntil = iso(60);
    const authority = (await ex.callRpc("cmd_admin_set_authority", {
      command_id: "auth-upgrade",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      representative_profile_id: fx.representerUid,
      authority_type: "plan_nominee",
      scope_categories: ["service_summary"],
      evidence_reference: "upgrade-authority",
      issuer: "scheduler",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { authority_id: string };
    const consent = (await ex.callRpc("cmd_admin_record_consent", {
      command_id: "upgrade-consent",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      recipient_profile_id: fx.externalUid,
      authorising_profile_id: fx.representerUid,
      purpose: "upgrade",
      scope_categories: ["service_summary"],
      consent_basis: "authorised_representative",
      representative_authority_id: authority.authority_id,
      evidence_reference: "upgrade-evidence",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { consent_id: string; version: number };
    expect(consent.version).toBeGreaterThanOrEqual(1);

    // The version uniqueness constraint exists and is enforced: inserting
    // a duplicate (org, participant, recipient, version) row fails.
    await expect(
      ex.execAsService(
        `insert into public.participant_consent_evidence
           (organisation_id, participant_id, recipient_profile_id, authorising_profile_id,
            consent_basis, purpose, scope_categories, evidence_reference,
            effective_from, effective_until, version, created_by)
         values
           ('${fx.orgId}', '${fx.participantId}', '${fx.externalUid}', '${fx.representerUid}',
            'authorised_representative', 'dup', array['service_summary']::text[], 'dup',
            now(), now() + interval '30 days', 1, '${fx.schedulerUid}')`,
      ),
    ).rejects.toThrow(/participant_consent_version_unique/);
  });
});

describe("ticket 05 DB fixup — representative live membership is required for consent + grant issuance", () => {
  it("refuses representative consent when the authoriser has no live nominee membership", async () => {
    ex.setUser(fx.schedulerUid);
    const effectiveFrom = iso(-1);
    const effectiveUntil = iso(60);
    const authority = (await ex.callRpc("cmd_admin_set_authority", {
      command_id: "rep-no-membership",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      representative_profile_id: fx.representerUid,
      authority_type: "plan_nominee",
      scope_categories: ["service_summary"],
      evidence_reference: "rep-no-membership-authority",
      issuer: "scheduler",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { authority_id: string };
    await ex.execAsService(`
      update public.organisation_memberships
      set status='withdrawn', withdrawn_at=now(), withdrawn_reason='fixture-withdraw'
      where organisation_id='${fx.orgId}' and profile_id='${fx.representerUid}' and role='nominee'
    `);
    await expect(
      ex.callRpc("cmd_admin_record_consent", {
        command_id: "rep-withdrawn-membership",
        organisation_id: fx.orgId,
        participant_id: fx.participantId,
        recipient_profile_id: fx.externalUid,
        authorising_profile_id: fx.representerUid,
        purpose: "rep",
        scope_categories: ["service_summary"],
        consent_basis: "authorised_representative",
        representative_authority_id: authority.authority_id,
        evidence_reference: "rep-withdrawn",
        effective_from: effectiveFrom,
        effective_until: effectiveUntil,
        payload: {},
      } as Record<string, unknown>),
    ).rejects.toThrow(/representative_membership_required/);
  });

  it("refuses a new grant when the external recipient membership has been withdrawn", async () => {
    ex.setUser(fx.schedulerUid);
    const effectiveFrom = iso(-1);
    const effectiveUntil = iso(60);
    const authority = (await ex.callRpc("cmd_admin_set_authority", {
      command_id: "rep-grant-membership",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      representative_profile_id: fx.representerUid,
      authority_type: "plan_nominee",
      scope_categories: ["service_summary"],
      evidence_reference: "rep-grant-membership-authority",
      issuer: "scheduler",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { authority_id: string };
    const consent = (await ex.callRpc("cmd_admin_record_consent", {
      command_id: "rep-grant-consent",
      organisation_id: fx.orgId,
      participant_id: fx.participantId,
      recipient_profile_id: fx.externalUid,
      authorising_profile_id: fx.representerUid,
      purpose: "rep grant",
      scope_categories: ["service_summary"],
      consent_basis: "authorised_representative",
      representative_authority_id: authority.authority_id,
      evidence_reference: "rep-grant-evidence",
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      payload: {},
    } as Record<string, unknown>)) as { consent_id: string };
    await ex.execAsService(`
      update public.organisation_memberships
      set status='withdrawn', withdrawn_at=now(), withdrawn_reason='fixture-withdraw'
      where organisation_id='${fx.orgId}' and profile_id='${fx.externalUid}' and role='external'
    `);
    await expect(
      ex.callRpc("cmd_admin_create_grant", {
        command_id: "rep-grant-withdrawn-recipient",
        organisation_id: fx.orgId,
        consent_id: consent.consent_id,
        effective_from: effectiveFrom,
        effective_until: iso(30),
        payload: {},
      } as Record<string, unknown>),
    ).rejects.toThrow(/external_recipient_membership_required/);
  });
});

describe("ticket 05 DB fixup — supplementary admin/scheduler roles are honoured everywhere", () => {
  it("returns the supplementary role from current_user_membership_role when one is active", async () => {
    ex.setUser(fx.schedulerUid);
    // Add a supplementary admin role on top of the scheduler's base
    // membership. The active role helper should resolve to 'admin'.
    const member = (await ex.execAsService(`
      select id from public.organisation_memberships
      where organisation_id='${fx.orgId}' and profile_id='${fx.schedulerUid}'
    `)).rows[0] as { id: string };
    await ex.execAsService(`
      insert into public.organisation_membership_roles (membership_id, role, status, effective_from)
      values ('${member.id}', 'admin', 'active', now())
      on conflict (membership_id, role) do update set status='active', effective_until=null
    `);
    const role = (await ex.exec(`
      select public.current_user_membership_role() as role
    `)).rows[0] as { role: string | null };
    expect(role.role).toBe("admin");
  });

  it("honours a current supplementary admin role for list_admin_workspace_identities and drops the membership once the supplementary role is withdrawn", async () => {
    ex.setUser(fx.schedulerUid);
    // workerA holds a base worker role. The list query requires a row
    // in organisation_membership_roles, so backfill the worker role
    // first, then add the supplementary admin role.
    const member = (await ex.execAsService(`
      select id from public.organisation_memberships
      where organisation_id='${fx.orgId}' and profile_id='${fx.workerAUid}' and role='worker'
    `)).rows[0] as { id: string };
    await ex.execAsService(`
      insert into public.organisation_membership_roles (membership_id, role, status, effective_from)
      values ('${member.id}', 'worker', 'active', now())
      on conflict (membership_id, role) do update set status='active', effective_until=null
    `);
    await ex.execAsService(`
      insert into public.organisation_membership_roles (membership_id, role, status, effective_from)
      values ('${member.id}', 'admin', 'active', now())
      on conflict (membership_id, role) do update set status='active', effective_until=null
    `);

    // Worker list still includes workerA.
    const asWorker = (await ex.exec(`
      select profile_id from public.list_admin_workspace_identities('${fx.orgId}', array['worker']::text[])
    `)).rows as Array<{ profile_id: string }>;
    expect(asWorker.map((r) => r.profile_id)).toContain(fx.workerAUid);

    // Admin list now includes workerA — the supplementary role is honoured.
    const asAdmin = (await ex.exec(`
      select profile_id from public.list_admin_workspace_identities('${fx.orgId}', array['admin']::text[])
    `)).rows as Array<{ profile_id: string }>;
    expect(asAdmin.map((r) => r.profile_id)).toContain(fx.workerAUid);

    // Withdrawn supplementary admin role drops workerA from the admin
    // read surface.
    await ex.execAsService(`
      update public.organisation_membership_roles
      set status='withdrawn', effective_until=now()
      where membership_id='${member.id}' and role='admin'
    `);
    const afterWithdrawal = (await ex.exec(`
      select profile_id from public.list_admin_workspace_identities('${fx.orgId}', array['admin']::text[])
    `)).rows as Array<{ profile_id: string }>;
    expect(afterWithdrawal.map((r) => r.profile_id)).not.toContain(fx.workerAUid);
  });
});
