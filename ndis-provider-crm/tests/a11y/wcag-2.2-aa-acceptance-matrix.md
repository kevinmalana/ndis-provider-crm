# WCAG 2.2 AA acceptance matrix (template)

Use this matrix for every route, authenticated role, and state before release. Record viewport/AT combinations and attach reproducible evidence; a blank cell is not acceptance.

| Area / state | Admin | Worker | Participant | Representative | External | Route/evidence | Owner/status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unauthenticated, loading, timeout, offline and reconnect | ☐ | ☐ | ☐ | ☐ | ☐ | | |
| Empty, error, correction, conflict and success states | ☐ | ☐ | ☐ | ☐ | ☐ | | |
| Dialog, sheet, menu, toast and sticky action focus order | ☐ | ☐ | ☐ | ☐ | ☐ | | |
| Narrow/reflow at 320 CSS px and 400% zoom | ☐ | ☐ | ☐ | ☐ | ☐ | | |

## WCAG 2.2 AA checks

| Criterion | Test method / acceptance evidence | Result |
| --- | --- | --- |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Automated contrast plus manual normal/large text and essential UI state checks | ☐ |
| 1.4.10 Reflow, 1.4.12 Text Spacing | 320px/400% zoom without loss of content or function | ☐ |
| 2.1.1 Keyboard, 2.1.2 No Keyboard Trap | Keyboard-only walkthrough of every interactive state | ☐ |
| 2.4.3 Focus Order, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured | Tab sequence, sticky bars, dialogs, menus and sheets | ☐ |
| 2.5.3 Label in Name, 2.5.8 Target Size (Minimum) | Accessible-name check; ordinary controls ≥24px and worker controls ≥48px | ☐ |
| 3.3.1 Error Identification, 3.3.3 Error Suggestion, 3.3.8 Accessible Authentication | Visible/announced errors and recovery guidance | ☐ |
| 4.1.2 Name, Role, Value; 4.1.3 Status Messages | Axe/Pa11y plus screen-reader verification of status, errors, dialogs and toasts | ☐ |
| Forced colours and reduced motion | Windows High Contrast/forced-colors and prefers-reduced-motion walkthrough | ☐ |

Automated axe and Pa11y checks are representative gates; they do not replace manual keyboard, screen-reader, zoom, forced-colour, touch-target, and cognitive-load checks.
