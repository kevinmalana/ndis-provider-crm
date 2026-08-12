-- 20260813000001_provider_readiness_ordering_fix.sql
--
-- Forward-only repair for the deployed migration order. Supabase applies
-- filenames lexicographically, so 0009 ran before the 20260811 Ticket 05
-- fixups. The later admin fixup narrowed the command receipt allow-list and
-- reintroduced the context-free shift command that 0009 had retired.
--
-- Preserve legacy receipt rows, restore every current command type, retire
-- the unsafe callable again, and classify any context-free shifts created in
-- the affected window as non-actionable legacy evidence.

begin;
set search_path = '';

drop function if exists public.cmd_admin_create_shift(
  text,
  uuid,
  uuid,
  uuid,
  timestamptz,
  timestamptz,
  text,
  jsonb
);

alter table public.command_receipts
  drop constraint if exists command_receipts_command_type_check;

alter table public.command_receipts
  add constraint command_receipts_command_type_check check (command_type in (
    'on_my_way','start_shift','end_shift','submit_summary','finalise_summary',
    'cancel_shift','reassign_shift','resolve_conflict','request_correction',
    'request_access','apply_correction','accept_invitation',
    'admin_invite','admin_create_participant','admin_set_authority',
    'admin_create_grant','admin_revoke_grant','admin_set_availability',
    'admin_create_shift','admin_update_critical_info','admin_link_self',
    'admin_record_consent','admin_renew_consent',
    'admin_create_service_ready_shift','admin_provider_scope','admin_catalogue',
    'admin_worker_readiness','admin_service_context','admin_identifier',
    'admin_acknowledgement'
  ));

update public.shifts s
set state = 'legacy_incomplete'
where s.state <> 'legacy_incomplete'
  and not exists (
    select 1
    from public.shift_service_snapshots snapshot
    where snapshot.shift_id = s.id
  );

commit;
