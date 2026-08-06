"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Invisible client component mounted on the invite landing page. When
 * Supabase redirects a magic-link click to /invite/<token> the access
 * and refresh tokens arrive in the URL fragment (implicit grant).
 * Server components can't read fragments, so we let supabase-js
 * establish the session client-side and then forward to /app.
 *
 * Renders nothing.
 */
export function InviteFragmentHandler({ token }: { token: string }) {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const hash = window.location.hash;
    if (!hash || !hash.includes("access_token")) return;
    handled.current = true;

    const supabase = createSupabaseBrowserClient();
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (data.session) {
          const { error } = await supabase.rpc("cmd_accept_invitation", {
            p_token: token,
          });
          router.replace(error ? `/invite/${encodeURIComponent(token)}/expired` : "/app");
        } else {
          router.replace("/sign-in?error=invalid");
        }
      })
      .catch(() => {
        router.replace("/sign-in?error=invalid");
      });
  }, [router, token]);

  return null;
}
