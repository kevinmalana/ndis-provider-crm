import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/app";
  }
  return value;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const invitationToken = url.searchParams.get("invitation");

  if (!code) {
    return NextResponse.redirect(new URL("/sign-in?error=invalid", url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(new URL("/sign-in?error=invalid", url.origin));
  }

  if (invitationToken) {
    const { error: invitationError } = await supabase.rpc(
      "cmd_accept_invitation",
      { p_token: invitationToken },
    );
    if (invitationError) {
      return NextResponse.redirect(
        new URL(
          `/invite/${encodeURIComponent(invitationToken)}/expired`,
          url.origin,
        ),
      );
    }
  }

  return NextResponse.redirect(
    new URL(safeNext(url.searchParams.get("next")), url.origin),
  );
}
