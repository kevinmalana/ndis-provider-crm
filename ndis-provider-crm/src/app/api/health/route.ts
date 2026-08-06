import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from("organisations")
      .select("id")
      .limit(1);

    return NextResponse.json({
      ok: true,
      supabase: error === null,
    });
  } catch {
    return NextResponse.json({
      ok: true,
      supabase: false,
    });
  }
}