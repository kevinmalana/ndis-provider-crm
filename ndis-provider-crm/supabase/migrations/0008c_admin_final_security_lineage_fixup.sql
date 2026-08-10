-- 0008c_admin_final_security_lineage_fixup.sql
--
-- Final narrow correction for Ticket 05: invite receipt outcomes remain
-- actor-private, and consent evidence uses one basis-blind lineage per
-- organisation/participant/recipient.

set search_path = '';

------------------------------------------------------------------------
-- Invitation tokens/emails are recoverable only by the issuing actor.
-- The actor policy remains in 0006; this tenant-wide policy excludes
-- admin_invite receipts so another admin/scheduler cannot read secrets.
------------------------------------------------------------------------

drop policy if exists command_receipts_select_admin_scheduler on public.command_receipts;
create policy command_receipts_select_admin_scheduler
  on public.command_receipts for select to authenticated
  using (
    organisation_id = public.current_active_organisation_id()
    and public.current_user_membership_role() in ('admin','scheduler')
    and command_type <> 'admin_invite'
  );

------------------------------------------------------------------------
-- Repair already-populated consent rows from a pre-basis-blind upgrade.
-- Only broken groups (null versions or more than one current leaf) are
-- rewritten. Stable groups are left untouched, making this rerunnable.
------------------------------------------------------------------------

alter table public.participant_consent_evidence
  drop constraint if exists participant_consent_version_unique;
drop index if exists public.participant_consent_evidence_version_uidx;
drop trigger if exists participant_consent_evidence_set_updated_at on public.participant_consent_evidence;
alter table public.participant_consent_evidence
  drop constraint if exists participant_consent_evidence_superseded_by_fkey;

with broken_groups as (
  select organisation_id, participant_id, recipient_profile_id
  from public.participant_consent_evidence
  group by organisation_id, participant_id, recipient_profile_id
  having count(*) filter (where version is null) > 0
      or count(*) filter (where superseded_by is null) > 1
), versioned as (
  select p.id,
         row_number() over (
           partition by p.organisation_id, p.participant_id, p.recipient_profile_id
           order by p.created_at asc, p.id asc
         ) as new_version,
         lead(p.id) over (
           partition by p.organisation_id, p.participant_id, p.recipient_profile_id
           order by p.created_at asc, p.id asc
         ) as new_superseded_by
  from public.participant_consent_evidence p
  join broken_groups g
    on g.organisation_id = p.organisation_id
   and g.participant_id = p.participant_id
   and g.recipient_profile_id = p.recipient_profile_id
)
update public.participant_consent_evidence p
set version = v.new_version,
    superseded_by = v.new_superseded_by,
    updated_at = pg_catalog.now()
from versioned v
where p.id = v.id;

alter table public.participant_consent_evidence
  alter column version set default 1,
  alter column version set not null;

create trigger participant_consent_evidence_set_updated_at
  before update on public.participant_consent_evidence
  for each row execute function public.set_updated_at();

alter table public.participant_consent_evidence
  add constraint participant_consent_evidence_superseded_by_fkey
  foreign key (superseded_by)
  references public.participant_consent_evidence(id)
  on delete set null
  deferrable initially deferred;

create unique index if not exists participant_consent_evidence_version_uidx
  on public.participant_consent_evidence
    (organisation_id, participant_id, recipient_profile_id, version);

-- This is the schema-level current-leaf invariant. It is deliberately
-- basis-blind: participant and authorised-representative evidence are
-- versions of the same chain, never parallel active leaves.
create unique index if not exists participant_consent_current_leaf_uidx
  on public.participant_consent_evidence
    (organisation_id, participant_id, recipient_profile_id)
  where superseded_by is null;
