import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const organisationId =
    typeof body === "object" &&
    body !== null &&
    "organisation_id" in body &&
    typeof (body as { organisation_id: unknown }).organisation_id === "string"
      ? (body as { organisation_id: string }).organisation_id
      : null;
  if (!organisationId) {
    return NextResponse.json({ error: "missing_organisation_id" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_active_organisation", {
    p_organisation_id: organisationId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
