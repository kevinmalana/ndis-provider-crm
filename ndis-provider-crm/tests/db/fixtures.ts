/**
 * Standard test fixture: seeds a single organisation with one of every
 * role used in the access-matrix tests.
 *
 * Roles provisioned:
 *   adminUid       — active membership: role=admin
 *   schedulerUid   — active membership: role=scheduler
 *   workerAUid     — active membership: role=worker, currently assigned
 *                    to the test shift
 *   workerBUid     — active membership: role=worker, NOT assigned
 *   participantUid — global profile linked to the test participant via
 *                    participant_self_links; no workforce membership
 *   representerUid — global profile linked to the test participant via
 *                    active representative_authorities
 *   externalUid    — global profile linked to the test participant via
 *                    an active external_disclosure_grants row
 *   noRoleUid      — auth.users row, no global_profiles row: used for
 *                    negative tests against members of a different org
 *
 * Identity migration: each legacy-style fixture inserts directly into
 * global_profiles and organisation_memberships (bypassing the legacy
 * `profiles` table since 0004 is applied AFTER 0003). This avoids the
 * migration logic and keeps tests focused on RLS / RPC behaviour.
 */
import type { Executor } from "./harness";

export type Fixture = {
  orgId: string;
  adminUid: string;
  schedulerUid: string;
  workerAUid: string;
  workerBUid: string;
  participantUid: string;
  representerUid: string;
  externalUid: string;
  noRoleUid: string;
  participantId: string;
  shiftId: string;
  version: number;
};

export const TEST_TS = new Date("2026-08-07T09:00:00.000Z");

