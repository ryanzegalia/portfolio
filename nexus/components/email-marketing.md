# Email Marketing Pipeline
> Part of the Nexus production automation platform

Bi-directional sync pipeline between the email platform (email delivery), the PM tool (marketing content and review workflow), and the local emails table.


## What it is

Campaigns flow through a status lifecycle (Future -- Content Added -- Approved -- Scheduled -- Sent) with brand-to-group routing, preheader normalization, and comment sync between the email platform and the PM tool.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/email_platform_service.py` | 306 | Read-only email platform API v3 wrapper. Deliberately no send/delete/schedule from background tasks -- write operations are reserved for explicit user actions only. |
| `api/services/email_sync_heartbeat.py` | 589 | 15-minute background heartbeat that merges email platform campaigns + Monday status into the local `emails` table. Name normalization for matching, preheader backfill from HTML content. |
| `api/services/pm_service.py` | 763 | the PM tool GraphQL v2 wrapper for the Marketing Content and BOM Management boards. |
| `api/services/email_monday.py` | 550 | Bi-directional campaign sync -- pushes campaigns to the PM tool, manages the review workflow, schedules in the email platform, syncs comments. |
| `api/services/email_preview.py` | 592 | Lists local emails with filtering (brand, archived, sent status, Monday status). Read-only email platform proxy for live content preview. |
| `api/services/email_activity.py` | 34 | Tiny audit-trail logger for email entity changes. |
| `api/services/email_service.py` | 52 | SMTP relay with header injection prevention (strips CRLF). Multipart alternative (text + HTML). Google Workspace relay. |

## Scale and verified numbers

- **the email platform sync cadence**: 15 minutes
- **Rate limit to the email platform API**: 1.5 seconds per request (avoids the email platform rate limits)
- **Campaign status workflow**: Future -- Content Added -- Approved -- Scheduled -- Sent
- **Brand-to-group routing**: Primary, Wireless, Website groups on the PM tool Marketing Content board

## Key architectural decisions

- **Read-only email platform client for background tasks.** the email platform sends emails to customers. An accidental background task calling `send` or `schedule` could fire unintended campaigns. The `email_platform_service.py` module is deliberately scoped to GET-only; writes happen only in response to explicit user actions (button clicks, API calls with user auth).
- **the PM tool is the review workflow.** Campaigns are created in Nexus, pushed to the PM tool as items, reviewed by the marketing team via Monday's native UI, approved via status column changes, and then scheduled in the email platform. Monday is the coordination layer because it has the UX the marketing team already uses.
- **Preheader backfill from HTML.** the email platform doesn't always expose the preheader text as a separate field. `email_sync_heartbeat.py` parses campaign HTML, extracts the `<span class="preheader">` content, and backfills it into the local `emails` table so Nexus's own UI can show it.
- **Name normalization for matching.** the email platform campaign names and Monday item names drift over time (people rename things). The sync heartbeat normalizes both sides (lowercase, strip punctuation, collapse whitespace) and matches on the normalized form.
- **SMTP injection prevention.** `email_service.py` strips CRLF from headers to prevent email header injection attacks from any user-supplied field (Subject, From display name, etc.). Multipart alternative ensures both text and HTML versions are sent.

## Inputs and outputs

**Reads from:**
- the email platform API v3 (campaigns, subscriber lists, campaign content)
- the PM tool GraphQL v2 (Marketing Content board items and statuses)

**Writes to:**
- `emails` (local campaign mirror)
- `email_monday_links` (campaign -- Monday item mapping)
- `email_shares` (shareable preview tokens)
- `campaign_cache` (preheader backfill cache)
- the email platform API (only on explicit user actions)
- the PM tool GraphQL (status updates, comment sync)
- SMTP relay (transactional emails for alerts)
