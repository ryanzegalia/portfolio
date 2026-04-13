# Event Management and the trade show
> Part of the Nexus production automation platform

Full lifecycle management for trade shows and industry events, plus automated ticket export and attendee sync for the trade show integration.


## What it is

Two overlapping systems: a general event management suite (5 services covering equipment, shipping, signage, travel, and reporting for any the company event), and the trade show integration (automated ticket fetch via Playwright browser automation + the email platform subscriber sync).

## Primary files -- general event management

| File | Lines | Role |
|---|---|---|
| `api/routes/v1/events.py` | 1,029 | Full CRUD for industry events calendar. Cloudflare cache purge + S3 CDN fallback feed push on edit. Audit trail via `event_history`. |
| `api/services/event_equipment.py` (via routes) | -- | Track equipment through workflow: requested -- approved -- pulled -- packed -- returned. |
| `api/services/event_shipping.py` (via routes) | 418 | Manages shipping addresses (venue, hotel) and shipment records. Integrates with FedEx/USPS for label generation. |
| `api/services/event_signage.py` (via routes) | 470 | Track signage/marketing material requests with dual status system. Categories: Digital, Signage, Merchandise, Trade Show Materials. |
| `api/services/event_travel.py` (via routes) | 527 | Travel authorization with two-level approval chain: manager -- executive. Status: draft -- submitted -- mgr_approved -- approved/rejected. |

## Primary files -- the trade show integration

| File | Lines | Role |
|---|---|---|
| `api/services/expo_fetch_heartbeat.py` | 469 | Background heartbeat. Auto-logs into the trade show using a saved Playwright browser session (Google OAuth -- Portal OAuth -- the trade show cookie chain). Downloads ticket exports automatically on 24-hour interval. |
| `api/services/expo_service.py` | 605 | Excel parsing -- DB storage -- the email platform subscriber sync. Dynamic header mapping, .NET date parsing (`/Date(timestamp)/`). Rate-limited at 1.5s/request to the email platform. |
| `api/routes/v1/elevate_tickets.py` | 271 | Upload Excel ticket exports, list attendees, trigger the email platform subscriber sync. Dual auth: page permission + API key hash-compare for automation. |

## Scale and verified numbers

- **the trade show fetch cadence**: 24 hours (default, configurable via env)
- **the email platform rate limit**: 1.5 seconds per API request
- **Travel approval chain**: 2 levels (manager -- executive)
- **Cost breakdown fields on travel requests**: 8 (airfare, hotel, meals, registration, ground transport, rental car, parking/tolls, other)
- **Signage categories**: 4 (Digital, Signage, Merchandise, Trade Show Materials)

## Key architectural decisions

- **Events are full-stack first-class entities.** 9 event tables (`events`, `event_equipment`, `event_shipments`, `event_signage`, `event_travel_requests`, `event_addresses`, `event_notes`, `event_history`, `event_activity`). Not a bolt-on -- a fully modeled sub-system.
- **Two-level travel approval chain.** Travel requests go through manager approval before exec approval. Both roles have dashboard UIs for their approval queues. Workflow states prevent skipping levels.
- **Playwright with saved browser state for the trade show.** the trade show doesn't have a public API. The only way to get ticket exports automatically is to replay a browser session. `expo_fetch_heartbeat.py` saves the authenticated cookie state from a manual login once, then replays it on every subsequent fetch. Fragile but effective.
- **Cloudflare cache purge + S3 fallback feed push on event edit.** The public events feed is cached at Cloudflare edge. Every edit triggers a targeted URL purge via `cloudflare_service.py`. A backup JSON is also pushed to S3 so the feed survives Cloudflare outages.
- **Event history as an audit table.** `event_history` captures every edit to any event entity with the operator, timestamp, and field-level diff. Separate from `sync_changelog` because event-specific history is queried heavily in the event UI.

## Inputs and outputs

**Reads from:**
- the trade show website (via Playwright, via saved session)
- the email platform (subscriber lists for sync)
- the ERP (not directly -- event management is a Nexus-native feature)

**Writes to:**
- 9 event tables
- `elevate_tickets`, `elevate_import_batches`
- the email platform (subscriber list updates via `email_service` when tickets are imported)
- `event_history`, `event_activity` (audit trails)
- S3 (backup event feed)
- Cloudflare API (cache purges)
