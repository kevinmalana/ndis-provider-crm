import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/layout/sign-out-button";
import { loadMembershipContext } from "@/lib/membership";

export const dynamic = "force-dynamic";

export default async function WorkerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await loadMembershipContext();
  if (ctx.kind !== "ready" || !ctx.active) {
    redirect("/app");
  }
  if (ctx.active.role !== "worker") {
    redirect("/app");
  }

  const displayName =
    ctx.profile.full_name?.trim() ||
    ctx.profile.email ||
    "Worker";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{ctx.active.organisation_name}</p>
            <p className="text-xs text-muted-foreground">Worker · {displayName}</p>
          </div>
          <div className="flex items-center gap-2">
            <Link className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" href="/app">
              App home
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-4xl px-4 py-6">{children}</div>
    </div>
  );
}
