# Background Heartbeat Services
> Part of the Nexus production automation platform

Nine background threads that run continuously inside the Gunicorn API process -- the engine that makes Nexus feel live.


## What they are

Nine background threads that run continuously inside the Gunicorn API process, each polling a different external data source on a different cadence, writing delta updates to the local Postgres and `sync_changelog` audit table. Every heartbeat shares the same resilience scaffolding -- circuit breakers, thundering-herd stagger, hydration on restart -- and together they cover the operational surface of the entire platform.

See [SYSTEMS_OVERVIEW.md](../architecture/SYSTEMS_OVERVIEW.md#the-9-background-heartbeat-services) for the table with cadences, purposes, and write targets.

## The 9 services

| Service | Cadence | Purpose |
|---|---|---|
| `product_stamp_heartbeat.py` (1,237 lines) | 5 min | Product / SKU / option delta from the ERP |
| `inventory_heartbeat.py` (608 lines) | 5 min | Stock level delta via `movement_date` |
| `order_heartbeat.py` (950 lines) | 5 min | New orders with in-memory SKU cache |
| `pm_restock_heartbeat.py` (309 lines) | 5 min | Reads the PM tool, writes `qc_tracked_skus` |
| `tax_engine_heartbeat.py` (330 lines) | 5 min | Tax transactions with checkpoint delta |
| `email_sync_heartbeat.py` (589 lines) | 15 min | Campaign status merge |
| `msgraph_excel_heartbeat.py` (294 lines) | 15 min | ETag-aware Excel change detection |
| `deal_heartbeat.py` (779 lines) | 24 hr | Deal drift detection -- see [deal-drift-detection.md](deal-drift-detection.md) |
| `expo_fetch_heartbeat.py` (469 lines) | 24 hr | Playwright-driven expo ticket fetch |

Plus **`nightly_sync.py`** (1,366 lines) -- not a heartbeat but the orchestrator that runs a 7-step full-refresh pipeline at 1:30 AM UTC.

Plus **`startup_recovery.py`** (100 lines) -- not a heartbeat but the boot-time daemon that replays failed services from the last 2 hours of `api_health_log`.

## Shared scaffolding

Every heartbeat inherits the same boot sequence:

1. **Hydrate** from `api_health_log` -- restore last run time, count, and duration so stats survive process restart.
2. **Stagger** -- first tick sleeps `random.uniform(N, M)` seconds to avoid thundering-herd across workers.
3. **Check flag** -- `is_service_disabled(name)` short-circuits if the service was tripped by the circuit breaker.
4. **Try work, catch everything** -- any unhandled exception increments `_consecutive_errors`.
5. **Circuit break at 10** -- `disable_service(name)` via the file-backed flag API visible to all workers.
6. **Log to both `api_health_log` and `sync_changelog`** -- operational events and business events respectively.
7. **Sleep with jitter** -- `time.sleep(interval + random.uniform(0, jitter))` before the next tick.

## Key architectural decisions

- **[ADR-005: Circuit breakers on every external API call](../decisions/005-circuit-breakers-on-external-apis.md)** -- 10 consecutive errors -> disable. The threshold was calibrated from production experience with external API failures.
- **[ADR-006: Checkpoint-based incremental sync](../decisions/006-checkpoint-based-incremental-sync.md)** -- commit the checkpoint only after successful batch processing, never partway through.
- **[ADR-007: Startup recovery for background services](../decisions/007-startup-recovery-for-background-services.md)** -- replay failed services within 2 hours of restart, in dependency order.
- **[ADR-013: Heartbeat cadence selection](../decisions/013-heartbeat-cadence-selection.md)** -- the four-tier cadence model (5 min / 15 min / hourly / nightly).
- **[ADR-003: Nightly full-refresh alongside delta sync](../decisions/003-nightly-full-refresh-alongside-delta-sync.md)** -- the safety net that catches anything the heartbeat delta misses.
- **[ADR-020: sync_changelog as cross-cutting activity feed](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md)** -- every heartbeat writes here, so the operator sees a unified event timeline across all nine services.

## Cross-cutting patterns

Every heartbeat is a daemon thread. Every heartbeat uses the same `api_health_service` module for operational logging. Every heartbeat uses the same `service_flags` module for circuit breaker state. Every heartbeat writes to `sync_changelog`. The consistency is deliberate -- debugging any heartbeat means reading one service and understanding the shared scaffolding; there's nothing unique per service at the infrastructure level.
