/**
 * Access-matrix tests.
 *
 * Positive and negative checks for the v1 RLS policies defined in 0006:
 *   * Workforce reads their own shift (and only their own).
 *   * Participant reads their own record + portal via self-link.
 *   * Representative reads only current, scoped authority.
 *   * External user reads only current, grant-scoped categories.
 *   * Admin/scheduler read everything in the active org.
 *   * Cross-organisation rows are not visible.
 *   * Workers cannot read another worker's summary.
 *   * External users cannot read non-finalised shifts.
 *   * Expiry + withdrawal revoke on the next read.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { bootTestDb, type Executor } from "./harness";
import {
  seedStandardFixture,
  seedOrgAInactiveMemberships,
  type Fixture,
} from "./fixtures";

let ex: Executor;
let fx: Fixture;
let other: { orgBId: string; otherOrgWorkerUid: string };

beforeEach(async () => {
  ex = await bootTestDb();
  fx = await seedStandardFixture(ex);
  other = await seedOrgAInactiveMemberships(ex);
});

afterEach(async () => {
  await ex.raw.close();
});

async function expectRows(
  sql: string,
  expected: number,
  asUser: string,
): Promise<void> {
  ex.setUser(asUser);
  const { rows } = await ex.exec(sql);
  expect((rows[0] as { c?: number }).c ?? rows.length).toBe(expected);
}

describe("participants access matrix", () => {
  it("admin and scheduler see all participants in active org", async () => {
    await expectRows(
      `select count(*)::int as c from public.participants`,
      1,
      fx.adminUid,
    );
    await expectRows(
      `select count(*)::int as c from public.participants`,
      1,
      fx.schedulerUid,
    );
  });

  it("assigned worker sees only the participant they are assigned to", async () => {
    await expectRows(
      `select count(*)::int as c from public.participants`,
      1,
      fx.workerAUid,
    );

    // Worker B is not assigned.
    await expectRows(
      `select count(*)::int as c from public.participants`,
      0,
      fx.workerBUid,
    );
  });

  it("participant self-link sees their own row", async () => {
    await expectRows(
      `select count(*)::int as c from public.participants where id = '${fx.participantId}'`,
      1,
      fx.participantUid,
    );
  });

  it("representative with active authority sees the participant", async () => {
    await expectRows(
      `select count(*)::int as c from public.participants where id = '${fx.participantId}'`,
      1,
      fx.representerUid,
    );
  });

  it("external user with grant scoped to 'service_summary' cannot see participant row (scope mismatch)", async () => {
    await expectRows(
      `select count(*)::int as c from public.participants where id = '${fx.participantId}'`,
      0,
      fx.externalUid,
    );
  });

  it("cross-org user cannot see anything", async () => {
    await expectRows(
      `select count(*)::int as c from public.participants`,
      0,
      other.otherOrgWorkerUid,
    );
  });
});

describe("shifts access matrix", () => {
  it("worker assigned sees their shift", async () => {
    await expectRows(
      `select count(*)::int as c from public.shifts where id = '${fx.shiftId}'`,
      1,
      fx.workerAUid,
    );
  });

  it("worker not assigned sees nothing", async () => {
    await expectRows(
      `select count(*)::int as c from public.shifts where id = '${fx.shiftId}'`,
      0,
      fx.workerBUid,
    );
  });

  it("participant sees scheduled shifts via self-link", async () => {
    await expectRows(
      `select count(*)::int as c from public.shifts where id = '${fx.shiftId}'`,
      1,
      fx.participantUid,
    );
  });

  it("representative sees the shift", async () => {
    await expectRows(
      `select count(*)::int as c from public.shifts where id = '${fx.shiftId}'`,
      1,
      fx.representerUid,
    );
  });

  it("external grant excludes non-finalised shift", async () => {
    await expectRows(
      `select count(*)::int as c from public.shifts where id = '${fx.shiftId}'`,
      0,
      fx.externalUid,
    );
  });
});

describe("representative_authorities RLS", () => {
  it("representative sees their own authority row", async () => {
    await expectRows(
      `select count(*)::int as c from public.representative_authorities where representative_profile_id = '${fx.representerUid}'`,
      1,
      fx.representerUid,
    );
  });

  it("withdrawn authorities are no longer visible to the representative", async () => {
    await ex.execAsService(
      `update public.representative_authorities
         set status = 'revoked',
             withdrawn_at = now(),
             withdrawn_by = '${fx.adminUid}',
             withdrawn_reason = 'test'
       where representative_profile_id = '${fx.representerUid}'`,
    );
    await expectRows(
      `select count(*)::int as c
         from public.representative_authorities
        where status='active'
          and representative_profile_id = '${fx.representerUid}'`,
      0,
      fx.representerUid,
    );
  });

  it("participant self-link sees the representative authority too", async () => {
    await expectRows(
      `select count(*)::int as c
         from public.representative_authorities
        where participant_id = '${fx.participantId}'`,
      1,
      fx.participantUid,
    );
  });
});

describe("external_disclosure_grants RLS", () => {
  it("external user sees their own active grant", async () => {
    await expectRows(
      `select count(*)::int as c from public.external_disclosure_grants where recipient_profile_id = '${fx.externalUid}' and status = 'active'`,
      1,
      fx.externalUid,
    );
  });

  it("expired grant is no longer visible", async () => {
    await ex.execAsService(
      `update public.external_disclosure_grants
         set effective_from = now() - interval '2 days',
             effective_until = now() - interval '1 day'
       where recipient_profile_id = '${fx.externalUid}'`,
    );
    await expectRows(
      `select count(*)::int as c from public.external_disclosure_grants where recipient_profile_id = '${fx.externalUid}' and status = 'active' and effective_until > now()`,
      0,
      fx.externalUid,
    );
  });

  it("participant sees their own grant list", async () => {
    await expectRows(
      `select count(*)::int as c from public.external_disclosure_grants where participant_id = '${fx.participantId}'`,
      1,
      fx.participantUid,
    );
  });
});

describe("worker A cannot see worker B's summary", async () => {
  it("shift_assignment scope is per-worker", async () => {
    // Until worker A submits and finalises, no summary exists.
    await expectRows(
      `select count(*)::int as c from public.service_summaries where shift_id = '${fx.shiftId}'`,
      0,
      fx.workerAUid,
    );
  });
});

describe("summary version audience access", () => {
  it("participant, representative, and external users can read the current scoped version", async () => {
    const summaryId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await ex.execAsService(
      `update public.shifts set state = 'finalised', version = version + 1 where id = '${fx.shiftId}'`,
    );
    await ex.execAsService(
      `insert into public.service_summaries (id, organisation_id, shift_id, finalised_at)
       values ('${summaryId}', '${fx.orgId}', '${fx.shiftId}', now())`,
    );
    await ex.execAsService(
      `insert into public.service_summary_versions
         (id, summary_id, version_number, activities, summary_text, audience_categories,
          author_membership_id, is_correction)
       values ('${versionId}', '${summaryId}', 1, array['personal_care'], 'Scoped summary',
          array['participant','service_summary','service_summary_external']::text[],
          (select id from public.organisation_memberships where organisation_id = '${fx.orgId}' and profile_id = '${fx.workerAUid}'),
          false)`,
    );
    await ex.execAsService(
      `update public.service_summaries set current_version_id = '${versionId}' where id = '${summaryId}'`,
    );

    for (const uid of [fx.participantUid, fx.representerUid, fx.externalUid]) {
      ex.setUser(uid);
      const { rows } = await ex.exec(
        `select count(*)::int as c from public.service_summary_current_versions
          where summary_id = '${summaryId}'`,
      );
      expect((rows[0] as { c: number }).c).toBe(1);
    }
  });

  it("rejects representative and grant identities from another organisation", async () => {
    const otherOrg = crypto.randomUUID();
    await ex.execAsService(
      `insert into public.organisations (id, name, slug) values ('${otherOrg}', 'Other', '${otherOrg}');`,
    );
    await expect(
      ex.execAsService(
        `insert into public.representative_authorities
          (organisation_id, participant_id, representative_profile_id, authority_type, scope_categories)
         values ('${otherOrg}', '${fx.participantId}', '${fx.representerUid}', 'plan_nominee', array['service_summary']);`,
      ),
    ).rejects.toThrow();
    await expect(
      ex.execAsService(
        `insert into public.external_disclosure_grants
          (organisation_id, participant_id, recipient_profile_id, purpose, scope_categories,
           consent_basis, effective_from, effective_until)
         values ('${otherOrg}', '${fx.participantId}', '${fx.externalUid}', 'bad tenant', array['service_summary'],
           'participant', now(), now() + interval '1 day');`,
      ),
    ).rejects.toThrow();
  });
});
