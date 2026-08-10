import { redirect } from "next/navigation";

import { loadMembershipContext } from "@/lib/membership";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminWorkspace } from "./workspace-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const ctx = await loadMembershipContext();
  if (ctx.kind !== "ready" || !ctx.active) redirect("/app");
  if (!(["admin", "scheduler"] as string[]).includes(ctx.active.role)) redirect("/app");

  const supabase = await createSupabaseServerClient();
  const organisationId = ctx.active.organisation_id;
  const [participants, cards, memberships, shifts, assignments, authorities, grants, availability, audit] = await Promise.all([
    supabase.from("participants").select("id,first_name,last_initial,created_at").eq("organisation_id", organisationId).is("archived_at", null).order("created_at", { ascending: false }),
    supabase.from("critical_info_cards").select("id,participant_id,content_text,reviewed_at,review_due_at,status").eq("organisation_id", organisationId).eq("status", "active"),
    supabase.from("organisation_memberships").select("id,profile_id,role,status,effective_from").eq("organisation_id", organisationId).eq("status", "active").order("role"),
    supabase.from("shifts").select("id,participant_id,scheduled_start,scheduled_end,state,version").eq("organisation_id", organisationId).order("scheduled_start"),
    supabase.from("shift_assignments").select("id,shift_id,membership_id,effective_from,effective_until,withdrawn_at,reassignment_reason").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("representative_authorities").select("id,participant_id,representative_profile_id,authority_type,scope_categories,evidence_reference,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("external_disclosure_grants").select("id,participant_id,recipient_profile_id,purpose,scope_categories,consent_basis,evidence_reference,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("worker_availability").select("id,membership_id,available_during,note,created_at").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("audit_log").select("id,action,subject_type,subject_id,metadata,created_at,actor").eq("organisation_id", organisationId).order("created_at", { ascending: false }).limit(50),
  ]);

  return (
    <AdminWorkspace
      organisation={{ id: organisationId, name: ctx.active.organisation_name, role: ctx.active.role }}
      initialData={{
        participants: participants.data ?? [],
        cards: cards.data ?? [],
        memberships: memberships.data ?? [],
        shifts: shifts.data ?? [],
        assignments: assignments.data ?? [],
        authorities: authorities.data ?? [],
        grants: grants.data ?? [],
        availability: availability.data ?? [],
        audit: audit.data ?? [],
      }}
    />
  );
}
