"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();

  function onClick() {
    void fetch("/sign-out", { method: "POST" })
      .then(() => {
        router.push("/sign-in");
        router.refresh();
      })
      .catch(() => {
        toast.error("Could not sign you out. Please try again.");
      });
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      Sign out
    </Button>
  );
}