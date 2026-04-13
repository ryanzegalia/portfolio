# ADR-003: Nightly Full-Refresh Alongside Delta Sync

## Context

Nexus syncs product, SKU, inventory, and order data from the ERP every 5 minutes using stamp-based delta queries -- "give me records modified since my last successful checkpoint." This is cheap and fast. In steady state, a delta tick reads a handful of changed records per poll and upserts them into the local Postgres.

The problem: the ERP sometimes modifies records without bumping the modification stamp. This is undocumented behavior -- silent corrections applied to product data, inventory levels that change during a warehouse batch operation without updating per-record timestamps, discount fields that get cleared without the parent row's timestamp updating.

A pure delta sync would drift. The Nexus local database would have values that differ from the ERP's canonical values, and nobody would know until downstream systems (pricing, reporting, fulfillment) started returning wrong answers.

## Decision

Run a full-refresh pipeline nightly in addition to the 5-minute delta heartbeats. Every night at 1:30 AM UTC, `nightly_sync.py` fires a 7-step pipeline that re-scans every record in the relevant tables regardless of stamp:

1. Products (full re-sync, not stamp-based)
2. Inventory (full re-sync)
3. Order backfill (last 7 days, catches corrections to recent orders)
4. Tax certificate sync
5. Purchase orders (scraped from the ERP office backend since REST API doesn't expose POs)
6. Shipment drift check
7. Activity log retention (prune `user_activity` rows older than 90 days)

The steps run with **15-minute staggered gaps between them** so the nightly sync doesn't pin the ERP's API at full throttle for an hour. Each step writes to `sync_changelog` with `trigger_source='nightly_sync'` -- distinguishing its changes from the regular heartbeat changes in audit logs.

The pipeline is non-destructive. It never drops tables, never modifies stored checkpoints, and never touches the delta-sync cursor state. If anything diverges, the `sync_changelog` records the before/after so an operator can see exactly what changed.

Consolidating the nightly work into one pipeline (rather than every service running its own 24-hour timer) made the nightly workload observable as a single operation and predictable in its timing.

## Alternatives Considered

- **Delta sync only.** Rejected because of the ERP's silent-correction behavior. Eventual drift is a guaranteed failure mode with no natural recovery.

- **Full-refresh only (no delta).** Rejected because it would require either polling the ERP constantly (high cost, high latency) or accepting 24-hour data freshness (unacceptable for a live operations dashboard).

- **Event-driven sync via webhooks.** the ERP doesn't offer webhook events for the fields that matter. Even if it did, a webhook-only architecture is brittle -- a missed webhook is an invisible data gap. Delta polling + nightly full-refresh is more resilient than any webhook setup.

- **Compare checksums instead of full-refresh.** Would reduce write volume during nightly runs but wouldn't reduce API read volume (you'd still have to fetch every record to hash it). No real savings.

- **Run the full refresh more often than nightly (every 4 hours).** Would tighten the drift window but increases API load and puts the full scan in the middle of business hours. Nightly at 1:30 AM UTC catches any corrections before the next day starts.

## Consequences

**Good:**
- Drift between Nexus and the ERP is bounded at 24 hours. Whatever the ERP quietly corrected yesterday is reflected in Nexus by breakfast.
- The pipeline is observable. One run per night, logged as a single operation in `api_health_log` with 7 sub-steps. The operator sees "nightly sync completed, touched X records, took Y minutes" in the activity feed every morning.
- Failures are investigable. Each step is its own sub-function with its own error handling -- one step failing doesn't abort the rest.
- The 15-minute staggered gaps prevent nightly work from saturating the ERP's API and triggering rate limits.
- `sync_changelog` entries tagged `trigger_source='nightly_sync'` make it possible to answer "did the nightly run catch anything the heartbeats missed?" with a SQL query.

**Bad / costs:**
- 1:30 AM UTC is a choice. UTC makes the run deterministic regardless of daylight saving time, but it lands at different clock times for different observers.
- The nightly pipeline is a point of failure concentration. When it's broken, it's broken for every data source it covers -- products, inventory, orders, tax certs, POs. Mitigated by the per-step try/except and by the fact that the 5-minute delta heartbeats keep running in parallel.
- The full-refresh reads every record every night, which on Nexus scale is tens of thousands of API calls per run. the ERP's API has no per-call cost, so this is free, but it wouldn't be on a metered API.
- Step ordering matters and is implicit. Products must sync before inventory (inventory references SKU IDs); tax certs must sync before order tax reconciliation. The order is hardcoded in `nightly_sync.py`; there's no declarative dependency graph. Adding a new step requires knowing where it fits.