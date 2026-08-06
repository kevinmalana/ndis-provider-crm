import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();

  if (data.user) {
    redirect("/app");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <header className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Sign in to NDIS Provider CRM
          </h1>
          <p className="text-sm text-muted-foreground">
            We&rsquo;ll email you a one-time sign-in link.
          </p>
        </header>
        <SignInForm />
      </div>
    </main>
  );
}