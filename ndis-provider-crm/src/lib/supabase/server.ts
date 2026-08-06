import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseEnv } from "./env";

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, anonKey } = getSupabaseEnv();

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — read-only. Cookie writes must
          // happen in a Server Action or Route Handler. Safe to ignore here;
          // middleware refresh handles session writes for navigations.
        }
      },
    },
  });
}