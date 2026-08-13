---
title: "Ticket 05 final UI retry-behaviour fixup"
kind: ticket
status: 2
---

## Goal

Close the remaining real-component retry and concurrency failures found at HEAD `6f240ba` without changing Ticket 05b scope.

## Required corrections

- Normalize accepted and duplicate RPC response shapes so original warning/result context survives uncertain-transport retries; retain the command ID through warning acknowledgement, then rotate it only after acknowledgement or explicit new intent.
- Preserve the exact logical form payload and visible values until a terminal response is known; a retry with the same command ID must send the same arguments rather than cleared or edited values.
- Make invitation copy-link recovery idempotent and actor-bound after a committed-but-lost response; the original safe token/link must remain recoverable on duplicate retry without exposing it to other actors.
- Replace the global pending gate with per-form pending/disabled/error state so unrelated forms remain usable and every submitting control visibly reflects its own state.
- Include consent version/current-supersession fields in the server projection so renewed evidence is labelled accurately and the grant selector cannot present every consent as version 1.

## Verification

- Mounted `AdminWorkspace` integration tests mock Supabase and router behaviour and exercise normal success, committed-but-response-lost retry, duplicate outcome normalization, warning acknowledgement/new-intent rotation, preserved form arguments and per-form concurrent submissions.
- Invitation duplicate retry returns the original actor-bound copy link; another actor cannot retrieve it.
- Existing Ticket 05 DB/security, accessibility/static and full application gates remain green.
- No merge, push, remote Supabase, Docker, secrets or real participant data.

## Final decisive-review findings

- Persist the payload fingerprint/arguments before the RPC starts so a rejected or thrown response retries with the exact same command ID and payload. Add mounted rejection/throw → duplicate tests; a normal accepted response is not a transport-loss simulation.
- Handle missing, denied or non-Promise Clipboard API explicitly and always display a selectable invitation URL fallback after a committed success.
- Treat `duplicate_returned` with warnings as a terminal result for acknowledgement rotation; after all warnings are acknowledged, the next intentional submission must receive a fresh command ID.
- Support provider-recorded authorised-representative consent in the admin UI with a basis switch and a current, participant-scoped authority selector. Never hardcode participant basis when representative consent is intended.

## Final approval-review findings

- Separate stable visible-intent identity from generated exact RPC arguments. Consent, grant and authority retries after reject/throw must reuse the first attempt's exact timestamps, arguments and command ID when visible form intent is unchanged.
- Scope participant-basis authoriser options to active self-links for the selected participant; accounts linked to another participant must never be offered.
- Clear or replace an invitation fallback URL when the operator starts a genuinely new invite intent. A failed second invite must not leave the first invite's URL displayed as if it belonged to the new request; same-intent retry recovery must remain available.
