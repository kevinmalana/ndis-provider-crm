---
title: "Tickets"
kind: spec
---

## Full-v1 MVP delivery sequence

These tickets are planning drafts until Kevin approves execution. Testing uses synthetic data only.

```mermaid
flowchart LR
  A[04 Data/security + identity migration] --- B[04a Design/accessibility corrections]
  A --> C[05 Admin workspace]
  B --> C
  C --> C2[05b Readiness enforcement + Ticket 05 integration]
  C2 --> D[06 Online worker loop]
  D --> E[08 Participant/representative portal]
  D --> F[07 Bounded offline]
  E --> G[09 External portal]
  F --> H[10 Full synthetic pilot readiness]
  G --> H
```

The first representative test release is `04 + 04a → 05 → 05b → 06`. It lets Kevin configure one supported individual-time service, satisfy a synthetic worker's screening and role-competence requirements, activate a reviewed participant context, create one immutable service-ready shift, and complete the online worker loop. The approved MVP target remains the full v1 pilot scope through ticket 10.

Completed tickets 01–03 remain historical `status: 2` records. Their supersession notes point to corrective work rather than rewriting what was built.
