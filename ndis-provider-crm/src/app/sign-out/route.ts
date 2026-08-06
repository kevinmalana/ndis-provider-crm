import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  const origin = new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/sign-in`, { status: 303 });
}