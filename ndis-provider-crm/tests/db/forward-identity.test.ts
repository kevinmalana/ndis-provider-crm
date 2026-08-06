/**
 * Forward-identity migration tests.
 *
 * Verifies that the 0003 forward identity migration:
 *   * Preserves a legacy `profiles` row as one global_profiles row +
 *     one organisation_memberships row;
 *   * Allows a second invitation (different org) to attach to the same
 *     global_profiles row via a new membership without colliding;
 *   * active_organisation_context pick routine changes the helper
 *     output without changing RLS outcomes;
 *   * set_active_organisation refuses to leave the user's own active
 *     memberships.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { bootTestDb, type Executor } from "./harness";

let ex: Executor;

beforeEach(async () => {
  ex = await bootTestDb();
});

afterEach(async () => {
  await ex.raw.close();
});

describe("forward identity migration", () => {
  it("migrates a legacy profile row into one global_profiles + one membership", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const orgId = "22222222-2222-4222-8222-222222222222";

    await ex.execAsService(
      `insert into auth.users (id, email) values ('${userId}','u@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug)
       values ('${orgId}','Org A','org-a')`,
    );
    await ex.execAsService(
      `insert into public.profiles (id, organisation_id, role, email, full_name)
       values ('${userId}','${orgId}','worker','u@test.example','U Test')`,
    );

    // Re-run the migration procedure on demand: this is the canonical
    // forward-migration step. In production this runs once at deploy
    // time; here we exercise it on synthetic data.
    await ex.execAsService(
      `select public.forward_migrate_legacy_profiles()`,
    );

    const { rows: profileRows } = await ex.execAsService(
      `select count(*)::int as c from public.global_profiles where id = '${userId}'`,
    );
    expect((profileRows[0] as { c: number }).c).toBe(1);

    const { rows: membershipRows } = await ex.execAsService(
      `select count(*)::int as c
         from public.organisation_memberships
        where profile_id = '${userId}' and organisation_id = '${orgId}'`,
    );
    expect((membershipRows[0] as { c: number }).c).toBe(1);

    const { rows: rows2 } = await ex.execAsService(
      `select role from public.organisation_memberships
        where profile_id = '${userId}' and organisation_id = '${orgId}'`,
    );
    expect((rows2[0] as { role: string }).role).toBe("worker");

    const { rows: ctxRows } = await ex.execAsService(
      `select organisation_id from public.active_organisation_context
        where profile_id = '${userId}'`,
    );
    expect((ctxRows[0] as { organisation_id: string }).organisation_id).toBe(
      orgId,
    );
  });

  it("allows a second invitation to attach to the same global profile", async () => {
    const userId = "33333333-3333-4333-8333-333333333333";
    const orgA = "44444444-4444-4444-8444-444444444444";
    const orgB = "55555555-5555-4555-8555-555555555555";

    await ex.execAsService(
      `insert into auth.users (id, email) values ('${userId}','u2@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug) values
       ('${orgA}','Org A','org-a-2'),
       ('${orgB}','Org B','org-b-1')`,
    );

    // Pre-migration legacy profile + Org A membership.
    await ex.execAsService(
      `insert into public.profiles (id, organisation_id, role, email)
       values ('${userId}','${orgA}','worker','u2@test.example')`,
    );
    await ex.execAsService(
      `select public.forward_migrate_legacy_profiles()`,
    );

    // Open an invitation for the same user into Org B.
    await ex.execAsService(
      `insert into public.invitations
         (organisation_id, email, role, token, expires_at)
       values
       ('${orgB}','u2@test.example','worker','tok', now() + interval '1 day')`,
    );

    // Simulate the second sign-in: run the same logic the trigger runs.
    await ex.execAsService(
      `do $$
        declare v_inv public.invitations;
        begin
          select * into v_inv
          from public.invitations
          where email = 'u2@test.example'
            and accepted_at is null
            and revoked_at is null
            and expires_at > now()
          order by created_at desc limit 1;

          insert into public.global_profiles (id, email)
          values ('${userId}', v_inv.email)
          on conflict (id) do nothing;

          insert into public.organisation_memberships
              (organisation_id, profile_id, role, status, effective_from)
          values (v_inv.organisation_id, '${userId}', v_inv.role, 'active', now())
          on conflict (organisation_id, profile_id) do nothing;

          update public.invitations set accepted_at = now()
            where id = v_inv.id;
        end$$`,
    );

    const { rows: memberships } = await ex.execAsService(
      `select count(*)::int as c from public.organisation_memberships
        where profile_id = '${userId}'`,
    );
    expect((memberships[0] as { c: number }).c).toBe(2);

    const { rows: profiles } = await ex.execAsService(
      `select count(*)::int as c from public.global_profiles where id = '${userId}'`,
    );
    expect((profiles[0] as { c: number }).c).toBe(1);
  });

  it("enforces one membership per organisation while keeping roles separate", async () => {
    const userId = "33333333-3333-4333-8333-333333333334";
    const orgId = "44444444-4444-4444-8444-444444444445";
    await ex.execAsService(
      `insert into auth.users (id, email) values ('${userId}','roles@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug) values ('${orgId}','Roles','roles-org')`,
    );
    await ex.execAsService(
      `insert into public.global_profiles (id, email) values ('${userId}','roles@test.example')
       on conflict (id) do nothing`,
    );
    await ex.execAsService(
      `insert into public.organisation_memberships
        (organisation_id, profile_id, role, status, effective_from)
       values ('${orgId}','${userId}','worker','active',now())`,
    );
    await expect(
      ex.execAsService(
        `insert into public.organisation_memberships
          (organisation_id, profile_id, role, status, effective_from)
         values ('${orgId}','${userId}','nominee','active',now())`,
      ),
    ).rejects.toThrow();
    await ex.execAsService(
      `insert into public.organisation_membership_roles (membership_id, role, status, effective_from)
       values ((select id from public.organisation_memberships where organisation_id = '${orgId}' and profile_id = '${userId}'),
               'worker','active',now()),
              ((select id from public.organisation_memberships where organisation_id = '${orgId}' and profile_id = '${userId}'),
               'nominee','active',now())`,
    );
    const { rows } = await ex.execAsService(
      `select count(*)::int as c from public.organisation_membership_roles
        where membership_id = (select id from public.organisation_memberships where organisation_id = '${orgId}' and profile_id = '${userId}')`,
    );
    expect((rows[0] as { c: number }).c).toBe(2);
  });

  it("accepts an invitation only through the exact token-bound RPC", async () => {
    const userId = "55555555-5555-4555-8555-555555555556";
    const orgId = "66666666-6666-4666-8666-666666666667";
    await ex.execAsService(
      `insert into auth.users (id, email) values ('${userId}','invitee@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug) values ('${orgId}','Invite Org','invite-org')`,
    );
    await ex.execAsService(
      `insert into public.invitations
        (organisation_id, email, role, token, expires_at)
       values ('${orgId}','invitee@test.example','worker','exact-token',now() + interval '1 day')`,
    );

    ex.setUser(userId);
    const accepted = await ex.callRpc("cmd_accept_invitation", {
      token: "exact-token",
    });
    expect(accepted).toMatchObject({ status: "accepted", organisation_id: orgId, role: "worker" });
    const { rows: memberships } = await ex.execAsService(
      `select count(*)::int as c from public.organisation_memberships
        where organisation_id = '${orgId}' and profile_id = '${userId}'`,
    );
    expect((memberships[0] as { c: number }).c).toBe(1);

    await expect(
      ex.callRpc("cmd_accept_invitation", { token: "exact-token" }),
    ).rejects.toThrow("invitation_already_accepted");
    await expect(
      ex.callRpc("cmd_accept_invitation", { token: "not-the-token" }),
    ).rejects.toThrow("invitation_not_found");
  });

  it("set_active_organisation refuses when caller is not a member", async () => {
    const userId = "66666666-6666-4666-8666-666666666666";
    const orgA = "77777777-7777-4777-8777-777777777777";
    const orgForeign = "88888888-8888-4888-8888-888888888888";

    await ex.execAsService(
      `insert into auth.users (id, email) values ('${userId}','u3@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug) values
       ('${orgA}','A','a'),
       ('${orgForeign}','Foreigner','foreigner')`,
    );
    await ex.execAsService(
      `insert into public.global_profiles (id, email) values ('${userId}','u3@test.example')
       on conflict (id) do update set email = excluded.email`,
    );
    await ex.execAsService(
      `insert into public.organisation_memberships
         (organisation_id, profile_id, role, status, effective_from)
       values ('${orgA}','${userId}','admin','active', now())`,
    );

    ex.setUser(userId);
    await expect(
      ex.callRpc("set_active_organisation", { organisation_id: orgForeign }),
    ).rejects.toThrow();

    await ex.callRpc("set_active_organisation", {
      organisation_id: orgA,
    });

    // void functions return an empty string from the harness (select result
    // coalesced to ''); semantics are "the call completed" so absence of
    // error is the meaningful assertion.

    const { rows } = await ex.execAsService(
      `select organisation_id from public.active_organisation_context
        where profile_id = '${userId}'`,
    );
    expect((rows[0] as { organisation_id: string }).organisation_id).toBe(orgA);
  });

  it("withdrawn legacy profiles do not seed an active context or membership", async () => {
    const userId = "99999999-9999-4999-8999-999999999999";
    const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await ex.execAsService(
      `insert into auth.users (id, email) values ('${userId}','u4@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug)
       values ('${orgId}','Org W','org-w')`,
    );
    // Legacy profile marked soft-deleted: migration must mirror that.
    await ex.execAsService(
      `insert into public.profiles (id, organisation_id, role, email, deleted_at)
       values ('${userId}','${orgId}','worker','u4@test.example', now())`,
    );
    await ex.execAsService(
      `select public.forward_migrate_legacy_profiles()`,
    );

    const { rows: membershipRows } = await ex.execAsService(
      `select status from public.organisation_memberships
        where profile_id = '${userId}'`,
    );
    expect((membershipRows[0] as { status: string }).status).toBe("withdrawn");

    const { rows: ctxRows } = await ex.execAsService(
      `select 1 from public.active_organisation_context
        where profile_id = '${userId}'`,
    );
    expect(ctxRows.length).toBe(0);
  });

  it("invitation and audit RLS ignore forged legacy profile authority", async () => {
    const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const orgId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    await ex.execAsService(
      `insert into auth.users (id, email) values
        ('${adminId}','admin-rules@test.example'), ('${workerId}','worker-rules@test.example')`,
    );
    await ex.execAsService(
      `insert into public.organisations (id, name, slug) values ('${orgId}','Rules','rules-org')`,
    );
    await ex.execAsService(
      `insert into public.global_profiles (id, email) values
        ('${adminId}','admin-rules@test.example'), ('${workerId}','worker-rules@test.example')
       on conflict (id) do nothing`,
    );
    await ex.execAsService(
      `insert into public.organisation_memberships
        (organisation_id, profile_id, role, status, effective_from) values
        ('${orgId}','${adminId}','admin','active',now()),
        ('${orgId}','${workerId}','worker','active',now())`,
    );
    await ex.execAsService(
      `insert into public.active_organisation_context (profile_id, organisation_id)
       values ('${adminId}','${orgId}'), ('${workerId}','${orgId}')`,
    );
    await ex.execAsService(
      `insert into public.profiles (id, organisation_id, role, email)
       values ('${adminId}','${orgId}','admin','admin-rules@test.example'),
              ('${workerId}','${orgId}','admin','worker-rules@test.example')`,
    );
    await ex.execAsService(
      `insert into public.invitations (organisation_id, email, role, token, expires_at, issued_by)
       values ('${orgId}','new@test.example','worker','rules-token',now() + interval '1 day','${adminId}')`,
    );
    await ex.execAsService(
      `insert into public.audit_log (organisation_id, actor, action, subject_type)
       values ('${orgId}','${adminId}','rules.test','organisation')`,
    );

    ex.setUser(workerId);
    const { rows: workerInvites } = await ex.exec(
      `select count(*)::int as c from public.invitations`,
    );
    const { rows: workerAudit } = await ex.exec(
      `select count(*)::int as c from public.audit_log`,
    );
    expect((workerInvites[0] as { c: number }).c).toBe(0);
    expect((workerAudit[0] as { c: number }).c).toBe(0);

    ex.setUser(adminId);
    const { rows: adminInvites } = await ex.exec(
      `select count(*)::int as c from public.invitations`,
    );
    const { rows: adminAudit } = await ex.exec(
      `select count(*)::int as c from public.audit_log`,
    );
    expect((adminInvites[0] as { c: number }).c).toBe(1);
    expect((adminAudit[0] as { c: number }).c).toBe(1);
  });
});
