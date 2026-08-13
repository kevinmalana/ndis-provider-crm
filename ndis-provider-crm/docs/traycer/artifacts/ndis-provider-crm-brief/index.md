---
title: "NDIS Provider CRM — Epic Brief"
kind: spec
---

## Summary

Build a multi-tenant SaaS CRM for small-to-medium Australian NDIS providers. The first release makes service delivery easier to coordinate: provider teams roster support workers, workers complete mobile service records, participants see a plain-English summary of their delivered support, and separately authorised nominees, representatives, and external parties receive only the access their evidenced authority permits.

## Problem and opportunity

Providers need a clearer, more reliable way to coordinate participant support across office staff, frontline workers, participants, nominees, and external coordinators/referrers. Fragmented tools make roster changes, service records, and communication difficult to keep current and appropriately shared.

The product should help providers deliver participant-centred services while maintaining a trustworthy record of who may access and use participant information.

## First-release users

| User | Primary need |
| --- | --- |
| Provider administrator / scheduler | Manage their organisation, participants, workers, rosters, and appropriate access. |
| Support worker | Use a mobile-first experience to view assigned work and record delivered services. |
| Participant | View upcoming support and finalised participant-readable service summaries; request access or correction without relying on a discretionary sharing grant. |
| Nominee or other representative | Use a separate account whose access follows the recorded type, scope, evidence, and duration of their authority; never automatically mirror the participant. |
| External coordinator or referrer | Access only information covered by a current, purpose-specific participant or authorised-representative consent record. |

## First-release scope

- Multi-provider SaaS with strict organisation-level data separation.
- Participant profiles; supported-decision-making preferences; and distinct consent, representative-authority, internal-access, portal-visibility, and external-disclosure records.
- Worker profiles, availability, and role-based access.
- Rostering and shift/service coordination.
- Mobile-first worker experience with separate Start and End actions, participant-readable service summaries, and visibly pending offline evidence that is never silently discarded.
- Minimum current critical-support and safety information before Start, plus an always-visible urgent-concern handoff into the provider's incident process.
- Participant, representative, and authorised-external access with distinct, tightly scoped permissions and non-leaking expired/revoked/empty states.
- Accurate local-intent and server-receipt timestamps, immutable correction history, and an audit history for sensitive actions.
- One person may hold separate roles or grants across multiple provider organisations and must explicitly choose the active organisation context.

## Deliberate boundary

NDIS billing and claims are part of the product vision but are **not** part of the first pilot. The pilot must produce accurate service-delivery records that can later support billing and claims workflows.

The pilot also excludes service-note photos, full incident investigation/case management, native applications, public signup, in-app messaging, real-time participant tracking, worker shift swaps, and audio/Auslan note capture. The urgent-concern action hands off to the provider's existing emergency or incident process rather than pretending an ordinary service summary is an incident report.

## Trust and compliance posture

This product will handle participant and potentially sensitive information. Privacy, supported decision-making, consent, evidenced representative authority, least-privilege access, auditability, secure offline handling, and breach response are product requirements from the start—not later add-ons. Hosting in Sydney is a product constraint, not proof of privacy compliance. Authentication, retention, destruction, access/correction, subprocessors, and cross-border data flows must be validated with qualified Australian privacy, security, and NDIS compliance advice before production use.

The NDIS Practice Standards emphasise current, accurate, confidential participant information; participant consent around collection, use, retention, and disclosure; and participant access/correction rights. See the [NDIS Commission information-management guidance](https://www.ndiscommission.gov.au/rules-and-standards/ndis-practice-standards/core-module-provider-governance-and-operational). The Australian Privacy Principles and Notifiable Data Breaches obligations may also apply depending on the provider and data handled. See the [OAIC breach guide](https://www.oaic.gov.au/privacy/notifiable-data-breaches/preventing-preparing-for-and-responding-to-data-breaches/data-breach-preparation-and-response/part-4-notifiable-data-breach-ndb-scheme).

## Outcome to validate

A pilot provider can coordinate a participant's roster and service delivery across office staff and support workers; a worker can safely start, end, summarise, and recover a shift through intermittent connectivity; and participants, representatives, and approved external people see the correct information under distinct and evidenced access rules.
