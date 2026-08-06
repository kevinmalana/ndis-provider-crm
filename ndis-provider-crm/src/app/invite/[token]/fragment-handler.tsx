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
export function InviteFragmentHandler() {
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
      .then(({ data }) => {
        if (data.session) {
          router.replace("/app");
        } else {
          router.replace("/sign-in?error=invalid");
        }
      })
      .catch(() => {
        router.replace("/sign-in?error=invalid");
      });
  }, [router]);

  return null;
}