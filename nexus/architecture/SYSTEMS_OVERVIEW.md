# Nexus -- Systems Overview

> A domain-level map of what runs, when it runs, and how it talks to itself. For the contextual diagram and the external integration list, see [ARCHITECTURE.md](ARCHITECTURE.md). For every individual service, see the [components/](../components/) catalog.

## The 9 Background Heartbeat Services

Each heartbeat is a daemon thread with its own cadence, its own circuit breaker, and its own write path into the database. Together, they keep the 145-table operational database current with near-real-time data from external systems.

| Service | Cadence | What it does | What it writes |
|---|---|---|---|
| `product_stamp_heartbeat` | 5 min + 0-15s jitter | Delta-syncs products/SKUs/options from the ERP using stamp-based queries. Phase A: REST upserts (no seat cost). Phase B: activates the HTML scraper only for products that changed (consumes 1 ERP license seat). | `products`, `product_content`, `skus`, `product_options`, `sku_options`, `sync_changelog` |
| `inventory_heartbeat` | 5 min + 0-15s jitter | Polls the ERP `/v1/skuInventory` for movement-date delta. Upserts 8 status columns: in_stock, backordered, reserved, assigned_sold, shipped, in_po, in_po_queue, in_transfer. | `inventory_levels`, `inventory_by_warehouse`, `sync_changelog` |
| `order_heartbeat` | 5 min + 0-15s jitter | Polls the ERP REST API for new orders. Maintains an in-memory SKU cache (500 max) to avoid repeated DB lookups during a single tick. Brand routing: `brand_id=1` to the primary brand, `brand_id=5` to the wireless product line. | `order_headers`, `order_line_items`, `order_fulfillments`, `sync_changelog` |
| `pm_restock_heartbeat` | 5 min + 0-30s jitter | Reads "Estimated Restock Date" from the PM tool's Inventory Status Board. Writes restock dates back into `qc_tracked_skus` so the QC team knows what to prioritize. | `qc_tracked_skus` |
| `tax_engine_heartbeat` | 5 min + 0-15s jitter | Polls the tax engine for new tax transactions using checkpoint delta. Creates ERP stub records and immediately enriches them via the REST API -- so reconciliation has both sides (tax remitted + order issued) automatically. | `tax_recon_records` |
| `email_sync_heartbeat` | 15 min | Bi-directional merge: email platform campaigns + PM tool status to local `emails` table. Name normalization for matching, preheader backfill from HTML content. | `emails` |
| `msgraph_excel_heartbeat` | 15 min | Polls SharePoint for changes to the product pricing spreadsheet using ETag-aware change detection. On change, downloads the file and feeds it to `erp_excel_sync`. | triggers `erp_excel_sync` |
| `deal_heartbeat` | 24 hr + 0-60s jitter | Nightly scrape of the ERP's deal management page for every active deal. Captures a complete snapshot, diffs against the previous night, logs critical-field changes (coupon code, discount amount, active status) at elevated severity. | `deal_snapshots`, `deal_change_log` |
| `expo_fetch_heartbeat` | 24 hr | Auto-logs into the industry expo platform using a saved Playwright browser session, downloads the ticket export CSV, and feeds it to `expo_service` for import. | triggers `expo_service` |

Plus two orchestration services that aren't heartbeats but are in the same category:

- **`nightly_sync`** -- runs at 1:30 AM UTC as a single 7-step pipeline with staggered 15-minute gaps between steps. Full-refresh sweep of products to inventory to order backfill (last 7 days) to tax certs to purchase orders to shipment drift to activity pruning. This is the safety net that catches silent ERP edits that don't bump their modification stamps.
- **`startup_recovery`** -- daemon thread that wakes 20 seconds after server startup, scans `api_health_log` for services that failed within the last 2 hours, and triggers `force_run()` on them in dependency order before regular schedules resume.

## The three database zones

