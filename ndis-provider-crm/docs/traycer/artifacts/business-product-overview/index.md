---
title: "NDIS Provider CRM — Business & Product Overview"
kind: spec
---

A plain-English description of what we are building and why. Intended for non-technical readers — pilot providers, board members, partner organisations, compliance advisors, and prospective staff. For the full technical picture and the engineering plan, see the [Epic Brief](../ndis-provider-crm-brief/index.md).

## What we are building

A web-based service for Australian NDIS providers that helps their office staff, support workers, participants, nominees, and external coordinators work from one shared, trustworthy record of who is doing what, when, and with whose permission.

The first version is a focused pilot. It does not try to be a complete practice management system. It does the frontline work well — scheduling, recording what happened, sharing the right slice with the right people — and it leaves room to grow into invoicing and plan tracking later.

It is built as a multi-tenant service from day one. Many providers will share the same software, but each provider's records are isolated from every other provider's. Participants and external coordinators see only the records they have been explicitly granted access to.

## Who it is for

| Person | What they need from the product |
| --- | --- |
| **Provider administrator or scheduler** | A clear view of the roster, an easy way to invite staff and to add participants, and a quick answer when something needs changing last minute. |
| **Support worker** | A phone app that tells them where they are going, what to do when they arrive, and lets them record what happened — quickly, accurately, and on bad signal. |
| **Participant** | A simple way to see who is coming, read the finalised plain-English summary of a visit, and request access or correction. |
| **Nominee or representative** | A separate account limited to the documented type and duration of authority they hold; their access does not automatically mirror the participant. |
| **External coordinator or referrer** | A bounded, time-limited window into the specific participants they coordinate, with no access to anyone else's records. |

## The problem we are solving

Small and mid-size NDIS providers coordinate dozens of support workers and hundreds of participant visits every week. Today they stitch together rosters, paper notes, group chats, and a CRM that was not designed for the realities of frontline work in this sector. The result is:

- Workers in the field, often on unreliable signal, struggle to record what happened on time and accurately.
- Office staff lose hours reconciling records that don't match.
- Participants do not know reliably who is coming or what happened during a visit.
- External coordinators wait for information that arrives inconsistently.
- Privacy and consent decisions are scattered across documents and conversations, with no reliable audit trail.

The pilot takes a different angle. It treats the worker experience as the product — if the worker can capture the right record at the right moment, everything else (sharing, audit, planning for billing later) flows from that.

## What is in version one

- **Scheduling.** Office staff can build and adjust the roster, assign a worker to a participant for a shift, and respond quickly when cover is needed.
- **Mobile worker experience.** A phone-first web app that tells a worker what is next, lets them start and finish a visit with one tap, and captures a short, structured record of what was provided.
- **Offline support.** Current-day assigned work and the minimum information needed for that work remain available for up to 24 hours after the last online permission check. Every pending action remains visible until accepted or sent for review; evidence is never silently discarded.
- **Participant access.** Participants see upcoming visits and finalised plain-English service summaries. They can request access or correction and see optional external access that has been authorised on their behalf.
- **Representative access.** Nominees and other representatives use their own accounts. What they see follows recorded evidence of their authority, not a blanket “nominee” label.
- **External access.** Coordinators and referrers receive only a purpose-specific, time-bounded view backed by recorded participant or authorised-representative consent.
- **Safety handoff.** Workers see current essential safety/support information before starting. Missing or stale information creates a persistent warning and contact path without automatically cancelling essential support. Urgent concerns go to the provider's existing emergency/incident process.
- **Audit history.** Every invitation, role change, consent change, roster change, visit start/finish, and access change is recorded in an append-only log. The administrator can open any record and see exactly what happened and when.
- **Privacy and consent management.** Each participant's consent record (what we may collect, what we may share, until when) is a first-class part of their record.

## What is deliberately not in version one

To keep the pilot focused and deliverable, the following are out of scope until the first version proves itself:

- **Invoicing, claims, and plan-budget tracking.** These will come in a later release. The pilot produces the records those features will need, so the path forward is open.
- **Native phone apps.** The mobile experience is a phone-friendly web app that can be added to the home screen, with full offline support. Native apps are a roadmap item.
- **Messaging between workers and participants.** Not part of the pilot. Communication happens through scheduled visits, not chat.
- **Public sign-up.** No one can create their own account. Every account is invited by an authorised user, so we always know who has access.
- **Worker self-service shift swaps.** Office staff handle reassignment in version one; a worker-initiated swap flow is a later enhancement.
- **Service-note photos or audio.** The pilot uses a short participant-readable summary. Attachments require separate purpose, authority, retention, and device-security decisions and are deferred.
- **Full incident management.** The pilot provides a safety handoff, not investigation and case management.

## How we earn trust

Because this product holds sensitive information about people with disability, trust is built in three ways:

1. **Least-privilege access by design.** Internal work access, participant self-access, representative authority, and optional external disclosure are separate. Consent and authority record their purpose, scope, recipient, evidence, effective dates, and withdrawal history.
2. **Reliable records.** Start time, actual end time, service-summary finalisation, server receipt, and corrections are distinct events. Offline evidence remains visible until accepted or reviewed, and every correction preserves the original.
3. **Honest operations.** Data is hosted in Australia, but hosting location alone is not presented as privacy compliance. Invitations, role changes, access decisions, and corrections are logged, and qualified professionals review privacy, security, retention, cross-border processing, and NDIS obligations before production use.

## What we expect to validate with the pilot

We will know the pilot is working when a real provider can run a normal week — scheduling, supporting, recording, sharing — on the platform with fewer dropped records, faster answers to "what happened?", and clearer consent conversations than they could on their current tools. We will not declare success until we can show that staff, workers, participants, and external coordinators all find the right slice easier to reach than they did before.

For the engineering framing of the same direction, see the [Epic Brief](../ndis-provider-crm-brief/index.md).
