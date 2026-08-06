import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bootTestDb } from "./harness";

const UUID = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  org: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  membership: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

async function seedContext() {
  const ex = await bootTestDb();
  await ex.execAsService(
    `insert into auth.users (id, email) values ('${UUID.user}', 'worker@demo.synthetic')`,
  );
  await ex.execAsService(
    `insert into public.organisations (id, name, slug) values ('${UUID.org}', 'Synthetic', 'synthetic-org')`,
  );
  await ex.execAsService(
    `insert into public.global_profiles (id, email) values ('${UUID.user}', 'worker@demo.synthetic') on conflict (id) do nothing`,
  );
  await ex.execAsService(
    `insert into public.organisation_memberships (id, organisation_id, profile_id, role, status)
     values ('${UUID.membership}', '${UUID.org}', '${UUID.user}', 'worker', 'active')`,
  );
  return ex;
}

describe("synthetic seed transaction contract", () => {
  it("is service-role-only and fail-closed", async () => {
    const ex = await seedContext();
    ex.setUser(UUID.user);
    await expect(
      ex.exec(`select public.seed_synthetic_demo('${UUID.membership}')`),
    ).rejects.toThrow();
  });

  it("is deterministic and idempotent on rerun", async () => {
    const ex = await seedContext();
    const first = await ex.execAsService(
      `select public.seed_synthetic_demo('${UUID.membership}') as result`,
    );
    const second = await ex.execAsService(
      `select public.seed_synthetic_demo('${UUID.membership}') as result`,
    );
    expect((first.rows[0] as { result: { deterministic: boolean } }).result.deterministic).toBe(true);
    expect((second.rows[0] as { result: { transactional: boolean } }).result.transactional).toBe(true);
    const counts = await ex.execAsService(
      `select
         (select count(*) from public.participants where organisation_id = '${UUID.org}')::int as participants,
         (select count(*) from public.shifts where organisation_id = '${UUID.org}')::int as shifts,
         (select count(*) from public.shift_assignments where organisation_id = '${UUID.org}')::int as assignments`,
    );
    expect(counts.rows[0]).toMatchObject({ participants: 3, shifts: 3, assignments: 3 });
  });

  it("rolls back earlier rows when a later deterministic row fails", async () => {
    const ex = await seedContext();
    const conflictId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await ex.execAsService(
      `insert into public.participants (id, organisation_id, first_name, last_initial)
       values ('${conflictId}', '${UUID.org}', 'Test Beta', 'S')`,
    );
    await expect(
      ex.execAsService(`select public.seed_synthetic_demo('${UUID.membership}')`),
    ).rejects.toThrow();
    const rows = await ex.execAsService(
      `select count(*)::int as c from public.participants where organisation_id = '${UUID.org}' and first_name = 'Test Alpha'`,
    );
    expect((rows.rows[0] as { c: number }).c).toBe(0);
  });

  it("keeps the script as a guard plus one transactional RPC call", () => {
    const script = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/seed-synthetic.ts"),
      "utf8",
    );
    expect(script).toContain('SUPABASE_SYNTHETIC_SEED !== "true"');
    expect(script).toContain('SUPABASE_PROJECT_ENV !== "development"');
    expect(script).toContain('admin.rpc("seed_synthetic_demo"');
    expect(script).not.toContain('.from("participants").insert');
    expect(script).not.toContain('.from("shifts").insert');
  });
});

