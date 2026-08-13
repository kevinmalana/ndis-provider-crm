import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadWorkerShiftDetail } from "@/lib/worker";
import { WorkerShiftDetailClient } from "../shift-detail-client";

export const dynamic = "force-dynamic";

export default async function WorkerShiftDetailPage({
  params,
}: {
  params: Promise<{ shiftId: string }>;
}) {
  const { shiftId } = await params;
  const detail = await loadWorkerShiftDetail(shiftId);

  if (detail.kind === "blocked") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Shift unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>{detail.reason}</p>
          <p>
            Immediate danger still uses <strong>000</strong>. For provider follow-up, return to the Today list and contact the office through the approved route.
          </p>
          <Link className="inline-flex rounded-md border px-3 py-2 font-medium hover:bg-muted" href="/worker">
            Back to Today
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <WorkerShiftDetailClient detail={detail} />;
}
