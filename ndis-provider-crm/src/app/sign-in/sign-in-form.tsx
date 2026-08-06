"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${appUrl}/auth/callback`,
        },
      });
      if (otpError) {
        setError("Could not send the sign-in link. Please try again.");
        setPending(false);
        return;
      }
      setSent(true);
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a sign-in link to <strong>{email}</strong>. The link
            will sign you in and take you to your dashboard.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Use the email your provider administrator invited you with.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "sign-in-error" : undefined}
              placeholder="you@example.com"
            />
          </div>
          {error ? (
            <p
              id="sign-in-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            disabled={pending || email.length === 0}
            className="w-full"
          >
            {pending ? "Sending link…" : "Send sign-in link"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}