export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set. Copy .env.example to .env.local and fill in the values.",
    );
  }
  if (!anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Copy .env.example to .env.local and fill in the values.",
    );
  }

  return { url, anonKey };
}
