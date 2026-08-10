import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { InviteFragmentHandler } from "./fragment-handler";

export const dynamic = "force-dynamic";

interface InvitationView {
  email: string;
  role: string;
  organisation_name: string;
  organisation_slug: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  organisation_deleted: boolean;
}

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
}

async function loadInvitation(token: string): Promise<InvitationView | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("get_invitation_view", {
    p_token: token,
  });
  if (error || !data) return null;
  const rows = Array.isArray(data) ? data : [data];
  return (rows[0] ?? null) as InvitationView | null;
}

function ExpiredView() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Invitation no longer valid</CardTitle>
          <CardDescription>
            This invitation link can&rsquo;t be used. It may have expired,
            been revoked, or its organisation was removed.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <p className="text-sm text-muted-foreground">
            Please ask the person who invited you to issue a fresh link.
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}

function AcceptedView({ acceptedAt }: { acceptedAt: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Invitation already used</CardTitle>
          <CardDescription>
            This invitation was accepted on{" "}
            {new Date(acceptedAt).toLocaleString()}.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <p className="text-sm text-muted-foreground">
            If this wasn&rsquo;t you, please contact your administrator.
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}

function SentView({
  email,
  organisation,
}: {
  email: string;
  organisation: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a sign-in link to <strong>{email}</strong>. Click it to
            accept your invitation and join {organisation}.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}

function ValidView({
  token,
  email,
  role,
  organisation,
  sendError,
}: {
  token: string;
  email: string;
  role: string;
  organisation: string;
  sendError: boolean;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>You&rsquo;re invited to join {organisation}</CardTitle>
          <CardDescription>
            An administrator has invited you to sign in as{" "}
            <strong>{role}</strong> using the email{" "}
            <strong>{email}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Accepting will email you a one-time sign-in link. Click it to
            finish joining {organisation}.
          </p>
          {sendError ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              The sign-in email could not be sent. Please wait a moment and
              try again.
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <form
            action={`/invite/${encodeURIComponent(token)}/confirm`}
            method="POST"
            className="w-full"
          >
            <Button type="submit" className="w-full">
              Accept invitation
            </Button>
          </form>
        </CardFooter>
      </Card>
    </main>
  );
}

export default async function InvitePage({
  params,
  searchParams,
}: PageProps) {
  const { token } = await params;
  const { sent, error } = await searchParams;

  const view = await loadInvitation(token);
  // Server component, runs once per request — Date.now() is fine here
  // even though the React purity rule flags it.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  if (!view) {
    return <ExpiredView />;
  }

  if (view.accepted_at) {
    return <AcceptedView acceptedAt={view.accepted_at} />;
  }

  if (view.revoked_at || view.organisation_deleted) {
    return <ExpiredView />;
  }

  if (new Date(view.expires_at).getTime() <= now) {
    return <ExpiredView />;
  }

  if (sent) {
    return (
      <>
        <InviteFragmentHandler token={token} />
        <SentView email={view.email} organisation={view.organisation_name} />
      </>
    );
  }

  return (
    <>
      <InviteFragmentHandler token={token} />
      <ValidView
        token={token}
        email={view.email}
        role={view.role}
        organisation={view.organisation_name}
        sendError={error === "email"}
      />
    </>
  );
}
