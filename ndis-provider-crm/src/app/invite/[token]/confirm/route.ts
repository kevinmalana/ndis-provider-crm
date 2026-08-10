import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface InvitationView {
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  organisation_deleted: boolean;
}

async function loadInvitation(token: string): Promise<InvitationView | null> {
  // Use the admin client here because the visitor may not be signed in
  // yet, so the RLS-protected invitations table is not readable via the
  // anonymous key. get_invitation_view is security-definer and explicitly
  // grants anon + authenticated, so this is safe.
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("get_invitation_view", {
    p_token: token,
  });
  if (error || !data) return null;
  const rows = Array.isArray(data) ? data : [data];
  return (rows[0] ?? null) as InvitationView | null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const origin = new URL(request.url).origin;

  const view = await loadInvitation(token);
  const now = Date.now();
  if (!view) {
    return NextResponse.redirect(
      `${origin}/invite/${encodeURIComponent(token)}/expired`,
      { status: 303 },
    );
  }

  if (
    view.accepted_at ||
    view.revoked_at ||
    view.organisation_deleted ||
    new Date(view.expires_at).getTime() <= now
  ) {
    return NextResponse.redirect(
      `${origin}/invite/${encodeURIComponent(token)}/expired`,
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("invitation", token);
  callbackUrl.searchParams.set("next", "/app");

  const { error: otpError } = await supabase.auth.signInWithOtp({
    email: view.email,
    options: {
      emailRedirectTo: callbackUrl.toString(),
    },
  });

  if (otpError) {
    return NextResponse.redirect(
      `${origin}/invite/${encodeURIComponent(token)}?error=email`,
      { status: 303 },
    );
  }

  return NextResponse.redirect(
    `${origin}/invite/${encodeURIComponent(token)}?sent=1`,
    { status: 303 },
  );
}
