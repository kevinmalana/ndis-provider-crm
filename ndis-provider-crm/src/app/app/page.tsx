import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, role")
    .eq("id", userData.user?.id ?? "")
    .is("deleted_at", null)
    .maybeSingle();

  const greeting =
    profile?.full_name?.trim() || profile?.email || userData.user?.email || "there";
  const role = profile?.role ?? "member";

  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome, {greeting}
      </h1>
      <p className="text-sm text-muted-foreground">
        You&rsquo;re signed in as <strong>{role}</strong>. Admin, worker,
        participant, and external surfaces land in their own tickets.
      </p>
    </section>
  );
}