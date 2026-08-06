import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function InvitationExpiredPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Invitation expired</CardTitle>
          <CardDescription>
            This invitation link is no longer valid. It may have expired,
            been revoked, or already been used.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Please ask the person who invited you to issue a fresh
            invitation.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}