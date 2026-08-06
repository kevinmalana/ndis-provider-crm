"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type Membership = {
  id: string;
  name: string;
  role: string;
};

export function ActiveOrganisationSwitcher({
  memberships,
  activeId,
}: {
  memberships: Membership[];
  activeId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (memberships.length <= 1) {
    const only = memberships[0];
    if (!only) return null;
    return (
      <p className="text-xs text-muted-foreground">
        One active membership: {only.name} ({only.role}).
      </p>
    );
  }

  async function pick(id: string) {
    setPendingId(id);
    try {
      const res = await fetch("/app/active-organisation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisation_id: id }),
      });
      if (!res.ok) throw new Error("switch failed");
      startTransition(() => {
        router.refresh();
      });
      toast.success("Active organisation updated.");
    } catch {
      toast.error("Could not switch organisation.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section
      aria-labelledby="active-org-heading"
      className="rounded-lg border border-border bg-card p-4"
    >
      <h2
        id="active-org-heading"
        className="text-sm font-semibold leading-tight"
      >
        Active organisation
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        You hold more than one membership. Pick which organisation this
        session acts under.
      </p>
      <ul className="mt-4 space-y-2">
        {memberships.map((m) => {
          const isActive = m.id === activeId;
          return (
            <li
              key={m.id}
              className="flex items-center justify-between gap-4 rounded-md border border-border bg-background p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.name}</p>
                <p className="text-xs text-muted-foreground">role {m.role}</p>
              </div>
              {isActive ? (
                <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  Active
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending && pendingId === m.id}
                  onClick={() => pick(m.id)}
                >
                  Switch
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}