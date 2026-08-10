/**
 * Server-side helpers for the membership-aware app shell.
 *
 * `loadMembershipContext` returns the minimal info the protected app
 * shell needs to render: the user's display name, all their active
 * memberships, the currently-active organisation, and whether the
 * active organisation is set.
 *
 * Sensitive decisions (which organisation, which role) are ALWAYS
 * re-derived server-side. The active_organisation_context cookie /
 * header (if any) is NEVER trusted as authorisation; this helper
 * confirms the caller actually holds an active membership in the org
 * they claim to be acting in.
 */
import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  ActiveOrganisationContext,
  GlobalProfile,
  Organisation,
  OrganisationMembership,
  OrganisationRole,
} from "@/lib/supabase/types.domain";

export type MembershipContext =
  | {
      kind: "no-user";
    }
  | {
      kind: "no-profile";
      email: string | null;
    }
  | {
      kind: "no-membership";
      email: string | null;
    }
  | {
      kind: "ready";
      profile: Pick<GlobalProfile, "id" | "full_name" | "email">;
      memberships: Array<
        Pick<
          OrganisationMembership,
          "id" | "organisation_id" | "role" | "status" | "effective_from"
        > & { organisation_name: string }
      >;
      active: {
        organisation_id: string;
        organisation_name: string;
        role: OrganisationRole;
      } | null;
    };

export async function loadMembershipContext(): Promise<MembershipContext> {
  const supabase = await createSupabaseServerClient();

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return { kind: "no-user" };

  const { data: profile } = await supabase
    .from("global_profiles")
    .select("id, full_name, email")
    .eq("id", user.id)
    .is("deleted_at", null)
    .maybeSingle<Pick<GlobalProfile, "id" | "full_name" | "email">>();

  if (!profile) {
    return { kind: "no-profile", email: user.email ?? null };
  }

  // List the user's memberships. RLS already restricts to profile_id = self.
  const { data: memberships } = await supabase
    .from("organisation_memberships")
    .select(
      "id, organisation_id, role, status, effective_from, organisations!inner(name)",
    )
    .eq("profile_id", user.id)
    .eq("status", "active")
    .order("effective_from", { ascending: true });

  if (!memberships || memberships.length === 0) {
    return {
      kind: "no-membership",
      email: profile.email ?? user.email ?? null,
    };
  }

  // Active context — also RLS-scoped to self.
  const { data: activeContext } = await supabase
    .from("active_organisation_context")
    .select("profile_id, organisation_id")
    .eq("profile_id", user.id)
    .maybeSingle<Pick<ActiveOrganisationContext, "profile_id" | "organisation_id">>();

  const { data: activeOrg } = activeContext
    ? await supabase
        .from("organisations")
        .select("id, name")
        .eq("id", activeContext.organisation_id)
        .is("deleted_at", null)
        .maybeSingle<Pick<Organisation, "id" | "name">>()
    : { data: null };
  const { data: effectiveRole } = activeContext
    ? await supabase.rpc("current_user_membership_role")
    : { data: null };

  const typed = memberships as unknown as Array<
    Pick<
      OrganisationMembership,
      "id" | "organisation_id" | "role" | "status" | "effective_from"
    > & { organisations: { name: string } | null }
  >;

  const flatMemberships = typed.map((m) => ({
    id: m.id,
    organisation_id: m.organisation_id,
    role: m.role,
    status: m.status,
    effective_from: m.effective_from,
    organisation_name: m.organisations?.name ?? "(unnamed organisation)",
  }));

  const active = activeOrg
    ? (() => {
        const match = flatMemberships.find(
          (m) => m.organisation_id === activeOrg.id,
        );
        if (!match) return null;
        return {
          organisation_id: activeOrg.id,
          organisation_name: activeOrg.name,
          role: (effectiveRole as OrganisationRole | null) ?? match.role,
        };
      })()
    : null;

  return {
    kind: "ready",
    profile,
    memberships: flatMemberships,
    active,
  };
}
