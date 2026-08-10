import { redirect } from "next/navigation";

import { loadMembershipContext } from "@/lib/membership";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminWorkspace } from "./workspace-client";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const ctx = await loadMembershipContext();
  if (ctx.kind !== "ready" || !ctx.active) redirect("/app");
  if (!(["admin", "scheduler"] as string[]).includes(ctx.active.role)) redirect("/app");

  const supabase = await createSupabaseServerClient();
  const organisationId = ctx.active.organisation_id;
  const [participants, cards, memberships, shifts, assignments, authorities, grants, consents, availability, audit, identities, selfLinks, serviceContexts, providerScopes, capabilities, catalogues, catalogueItems, roles, screeningPolicies, screeningVerifications, screeningPathways, competenceRequirements, competenceEvidence, maskedIdentifiers, snapshots, ackLedger] = await Promise.all([
    supabase.from("participants").select("id,first_name,last_initial,created_at").eq("organisation_id", organisationId).is("archived_at", null).order("created_at", { ascending: false }),
    supabase.from("critical_info_cards").select("id,participant_id,content_text,reviewed_at,review_due_at,status").eq("organisation_id", organisationId).eq("status", "active"),
    supabase.from("organisation_memberships").select("id,profile_id,role,status,effective_from").eq("organisation_id", organisationId).eq("status", "active").order("role"),
    supabase.from("shifts").select("id,participant_id,scheduled_start,scheduled_end,state,version").eq("organisation_id", organisationId).order("scheduled_start"),
    supabase.from("shift_assignments").select("id,shift_id,membership_id,effective_from,effective_until,withdrawn_at,reassignment_reason").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("representative_authorities").select("id,participant_id,representative_profile_id,authority_type,scope_categories,evidence_reference,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("external_disclosure_grants").select("id,participant_id,recipient_profile_id,purpose,scope_categories,consent_basis,evidence_reference,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("participant_consent_evidence").select("id,participant_id,recipient_profile_id,authorising_profile_id,consent_basis,purpose,scope_categories,evidence_reference,effective_from,effective_until,status,representative_authority_id,version,superseded_by").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("worker_availability").select("id,membership_id,available_during,note,created_at").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("audit_log").select("id,action,subject_type,subject_id,metadata,created_at,actor").eq("organisation_id", organisationId).order("created_at", { ascending: false }).limit(50),
    supabase.rpc("list_admin_workspace_identities", { p_organisation_id: organisationId, p_roles: ["admin", "scheduler", "worker", "participant", "nominee", "external"] }),
    supabase.rpc("list_admin_workspace_self_links", { p_organisation_id: organisationId }),
    supabase.from("participant_service_context_versions").select("id,participant_id,capability_id,catalogue_item_id,role_version_id,jurisdiction,external_agreement_reference,plan_reference,source_type,owner_profile_id,reviewer_profile_id,goal_source,goal_reference,goal_display,effective_from,effective_until,lifecycle_state,screening_required_by_participant").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("organisation_provider_scope_versions").select("id,registration_state,registration_group,class_of_support,jurisdictions,effective_from,effective_until,status,reviewed_by").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("organisation_support_capabilities").select("id,scope_version_id,support_category,service_kind,capability,effective_from,effective_until,status").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("provider_support_catalogue_versions").select("id,source_label,source_version,effective_from,effective_until,status").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("provider_support_items").select("id,catalogue_version_id,item_code,item_name,support_category,time_unit,service_kind,effective_from,effective_until,status").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("risk_assessed_role_versions").select("id,title,definition_basis,description,risk_assessed,effective_from,effective_until,status").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("role_screening_policy_versions").select("id,role_version_id,registration_state,decision,decision_owner,decision_reason,effective_from,effective_until,status").eq("organisation_id", organisationId).order("effective_from", { ascending: false }),
    supabase.from("worker_screening_verification_versions").select("id,worker_membership_id,role_version_id,source_checked,application_or_check_reference,clearance_status,clearance_expires_at,interim_bar,suspension,exclusion,revocation,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("worker_screening_pathway_versions").select("id,worker_membership_id,role_version_id,pathway,jurisdiction,application_placement_contract_reference,pathway_start,pathway_end,supervisor_membership_id,risk_management_plan_reference,administering_organisation,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("role_competence_requirements").select("id,role_version_id,support_category,evidence_type,requirement_state,assessment_method,review_owner,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.from("worker_competence_evidence_versions").select("id,worker_membership_id,requirement_id,evidence_type,issuer,evidence_reference,assessed_state,limitation,expires_at,effective_from,effective_until,status").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.rpc("list_admin_masked_participant_ndis_identifiers", { p_organisation_id: organisationId }),
    supabase.from("shift_service_snapshots").select("id,shift_id,service_context_id,capability_id,catalogue_item_id,catalogue_version_id,item_code,item_name,support_category,service_kind,time_unit,goal_reference,goal_display,scheduled_start,scheduled_end").eq("organisation_id", organisationId).order("created_at", { ascending: false }),
    supabase.rpc("list_admin_acknowledgement_ledger", { p_organisation_id: organisationId, p_shift_id: null }),
  ]);

  const readError = [participants, cards, memberships, shifts, assignments, authorities, grants, consents, availability, audit, identities, selfLinks, serviceContexts, providerScopes, capabilities, catalogues, catalogueItems, roles, screeningPolicies, screeningVerifications, screeningPathways, competenceRequirements, competenceEvidence, maskedIdentifiers, snapshots, ackLedger].find((result) => result.error)?.error;
  if (readError) {
    return <section className="space-y-4 rounded-xl border border-danger/40 bg-danger/5 p-6" role="alert">
      <h1 className="text-xl font-semibold">Admin workspace could not load</h1>
      <p className="text-sm text-muted-foreground">The provider records are unavailable right now. Nothing was treated as an empty roster. Retry when the connection or permission check is restored.</p>
      <p className="text-xs text-muted-foreground">Reference: {readError.message}</p>
      <Link className="inline-flex rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted" href="/app/admin">Retry workspace load</Link>
    </section>;
  }

  return (
    <AdminWorkspace
      organisation={{ id: organisationId, name: ctx.active.organisation_name, role: ctx.active.role }}
      initialData={{
        participants: participants.data ?? [],
        cards: cards.data ?? [],
        memberships: memberships.data ?? [],
        identities: identities.data ?? [],
        shifts: shifts.data ?? [],
        assignments: assignments.data ?? [],
        authorities: authorities.data ?? [],
        grants: grants.data ?? [],
        consents: consents.data ?? [],
        availability: availability.data ?? [],
        audit: audit.data ?? [],
        selfLinks: selfLinks.data ?? [],
        serviceContexts: serviceContexts.data ?? [],
        providerScopes: providerScopes.data ?? [],
        capabilities: capabilities.data ?? [],
        catalogues: catalogues.data ?? [],
        catalogueItems: catalogueItems.data ?? [],
        roles: roles.data ?? [],
        screeningPolicies: screeningPolicies.data ?? [],
        screeningVerifications: screeningVerifications.data ?? [],
        screeningPathways: screeningPathways.data ?? [],
        competenceRequirements: competenceRequirements.data ?? [],
        competenceEvidence: competenceEvidence.data ?? [],
        maskedIdentifiers: maskedIdentifiers.data ?? [],
        snapshots: snapshots.data ?? [],
        ackLedger: ackLedger.data ?? [],
      }}
    />
  );
}
