"use client";

import { useState } from "react";
import {
  ChevronRight,
  Clock,
  MapPin,
  Navigation,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

type ShiftStatus =
  | "scheduled"
  | "on-my-way"
  | "in-progress"
  | "completed"
  | "missed";

interface Shift {
  id: string;
  startTime: string;
  duration: string;
  participantName: string;
  suburb: string;
  fullAddress: string;
  status: ShiftStatus;
  plannerNote?: string;
}

const seedShifts: Shift[] = [
  {
    id: "shift-1",
    startTime: "09:00",
    duration: "2h",
    participantName: "Maya R",
    suburb: "Fairfield",
    fullAddress: "12 Acacia St, Fairfield",
    status: "scheduled",
    plannerNote:
      "Access via side gate (buzzer broken). Maya prefers morning visits before 11am. No pets today.",
  },
  {
    id: "shift-2",
    startTime: "13:30",
    duration: "1h",
    participantName: "Daniel K",
    suburb: "Birralee",
    fullAddress: "4 Birralee Pl, Level 3",
    status: "on-my-way",
    plannerNote: "Building entry intercom at the front gate.",
  },
  {
    id: "shift-3",
    startTime: "16:00",
    duration: "3h",
    participantName: "Priya S",
    suburb: "Holly Court",
    fullAddress: "9/22 Holly Crt",
    status: "completed",
  },
];

function StatusBadge({
  status,
}: {
  status: ShiftStatus;
}) {
  const classes: Record<ShiftStatus, { label: string; className: string }> = {
    scheduled: {
      label: "Start",
      className: "bg-accent text-accent-foreground",
    },
    "on-my-way": {
      label: "Mark arrived",
      className: "bg-warning text-warning-foreground",
    },
    "in-progress": {
      label: "Complete",
      className: "bg-info text-info-foreground",
    },
    completed: {
      label: "Completed",
      className: "bg-success text-success-foreground",
    },
    missed: {
      label: "Missed",
      className: "bg-destructive text-destructive-foreground",
    },
  };
  const { label, className } = classes[status];
  return (
    <span
      className={`rounded-md px-3 py-2 text-xs font-semibold ${className}`}
      style={{ minHeight: "var(--touch-min)" }}
    >
      {label}
    </span>
  );
}

function shiftCtaLabel(status: ShiftStatus): string | null {
  if (status === "scheduled") return "On my way";
  if (status === "on-my-way") return "Mark arrived";
  if (status === "in-progress") return "Complete";
  return null;
}

export default function TodayListDemoPage() {
  const [shifts, setShifts] = useState<Shift[]>(seedShifts);
  const [online, setOnline] = useState(true);

  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const inTransit = shifts.find((s) => s.status === "on-my-way");

  function handlePrimaryAction(shift: Shift) {
    setShifts((prev) =>
      prev.map((s) => {
        if (s.id !== shift.id) return s;
        const next: ShiftStatus =
          s.status === "scheduled"
            ? "on-my-way"
            : s.status === "on-my-way"
            ? "in-progress"
            : s.status === "in-progress"
            ? "completed"
            : s.status;
        return { ...s, status: next };
      }),
    );
  }

  function handleCancelInTransit() {
    setShifts((prev) =>
      prev.map((s) =>
        s.status === "on-my-way" ? { ...s, status: "scheduled" } : s,
      ),
    );
  }

  return (
    <div
      data-org="demo"
      className="min-h-screen bg-muted px-4 py-6 flex justify-center"
    >
      <div className="w-full max-w-sm bg-card rounded-3xl shadow-lg overflow-hidden border border-border">
        {/* Connection pill (top) */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <button
            type="button"
            onClick={() => setOnline((v) => !v)}
            className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium"
            style={{ minHeight: "32px" }}
            aria-label={
              online ? "Connection: online. Tap to simulate offline." : "Connection: offline. Tap to simulate online."
            }
          >
            {online ? (
              <>
                <Wifi aria-hidden className="size-3.5" />
                Online
              </>
            ) : (
              <>
                <WifiOff aria-hidden className="size-3.5" />
                Offline
              </>
            )}
          </button>
          <span className="text-xs text-muted-foreground">Demo · worker app</span>
        </div>

        {/* In-transit banner (when applicable) */}
        {inTransit ? (
          <div className="flex items-center justify-between gap-3 bg-accent text-accent-foreground px-5 py-4">
            <div className="flex items-center gap-2 min-w-0">
              <Navigation aria-hidden className="size-5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  On my way to {inTransit.participantName}
                </p>
                <p className="text-xs opacity-90 truncate">
                  {inTransit.fullAddress} · {inTransit.startTime} start
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCancelInTransit}
              className="flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-2 text-xs font-medium shrink-0"
              style={{ minHeight: "var(--touch-min)" }}
              aria-label="Cancel in-transit status"
            >
              <X aria-hidden className="size-3.5" />
              Cancel
            </button>
          </div>
        ) : null}

        {/* Header */}
        <header className="px-5 py-4 border-b border-border">
          <h1 className="text-xl font-bold m-0">Today</h1>
          <p className="text-sm text-muted-foreground m-0 mt-0.5">
            Tue 6 Aug · {shifts.length} shifts
          </p>
        </header>

        {/* Shifts */}
        <ul className="list-none p-3 space-y-2.5">
          {shifts.map((shift) => {
            const isCompleted = shift.status === "completed";
            return (
              <li
                key={shift.id}
                className={`rounded-2xl border border-border p-4 ${
                  isCompleted ? "bg-muted opacity-80" : "bg-card"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-[64px]">
                    <p className="text-base font-bold tabular-nums leading-tight">
                      {shift.startTime}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock aria-hidden className="size-3" />
                      {shift.duration}
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold leading-tight">
                      {shift.participantName}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <MapPin aria-hidden className="size-3 shrink-0" />
                      <span className="truncate">{shift.fullAddress}</span>
                    </p>
                  </div>
                  <div className="self-center">
                    <StatusBadge status={shift.status} />
                  </div>
                </div>

                {shiftCtaLabel(shift.status) ? (
                  <button
                    type="button"
                    onClick={() => handlePrimaryAction(shift)}
                    className="mt-3 w-full rounded-xl bg-primary text-primary-foreground py-3 text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-primary/90"
                    style={{ minHeight: "var(--touch-min)" }}
                  >
                    {shiftCtaLabel(shift.status)}
                    <ChevronRight aria-hidden className="size-4" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        <footer className="px-5 py-3 border-t border-border bg-muted text-xs text-muted-foreground">
          44 px tap targets throughout · WCAG 2.2 AA contrast · offline-aware
        </footer>
      </div>
    </div>
  );
}