export async function seedStandardFixture(ex: Executor): Promise<Fixture> {
  // Generate UUIDs once so we can refer to them across statements.
  const ids = {
    org: cryptoUUID(),
    admin: cryptoUUID(),
    scheduler: cryptoUUID(),
    workerA: cryptoUUID(),
    workerB: cryptoUUID(),
    participant: cryptoUUID(),
    representer: cryptoUUID(),
    external: cryptoUUID(),
    norole: cryptoUUID(),
    participantRow: cryptoUUID(),
    shift: cryptoUUID(),
    membershipAdmin: cryptoUUID(),
    membershipScheduler: cryptoUUID(),
    membershipWorkerA: cryptoUUID(),
    membershipWorkerB: cryptoUUID(),
    selfLink: cryptoUUID(),
    repAuthority: cryptoUUID(),
    externalGrant: cryptoUUID(),
    assignmentA: cryptoUUID(),
    shiftVersion: 1,
  };

  // Insert auth.users for each identity (FK target of global_profiles).
  const authRows: Array<[string, string]> = [
    [ids.admin, "admin@test.example"],
    [ids.scheduler, "scheduler@test.example"],
    [ids.workerA, "worker-a@test.example"],
    [ids.workerB, "worker-b@test.example"],
    [ids.participant, "participant@test.example"],
    [ids.representer, "representer@test.example"],
    [ids.external, "external@test.example"],
    [ids.norole, "norole@test.example"],
  ];
  await ex.execAsService(
    `insert into auth.users (id, email) values ${authRows
      .map(([id, e]) => `('${id}','${e}')`)
      .join(",")}`,
  );

  // Organisation.
  await ex.execAsService(
    `insert into public.organisations (id, name, slug) values
       ('${ids.org}', 'Test Org', 'test-org')`,
  );

  // Global profiles.
  const profileRows: Array<[string, string, string]> = [
    [ids.admin, "Alice Admin", "admin@test.example"],
    [ids.scheduler, "Sam Scheduler", "scheduler@test.example"],
    [ids.workerA, "Wendy WorkerA", "worker-a@test.example"],
    [ids.workerB, "Bill WorkerB", "worker-b@test.example"],
    [ids.participant, "Pat Participant", "participant@test.example"],
    [ids.representer, "Rita Rep", "representer@test.example"],
    [ids.external, "Eli External", "external@test.example"],
  ];
  for (const [id, name, email] of profileRows) {
    await ex.execAsService(
      `insert into public.global_profiles (id, full_name, email)
       values ('${id}','${escape(name)}','${email}')
       on conflict (id) do update
         set full_name = excluded.full_name,
             email = excluded.email`,
    );
  }
  // norole deliberately has no global_profiles row.

  // Memberships.
  await ex.execAsService(
    `insert into public.organisation_memberships
       (id, organisation_id, profile_id, role, status, effective_from)
     values
       ('${ids.membershipAdmin}',    '${ids.org}', '${ids.admin}',     'admin',     'active', now()),
       ('${ids.membershipScheduler}','${ids.org}', '${ids.scheduler}', 'scheduler', 'active', now()),
       ('${ids.membershipWorkerA}',  '${ids.org}', '${ids.workerA}',   'worker',    'active', now()),
       ('${ids.membershipWorkerB}',  '${ids.org}', '${ids.workerB}',   'worker',    'active', now())`,
  );

  // Active context for all four (so the helper picks the test org).
  for (const uid of [
    ids.admin,
    ids.scheduler,
    ids.workerA,
    ids.workerB,
  ]) {
    await ex.execAsService(
      `insert into public.active_organisation_context (profile_id, organisation_id)
       values ('${uid}','${ids.org}')`,
    );
  }

  // Participant + self-link + rep auth + external grant.
  await ex.execAsService(
    `insert into public.participants (id, organisation_id, first_name, last_initial, created_by)
     values ('${ids.participantRow}','${ids.org}','Maya','R','${ids.admin}')`,
  );

  await ex.execAsService(
    `insert into public.participant_self_links
       (id, organisation_id, participant_id, profile_id, status, evidence_reference)
     values
       ('${ids.selfLink}','${ids.org}','${ids.participantRow}','${ids.participant}','active','self-attested')`,
  );

  await ex.execAsService(
    `insert into public.representative_authorities
       (id, organisation_id, participant_id, representative_profile_id, authority_type, scope_categories, effective_from)
     values
       ('${ids.repAuthority}',
        '${ids.org}',
        '${ids.participantRow}',
        '${ids.representer}',
        'plan_nominee',
        array['upcoming_visits','service_summary']::text[],
        now())`,
  );

  await ex.execAsService(
    `insert into public.external_disclosure_grants
       (id, organisation_id, participant_id, recipient_profile_id, purpose,
        scope_categories, consent_basis, consent_reference, effective_from, effective_until)
     values
       ('${ids.externalGrant}',
        '${ids.org}',
        '${ids.participantRow}',
        '${ids.external}',
        'referral-feedback',
        array['service_summary']::text[],
        'participant',
        'consent-001',
        now(),
        now() + interval '30 days')`,
  );

  // Shift scheduled in the next hour.
  const start = isoTime(TEST_TS.getTime() + 60 * 60 * 1000);
  const end = isoTime(TEST_TS.getTime() + 2 * 60 * 60 * 1000);

  await ex.execAsService(
    `insert into public.shifts (id, organisation_id, participant_id, scheduled_start, scheduled_end, state, version)
     values ('${ids.shift}','${ids.org}','${ids.participantRow}','${start}','${end}','scheduled',${ids.shiftVersion})`,
  );

  await ex.execAsService(
    `insert into public.shift_assignments
       (id, shift_id, organisation_id, membership_id, assigned_by)
     values
       ('${ids.assignmentA}','${ids.shift}','${ids.org}','${ids.membershipWorkerA}','${ids.admin}')`,
  );

  return {
    orgId: ids.org,
    adminUid: ids.admin,
    schedulerUid: ids.scheduler,
    workerAUid: ids.workerA,
    workerBUid: ids.workerB,
    participantUid: ids.participant,
    representerUid: ids.representer,
    externalUid: ids.external,
    noRoleUid: ids.norole,
    participantId: ids.participantRow,
    shiftId: ids.shift,
    version: ids.shiftVersion,
  };
}

export async function seedOrgAInactiveMemberships(ex: Executor): Promise<{
  orgBId: string;
  otherOrgWorkerUid: string;
}> {
  const orgB = cryptoUUID();
  const otherWorker = cryptoUUID();
  const otherMembership = cryptoUUID();

  await ex.execAsService(
    `insert into auth.users (id, email) values ('${otherWorker}','other@test.example')`,
  );
  await ex.execAsService(
    `insert into public.organisations (id, name, slug) values
       ('${orgB}','Other Org','other-org')`,
  );
  await ex.execAsService(
    `insert into public.global_profiles (id, full_name, email)
     values ('${otherWorker}','Other','other@test.example')
     on conflict (id) do update set full_name = excluded.full_name,
       email = excluded.email`,
  );
  await ex.execAsService(
    `insert into public.organisation_memberships
       (id, organisation_id, profile_id, role, status, effective_from)
     values ('${otherMembership}','${orgB}','${otherWorker}','admin','active', now())`,
  );
  await ex.execAsService(
    `insert into public.active_organisation_context (profile_id, organisation_id)
     values ('${otherWorker}','${orgB}')`,
  );

  return { orgBId: orgB, otherOrgWorkerUid: otherWorker };
}

function cryptoUUID(): string {
  // RFC 4122 v4 UUID. Avoid importing node:crypto at module scope.
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function isoTime(t: number): string {
  return new Date(t).toISOString();
}

function escape(s: string): string {
  return s.replaceAll("'", "''");
}
