---
title: "Worker offline outbox and device-safety contract"
kind: ticket
status: 0
---

## Goal

Add the defined PWA offline experience without misleading the worker or leaving unrestricted participant data on a device.

## Scope

- Serwist + Dexie durable outbox with the truthful states: local draft, pending sync, server accepted, conflict, and needs review.
- Cache only current-day assigned work and minimum handoff information for up to 24 hours after the last successful online permission check.
- Permit offline cache only on an approved, individually enrolled provider-owned or BYOD device with supported OS/browser, device screen lock, individual/no-shared-use policy, and acknowledged lost-device process.
- Encrypt participant cache/outbox payloads with a per-enrolment non-exportable WebCrypto key where the supported-browser spike verifies reliable behaviour; disable offline participant data on devices that cannot meet the contract.
- Guaranteed retry on app launch, foreground, connectivity restoration while open, and explicit “Sync now”; Background Sync is enhancement only.
- Ordered, idempotent, version-aware operations; conflicts preserve evidence and go to an authorised review path rather than being discarded.
- Explicit first-online sign-in, local user verification, session-age/re-authentication, failed-unlock, logout, membership-revocation-on-reconnect, cache-expiry, quota/eviction, private-browsing, OS-backup, reinstall, and lost-device behaviours.
- Purge revoked/expired/logout cache at next application/server contact and explicitly disclose that immediate remote wipe is impossible while offline.
- Redacted notifications/app-switcher presentation; no photos or other attachment originals cached.

## Out of scope

- A claim of immediate remote wipe while a device is offline, generic offline biometric unlock, audio/haptics as required confirmation, and attachments.

## Dependencies

`04-v1-data-security-foundation`, `04a-design-system-accessibility-rails`, and `06-worker-online-shift-and-service-summary`.

## Verification

- A worker can simulate loss/recovery of connectivity without losing a draft or confusing local state with acceptance.
- Reassignment/revocation/cancellation while offline produces a preserved conflict/review state on reconnect.
- Cache expires at 24 hours and requires online re-authentication before participant data can be reopened.
- Tested in supported iOS and Android browsers; sync works without the Background Sync API.
