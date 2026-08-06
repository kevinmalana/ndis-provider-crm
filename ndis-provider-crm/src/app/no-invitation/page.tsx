import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NoInvitationPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>No active invitation</CardTitle>
          <CardDescription>
            You&rsquo;re signed in but we couldn&rsquo;t find an invitation
            for your email. Access to the platform is invite-only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Please contact the administrator of the organisation you were
            expecting to join and ask them to issue a fresh invitation.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}