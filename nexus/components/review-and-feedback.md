# Review Portal and Feedback
> Part of the Nexus production automation platform

Token-based external reviewer portal and internal diagnostic feedback capture.

Two distinct subsystems -- external reviewer portal (for email content approval) and internal feedback capture (for bug reports and feature requests).

## What it is

**The Review Portal** is a token-based public API for external reviewers who do not have dashboard accounts. Marketing team members send review links to outside parties; the link contains an HMAC-signed token that grants access to a specific campaign for review without requiring the primary brand login.

**The Feedback System** is the internal bug-reporting surface. Every dashboard page has a feedback button (in `<cn-shell>`) that opens a panel where operators can describe problems, annotate screenshots, and attach diagnostic context captured passively by `bug-capture.js`.

## Files

### Review Portal
| File | Lines | Role |
|---|---|---|
| `api/routes/v1/review_portal.py` | 512 | Token-based public endpoints. HMAC-signed session cookies (unforgeable from URL token alone). Retrieves campaign content from the email platform for review. Never exposes cost data. 5,000 character comment limit. |
| `api/routes/v1/review_admin.py` | 300 | Internal management of review sessions and feedback. Admin-only. |

### Feedback
| File | Lines | Role |
|---|---|---|
| `api/services/feedback_service.py` | 543 | Stores bug reports, feature requests, enhancement suggestions from dashboard users. 40+ columns capturing browser state: viewport, console_logs, debug_logs, network_history, page_state, interactions, performance_data, annotation_data, screenshot_path. |
| `api/routes/v1/feedback.py` | 204 | HTTP surface for feedback submission and admin review. |
| `dashboard/js/bug-capture.js` | 460 | Client-side passive diagnostic recorder. See [ADR-030](../decisions/030-passive-diagnostic-capture.md). |
| `dashboard/js/components/cn-feedback.js` | 1,118 | The feedback slide-out panel Custom Element. Three flows: bug / enhancement / new idea. |
| `dashboard/js/components/cn-feedback-annotator.js` | 637 | Canvas-based screenshot annotation tool (637 lines of in-browser drawing, no external library). |

## Scale

- **Review Portal token signing**: HMAC with a server-side secret. Tokens in URLs are unforgeable without the secret.
- **Review Portal comment limit**: 5,000 characters
- **Feedback table columns**: 40+ -- captures full browser state snapshot on submit
- **Screenshot annotation**: client-side canvas drawing, 637 lines of custom code
- **Bug capture buffer**: 50 console entries, 100 interaction breadcrumbs, last 30 network requests

## Key Decisions

- **Review portal tokens are HMAC-signed, not database-backed.** The token encodes the review session ID and an HMAC signature. Server validates by re-computing the HMAC. No DB lookup required for every request, and the token cannot be forged even if an attacker has every other token.
- **Review portal never exposes cost data.** The same campaign content visible to internal users includes cost/margin information. The reviewer API deliberately strips these fields before returning. Enforced server-side -- clients cannot opt in to see it.
- **[ADR-030: Passive diagnostic capture via bug-capture.js](../decisions/030-passive-diagnostic-capture.md)** -- bug-capture records everything passively so that when a user clicks feedback, the context is already assembled. Zero friction for the reporter.
- **Screenshot annotation is client-side.** The `cn-feedback-annotator.js` is 637 lines of canvas drawing. Keeps annotations private (they never leave the browser until submit) and avoids an image upload round-trip for the annotation step.
- **Dual-flow feedback panel.** The same `<cn-feedback>` element handles three flows (bug report, enhancement request, new idea) with slightly different field sets. Sharing the panel reduces code duplication and makes the three flows feel consistent to the operator.

## Integration Points

**Review Portal reads from:** the email platform (campaign content via `email_service`), `review_sessions`, `reviewers` tables.
**Review Portal writes to:** `review_sessions`, `review_feedback` (comment records).

**Feedback reads from:** `feedback` table (for admin review surface).
**Feedback writes to:** `feedback`, `sync_changelog`. Screenshot files go to a disk-based screenshots directory server-side.
