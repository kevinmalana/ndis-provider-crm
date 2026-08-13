import Link from "next/link";

import { loadWorkerToday } from "@/lib/worker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function statusLabel(state: string): string {
  switch (state) {
    case "scheduled":
      return "Scheduled";
    case "in_transit":
      return "On my way";
    case "started":
      return "Started";
    case "ended_summary_required":
      return "Summary required";
    case "finalised":
      return "Finalised";
    case "needs_review":
      return "Needs review";
    case "urgent_provider_review":
      return "Urgent provider review";
    default:
      return state.replaceAll("_", " ");
  }
}

export const dynamic = "force-dynamic";

export default async function WorkerTodayPage() {
  const shifts = await loadWorkerToday();
  const routeBlocked = shifts.some((shift) => !shift.has_emergency_route || !shift.has_incident_route);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Phone-first online worker flow</p>
        <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
        <p className="text-sm text-muted-foreground">
          Only current-day assigned, service-ready shifts appear here. Full address and access instructions stay inside the assigned detail view.
        </p>
      </header>

      {routeBlocked ? (
        <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm" role="status">
          Provider urgent-contact configuration is incomplete. `000` stays visible, but delivery actions remain disabled until current emergency and incident routes exist.
        </div>
      ) : null}

      {shifts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No current-day assigned work</CardTitle>
            <CardDescription>The worker flow only lists today&apos;s assigned service-ready shifts.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-3">
          {shifts.map((shift) => (
            <Link key={shift.shift_id} href={`/worker/${shift.shift_id}`} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="transition hover:border-primary/40 hover:bg-muted/20">
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold">{shift.participant_first_name}</p>
                      <p className="text-sm text-muted-foreground">{shift.location_hint}</p>
                    </div>
                    <span className="rounded-full border px-2 py-1 text-xs font-medium">
                      {statusLabel(shift.state)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>
                      {new Date(shift.scheduled_start).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })} –{" "}
                      {new Date(shift.scheduled_end).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {!shift.has_emergency_route || !shift.has_incident_route ? (
                      <span className="font-medium text-warning-foreground">Urgent contact setup missing</span>
                    ) : (
                      <span>Open assigned details</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