Documented in [ARCHITECTURE.md](ARCHITECTURE.md#three-zone-data-model). Summary:

| Zone | Tables | Write path |
|---|---|---|
| **ERP Zone** | ~35 | Heartbeats only -- never routes |
| **Relations Zone** (`rel_*`) | 16 | User writes through the dashboard |
| **Portal Zone** (`portal_*`) | 1 | Sync from external company portal RDS |

Total: 145 unique tables across the master schema.

## The service cluster map

58 services in `api/services/`, grouped by responsibility:

| Cluster | Service count | Notable files |
|---|---|---|
| Data pipeline / sync | 10 | 9 heartbeats + `nightly_sync` |
| ERP low-level | 4 | `erp_rest_client.py`, `erp_auth_service.py` |
| Pricing & sales | 2 | `pricing_service.py` |
| Tax & compliance | 4 | `tax_recon_service.py` |
| Orders & fulfillment | 4 | `po_sync_service.py`, `erp_order_sync.py` |
| Shipping carriers | 4 | `tracking_service.py`, `usps_service.py`, `fedex_service.py` |
| Product catalog | 5 | `catalog_service.py`, `option_display.py` |
| Email marketing | 3 | `pm_service.py`, `email_platform_service.py` |
| Microsoft / Excel | 3 | `msgraph_client.py`, `msgraph_excel_heartbeat.py` |
| Event management | 2 | `expo_fetch_heartbeat.py`, `expo_service.py` |
| Connectors / IoT | 2 | `module_telemetry_service.py`, `netid_service.py` |
| QC & testing | 2 | `qc_service.py`, `testing_service.py` |
| Auth & users | 3 | `user_service.py`, `seat_monitor.py` |
| Infrastructure | 6 | `api_health_service.py`, `cloudflare_service.py`, `redis_service.py`, `s3_service.py`, `cache_service.py`, `service_flags.py` |
| Reporting & monitoring | 3 | `activity_summary.py`, `sync_report_service.py` |
| Review & feedback | 1 | `feedback_service.py` |
| Miscellaneous | 1 | `team_service.py` |

## Cross-cutting patterns

Seven architectural patterns appear across three or more services. Each has its own ADR because each was a deliberate choice, not an accident of growth.

### 1. Per-entity operation locks with bounded LRU

Used in `pricing_service.py` (per product UUID), `deal_heartbeat.py`, and `tax_engine_heartbeat.py`. A `threading.Lock` is created per entity and stored in an `OrderedDict` capped at 500 entries. On overflow, the oldest unlocked entries are evicted. Non-blocking acquire -- if already locked, the operation returns immediately with an "in progress" signal rather than queuing.

The rejected alternative was a global lock. It would have serialized all concurrent pricing operators working on different products, which violates the "operators shouldn't block each other" principle. See [ADR-008](../decisions/008-per-product-operation-locks.md).

### 2. Circuit breaker with service-flags API integration

Every heartbeat maintains a `_consecutive_errors` counter and checks `is_service_disabled()` at the top of every tick. After 10 consecutive errors, `disable_service(name)` is called, which writes to a file-backed flag visible across all Gunicorn workers atomically. A log at WARNING level announces the trip. The flag survives process restart, so a service that was in a bad state when the server went down stays disabled until explicitly re-enabled through the service flags admin page.

The threshold of 10 was chosen based on production experience with the inventory heartbeat. See [ADR-005](../decisions/005-circuit-breakers-on-external-apis.md).

### 3. Thundering-herd stagger on startup

Every heartbeat's first tick sleeps a random interval (`random.uniform(30, 120)` for deal_heartbeat, `(10, 60)` for avalara, `(15, 45)` for tracking) before starting. The explicit comment in the deal heartbeat reads: *"Stagger first tick to avoid thundering herd across services/workers"*. Identical pattern across the tier, identical reasoning.

### 4. Checkpoint / hydration on restart

All three heartbeat services implement `_hydrate()` -- on startup, they query `api_health_log` via `api_health_service.hydrate_last_run` to restore last run time, count, and duration. `pricing_service` doesn't need this (it's request-triggered, not time-triggered), but for the background tier the pattern is universal. The net effect is that a process restart doesn't reset the visible operational state -- the dashboard shows the same "last ran at" timestamp as before the restart.

### 5. SSE + POST dual-path with fallback signal

Every long-running operation in `pricing_service.py` exists in two forms: a blocking POST handler and a Server-Sent Events generator that yields per-item progress events. Both paths acquire the same per-product threading lock, so they're race-safe. If the SSE path can't acquire a database connection (pool exhaustion), it yields `{'event': 'error', 'retry_post': True}` -- a signal to the frontend to cleanly switch to the POST fallback without thinking the operation failed. The SSE generator uses `get_standalone_connection()` because Flask's request-teardown fires when the handler returns, but the generator continues yielding afterward.

This pattern was hardened after a sale revert operation revealed a concurrency gap in the SSE fallback path. See [ADR-016](../decisions/016-sse-post-dual-path.md) and [ADR-008](../decisions/008-per-product-operation-locks.md).

### 6. Idempotent schema migrations with `ADD COLUMN IF NOT EXISTS`

Every service that owns tables runs its own inline DDL at startup, guarded by `IF NOT EXISTS` and wrapped in `try / except OperationalError`. `tax_recon_service.py` alone has 13 named migration functions. Each is safe to run every time -- re-running a migration that already applied is a no-op. There is no separate migration tool (Alembic, Flyway). Every service manages its own schema evolution, version-controlled by the code that uses those tables.

This is idempotent by construction. After the PostgreSQL migration, a PostgreSQL advisory lock (`pg_try_advisory_lock(43)`) was added at the top of the startup maintenance routine so only one Gunicorn worker runs the DDL batch -- the other worker waits or skips. See [ADR-019](../decisions/019-idempotent-schema-migrations.md).

### 7. `sync_changelog` as the cross-cutting activity feed

One table. Every service writes to it. QC session completions write with `entity_type='qc_event'`. Pricing writes via `_record_price_change()`. Tracking writes via `_log_shipment_transition()`. Heartbeats write field-level diffs on every change. One `SELECT` can reconstruct a chronological event timeline across pricing, QC, logistics, tax, and email -- without joining a dozen per-domain audit tables.

`api_health_log` is the parallel operations log. The two are deliberately separate: `sync_changelog` records *what changed in the business*, `api_health_log` records *what the system did operationally*. They correlate by timestamp but have different lifecycles. See [ADR-020](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md).

## The 56-page dashboard

The operator-facing surface. One HTML file per page, loaded directly from Flask with no server-side templating -- every page is static HTML that bootstraps itself via ES modules and hits `/api/v1/*` for data. See the [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) companion document for the full story.

Featured pages by scale:

- `product.html` -- five-tab product detail editor covering Overview, SKUs, Options, Content, and Price History. The flagship page.
- `sales.html` -- sale campaign manager with SSE-driven apply/revert progress.
- `linking.html` -- product-to-platform linking with drag-and-drop.
- `email-preview.html` -- marketing email preview before email platform push.
- `sync-log.html` -- ERP sync history with field-diff drill-down.
- `price-increase.html` -- bulk price update workflow with SSE progress.
- `shipping.html` -- FedEx/USPS label generation workstation.
- `system.html` -- system health dashboard with Chart.js service trend lines.

All 56 pages authenticate through `page-guard.js`, which calls `/api/auth/me` once per page load and caches the result on `window._nexusAuthPromise` so both `cn-shell` (navigation rendering) and the page init can share a single round-trip.