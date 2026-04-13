# ADR-013: Heartbeat Cadence Selection

## Context

Every heartbeat in Nexus runs on a different interval. The values are not arbitrary, but they were chosen case by case based on what the underlying data demanded, not from a single design session.

A pattern-level ADR captures the reasoning so future heartbeats inherit the same thinking.

## Decision

**Pick the cadence from one of four tiers based on data freshness requirements and API cost:**

| Tier | Cadence | Use for | Services |
|---|---|---|---|
| **Real-time critical** | 5 minutes | Datthe operator watches continuously -- orders, inventory, products, pricing changes, new tax transactions | `product_stamp_heartbeat`, `inventory_heartbeat`, `order_heartbeat`, `pm_restock_heartbeat`, `tax_engine_heartbeat` |
| **Near-real-time** | 15 minutes | Data that matters but tolerates short staleness -- email campaign status, Excel file changes | `email_sync_heartbeat`, `msgraph_excel_heartbeat` |
| **Hourly** | 1 hour | Data that changes slowly -- vendor costs | vendor_sync_service |
| **Nightly** | 24 hours | Full-refresh sweeps, audit scans, drift detection | `deal_heartbeat`, `expo_fetch_heartbeat`, `nightly_sync` |

The 5-minute floor came from two constraints: the ERP's API rate limits tolerate it comfortably at the volume Nexus pulls, and 5 minutes is fast enough that the operator never feels the data is stale. Going faster (1-minute polling) does not improve UX meaningfully but multiplies API cost and write volume by 5x.

24-hour cadence is reserved for things that genuinely do not need faster feedback -- drift detection catches corruption overnight, which is acceptable because the damage from corruption takes days to compound.

Between the tiers, judgment calls. PO data changes once or twice a day per PO as items ship. The scraping is expensive (authenticated, rate-limited) -- running it every 5 minutes would be wasteful. Nightly is too slow -- operators want to see "received today" data during the day. Hourly is the right compromise.

Every heartbeat adds **jitter** to its cadence: `interval + random.uniform(0, jitter_seconds)`. A 5-minute heartbeat with plus/minus 15 seconds of jitter never fires at exactly the same wall-clock time twice, which spreads load across the ERP API window.

## Alternatives Considered

- **Single universal cadence** (all heartbeats at 5 min). Rejected because some data does not need that freshness and some cannot afford that cost. Deal drift scraping every 5 minutes would burn hundreds of the ERP session requests per hour.

- **Adaptive cadence** (speed up when activity is high, slow down when idle). Considered for sync heartbeats. Rejected because the extra complexity (tracking recent activity, tuning the adaptation curve) does not justify marginal cost savings. Fixed intervals are predictable and easy to debug.

- **Cron-style schedules** instead of interval loops. Rejected because the interval pattern is simpler and survives process restart more cleanly. `time.sleep(interval)` is stateless; cron expressions require a scheduler. The exception is `nightly_sync`, which runs at 1:30 AM UTC specifically -- that one is scheduled explicitly.

## Consequences

**Good:**
- Cadence decisions are easy to reason about. "Why does this heartbeat run every 15 minutes?" is answered by looking up which tier it is in.
- New heartbeats default to the right tier based on their data characteristics.
- Jitter spreads load evenly. Nine heartbeats all firing at synchronized intervals would create traffic spikes on the ERP. With jitter, the traffic is smooth.
- The 5-minute floor is a stable reference point. API budgets, log volume, and DB write volume are all sized for it.

**Bad / costs:**
- Heterogeneous intervals mean the operator dashboard shows different "last run" timestamps for every service. The dashboard handles this (shows "3 min ago" for 5-min services, "8 hours ago" for nightly) but the heterogeneity is visible.
- A new heartbeat that does not fit a tier has to justify why. No hard rule forces consistency, only convention.
