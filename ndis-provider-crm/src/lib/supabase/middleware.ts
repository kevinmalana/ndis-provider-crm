import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { getSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase session cookies on every non-static request.
 *
 * Returns the (possibly rewritten) response so the proxy can attach any
 * cookies the Supabase client wrote back to the browser.
 *
 * The session is loaded lazily inside `getUser()`. If the access token
 * is expired, Supabase uses the refresh token from the cookie to mint a
 * new one and write it back via the `setAll` callback below.
 *
 * NOTE: this is the proxy/proxy.ts collaborator, not a server-component
 * helper. It deliberately uses `request.cookies` (the inbound cookies)
 * and writes back onto the response, not `next/headers` cookies — those
 * are unavailable inside proxy.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Mirror cookies onto the request so downstream Server Components
        // see the refreshed session.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // Re-derive the response so the new request headers take effect
        // for any downstream proxy/handler chain, then write the cookies
        // back onto the response that goes to the browser.
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touch the session. Per the SSR guide, getUser() is the right call
  // here because it validates the JWT against the Supabase Auth server
  // (rather than trusting the cookie contents).
  await supabase.auth.getUser();

  return response;
}