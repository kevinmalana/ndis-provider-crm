import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadMembershipContext } from "@/lib/membership";
import { ActiveOrganisationSwitcher } from "@/components/layout/active-organisation-switcher";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  const ctx = await loadMembershipContext();

  const greeting =
    ctx.kind === "ready"
      ? ctx.profile.full_name?.trim() ||
        ctx.profile.email ||
        userData.user?.email ||
        "there"
      : userData.user?.email || "there";

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {greeting}
        </h1>
        <p className="text-sm text-muted-foreground">
          You are signed in. Admin, worker, participant, and external
          surfaces land in their own tickets. The header above shows your
          active organisation and role.
        </p>
      </header>

      {ctx.kind === "ready" ? (
        <ActiveOrganisationSwitcher
          memberships={ctx.memberships.map((m) => ({
            id: m.organisation_id,
            name: m.organisation_name,
            role: m.role,
          }))}
          activeId={ctx.active?.organisation_id ?? null}
        />
      ) : null}
    </section>
  );
}