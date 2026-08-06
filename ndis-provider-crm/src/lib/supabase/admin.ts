import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseEnv } from "./env";

let adminClient: SupabaseClient | undefined;

export function createSupabaseAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const { url, serviceRoleKey } = getSupabaseEnv();
  adminClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return adminClient;
}