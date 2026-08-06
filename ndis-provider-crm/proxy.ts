import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 renamed middleware.ts to proxy.ts. The proxy runs before
 * every non-static request, refreshes the Supabase session cookies via
 * `getUser()`, and writes any refreshed cookies back to the response.
 *
 * Authentication and authorisation redirects live in each protected
 * layout (e.g. src/app/app/layout.tsx), not here. This file is purely
 * for session-refresh so protected layouts can call `getUser()` cheaply.
 *
 * The matcher excludes static assets and image optimisation paths so
 * the proxy does not run for every CSS / JS / image request.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};