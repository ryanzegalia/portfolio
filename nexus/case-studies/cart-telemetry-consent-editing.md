# Storefront Telemetry and Consent-Gated Cart Editing

## Problem

A multi-brand B2B/B2C hardware manufacturer ran on a legacy hosted storefront that gave no visibility into live shopper behavior. Two gaps followed from that black box. Reps could see nothing about who was on the site or what was in a cart, and reps helping a customer with a cart had no safe way to act on it. The obvious path, server-side session impersonation, was rejected outright. The work built a first-party telemetry pipeline for visibility and a consent-based mechanism for rep assistance that never touches a customer's session.

## Approach

Three capabilities sit on the platform side of a first-party telemetry pipeline. A behavioral event taxonomy of **38+ event types** feeds an ingestion API, giving the storefront a behavioral record it did not have before. Visitor presence rides on a heartbeat that UPSERTs into a visitor-sessions table, with a watchdog that marks a session departed when its heartbeat stops, and a live dashboard shows who is on the site, what page they are on, and what is in their cart. Presence and cart previews poll on a fixed interval rather than holding open sockets, a choice **capacity-analyzed (as of 2026-06-14, re-confirmed 2026-07-09) to ~1,000 concurrent visitors at 5-8% CPU on a small VPS**, where the poll design generates roughly 40 to 80 requests per second and the existing connection pool absorbs it. Rep-assisted cart editing stages a change on the platform, but the shopper's own browser polls for it, renders a preview modal, and executes the edit only through the storefront's native cart mechanism after the shopper approves. The platform never holds or replays customer session tokens: the consent prompt is the security boundary.

## Technical Highlights

- **The telemetry-path audit caught a silent beacon loss.** Page-view beacons were failing with no console error to signal it. navigator.sendBeacon attaches cookies by design, and the endpoint's CORS policy allowed the origin but not credentials, so every beacon died in preflight. A systematic audit of the telemetry path surfaced the cause, and the fix switched to a credential-less fetch with keepalive.
- **Polling was chosen over WebSockets, and re-confirmed.** A WebSocket layer would add a permanent async sidecar, Redis pub/sub, and proxy complexity for a marginal latency gain, which did not fit a small VPS serving this traffic. A later perceived-lag report traced to a lifecycle bug rather than a polling limit, and the poll design was re-confirmed against the same capacity analysis.
- **The consent prompt is the security boundary.** The platform stages an action, but the change executes only through the storefront's native cart mechanism after the shopper taps approve. Customer session tokens stay in the shopper's browser and are never held or replayed by the platform.
- **The receiver moved into the global page header** so a staged push reaches the shopper on any page, not only the cart page. Reps stage the entire cart and push once as a multi-action, rather than editing line by line.
- **Auto-follow resolves conflicts instead of overwriting.** A rep tracks a shopper's cart changes over the existing 5-second poll, unless the rep holds unpushed local edits, in which case a conflict banner offers sync-or-keep.

## Outcome

Before this work, the storefront offered no view of live shopper activity and no safe path for a rep to touch a cart. After it, a live dashboard shows current visitors, their page, and their cart contents, and a rep can stage a cart change that the shopper approves from any page. The end-to-end consent loop was proven on the live site on 2026-06-16.

Rollout was deliberately staged rather than shipped in a day. An isolated, byte-for-byte replica of the storefront was stood up on 2026-06-30 so telemetry, visibility, and consent-edit features could be grafted and audited without touching the live site. A five-dimension security review covering CORS, presence auth, telemetry token safety, grant scoping, and snapshot correctness gated publish on 2026-07-01. Features rolled out from late June through early July 2026.

## Limitations

Polling trades a few seconds of latency for operational simplicity. The 5-second interval bounds how quickly a rep sees a shopper's change and how quickly a shopper sees a staged push, which is acceptable for assisted-cart work at this scale. The capacity analysis (run 2026-06-14, re-confirmed 2026-07-09) holds to roughly 1,000 concurrent visitors on a small VPS. A materially larger concurrent load would reopen the WebSocket question, which is why the trade-off is documented rather than treated as settled.

See also: [ADR-036: Poll-based presence](../decisions/036-poll-based-presence.md), [ADR-037: Consent-gated cart editing](../decisions/037-consent-gated-cart-editing.md), and [Storefront analytics and attribution](storefront-analytics-attribution.md) for the read surface built on this pipeline.