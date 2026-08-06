import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/layout/sign-out-button";
import { loadMembershipContext } from "@/lib/membership";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();

  if (!userData.user) {
    redirect("/sign-in?next=/app");
  }

  const ctx = await loadMembershipContext();

  if (ctx.kind === "no-user") {
    redirect("/sign-in?next=/app");
  }
  if (ctx.kind === "no-profile" || ctx.kind === "no-membership") {
    redirect("/no-invitation");
  }

  const displayName =
    ctx.profile.full_name?.trim() ||
    ctx.profile.email ||
    userData.user.email ||
    "there";

  const active = ctx.active;
  const orgLabel = active?.organisation_name ?? "No active organisation";
  const roleLabel = active?.role ?? "—";
  const multi = ctx.memberships.length > 1;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">
              {orgLabel}
              {multi ? (
                <span className="ml-2 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {ctx.memberships.length} memberships
                </span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">
              Signed in as {displayName} · role {roleLabel}
            </p>
          </div>
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-8">{children}</div>
    </div>
  );
}