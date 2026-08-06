import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/layout/sign-out-button";
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, organisation_id")
    .eq("id", userData.user.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!profile) {
    redirect("/no-invitation");
  }

  const { data: organisation } = await supabase
    .from("organisations")
    .select("id, name, slug")
    .eq("id", profile.organisation_id)
    .is("deleted_at", null)
    .maybeSingle();

  const displayName =
    profile.full_name?.trim() || profile.email || userData.user.email || "there";
  const orgLabel = organisation?.name ?? "your organisation";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">{orgLabel}</p>
            <p className="text-xs text-muted-foreground">
              Signed in as {displayName}
            </p>
          </div>
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-8">{children}</div>
    </div>
  );
}