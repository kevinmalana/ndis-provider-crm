"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Supabase magic links deliver the access/refresh tokens in the URL
 * fragment (`#access_token=…&refresh_token=…`). Fragments are NOT sent
 * to the server, so this page has to run client-side and let
 * supabase-js parse them.
 *
 * With `detectSessionInUrl: true` (the default), constructing the
 * browser client with the URL containing the fragment is enough — the
 * session is detected and `getSession()` returns it on the next tick.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState<"pending" | "ok" | "invalid">(
    "pending",
  );

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (data.session) {
          setStatus("ok");
          const next = new URL(window.location.href).searchParams.get(
            "next",
          );
          router.replace(next && next.startsWith("/") ? next : "/app");
        } else {
          setStatus("invalid");
          router.replace("/sign-in?error=invalid");
        }
      })
      .catch(() => {
        setStatus("invalid");
        router.replace("/sign-in?error=invalid");
      });
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {status === "ok"
              ? "Signed in"
              : status === "invalid"
                ? "Could not sign you in"
                : "Signing you in…"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {status === "ok"
              ? "Redirecting to your dashboard."
              : status === "invalid"
                ? "The sign-in link was invalid or has already been used."
                : "Just a moment."}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}