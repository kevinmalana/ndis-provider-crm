import "server-only";

import { getSupabasePublicEnv } from "./env-public";

export interface SupabaseServerEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export function getSupabaseServerEnv(): SupabaseServerEnv {
  const publicEnv = getSupabasePublicEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Copy .env.example to .env.local and fill in the values.",
    );
  }

  return { ...publicEnv, serviceRoleKey };
}
