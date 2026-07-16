# Nexus Systems Overview

> A domain-level map of what runs, when it runs, and how it talks to itself. The platform began in late December 2025 and has run in production since February 2026. For the four-layer spine, the context diagram, and the external integration list, see [ARCHITECTURE.md](ARCHITECTURE.md). For every individual service, see the [components/](../components/) catalog.

## The four platform layers

Nexus is organized as four layers, and the sections below map to them. Ingestion feeds a customer data foundation, which feeds an intelligence layer, which is exposed alongside operators to an AI-agent tool layer. Full detail for each layer lives in [ARCHITECTURE.md](ARCHITECTURE.md#the-four-layer-platform); this document covers the operational cadence of each part.

| Layer | What runs here | Cadence |
|---|---|---|
| Ingestion | 9 heartbeats, nightly full-refresh, office-backend reads, storefront telemetry | 5 min to 24 hr, plus on-event |
| Customer data foundation | Contact catalog mirror, identity resolution spine, three-zone ERP model | nightly rebuilds |
| Intelligence | Demand forecasting (built, not activated), sales trends reporting, product knowledge system | on-demand and batch |
| AI-agent tool layer | MCP server, 117 tools, read-only SQL, gated writes | on-request |

## Layer 1: the 9 background heartbeat services

These are the services that make Nexus feel live. Each is a daemon thread with its own cadence, its own circuit breaker, and its own write path into the database. Running 9 of these concurrently is how the platform keeps a second-by-second view of the operational database current.

| Service | Cadence | What it does | What it writes |
|---|---|---|---|
| `product_stamp_heartbeat` (1,237 lines) | 5 min + 0-15s jitter | Delta-syncs products/SKUs/options from the hosted ERP using stamp-based queries. Phase A: REST upserts (no seat cost). Phase B: activates the HTML reader only for products that changed (consumes 1 ERP license seat). | `products`, `product_content`, `skus`, `product_options`, `sku_options`, `sync_changelog` |
| `inventory_heartbeat` (608 lines) | 5 min + 0-15s jitter | Polls the ERP's `/v1/skuInventory` for movement-date delta. Upserts 8 status columns: in_stock, backordered, reserved, assigned_sold, shipped, in_po, in_po_queue, in_transfer. | `inventory_levels`, `inventory_by_warehouse`, `sync_changelog` |
| `order_heartbeat` (950 lines) | 5 min + 0-15s jitter | Polls the ERP's REST API for new orders. Maintains an in-memory SKU cache (500 max) to avoid repeated DB lookups during a single tick. Brand routing: routes orders to the correct storefront brand via a numeric brand ID. | `order_headers`, `order_line_items`, `order_fulfillments`, `sync_changelog` |
| `monday_restock_heartbeat` (309 lines) | 5 min + 0-30s jitter | Reads "Estimated Restock Date" from the Monday.com Inventory Status Board. Writes restock dates back into `qc_tracked_skus` so the QC team knows what to prioritize. | `qc_tracked_skus` |
| `avalara_heartbeat` (330 lines) | 5 min + 0-15s jitter | Polls Avalara for new tax transactions using checkpoint delta. Creates ERP stub records and immediately enriches them via the REST API, so reconciliation has both sides (tax remitted and order issued) automatically. | `tax_recon_records` |
| `moosend_sync_heartbeat` (589 lines) | 15 min | Bi-directional merge: Moosend campaigns plus Monday.com status into the local `emails` table. Name normalization for matching, preheader backfill from HTML content. | `emails` |
| `msgraph_excel_heartbeat` (294 lines) | 15 min | Polls SharePoint for changes to a hosted pricing-and-mapping workbook using ETag-aware change detection. On change, downloads the file and feeds it to `erp_excel_sync`. | triggers `erp_excel_sync` |
| `deal_heartbeat` (779 lines) | 24 hr + 0-60s jitter | Nightly read of the ERP's `deal_manager.php` for every active deal. Captures a complete snapshot, diffs against the previous night, logs critical-field changes (coupon code, discount amount, active status) at elevated severity. | `deal_snapshots`, `deal_change_log` |
| `expo_fetch_heartbeat` (469 lines) | 24 hr | Auto-logs into the trade-show ticketing platform using a saved Playwright browser session, downloads the ticket export CSV, and feeds it to `expo_service` for import. | triggers `expo_service` |

Plus two orchestration services that are not heartbeats but sit in the same category:

- **`nightly_sync` (1,366 lines)**: runs at 1:30 AM UTC as a single 7-step pipeline with staggered 15-minute gaps between steps. Full-refresh sweep of products, then inventory, then order backfill (last 7 days), then tax certs, then purchase orders, then shipment drift, then activity pruning. This is the safety net that catches silent ERP edits that do not bump their modification stamps.
- **`startup_recovery` (100 lines)**: daemon thread that wakes 20 seconds after server startup, scans `api_health_log` for services that failed within the last 2 hours, and triggers `force_run()` on them in dependency order before regular schedules resume.

The newest ingestion source is **storefront telemetry**: a first-party event taxonomy that posts on-site behavior into Flask as it happens, rather than on a poll. Presence for that same storefront is poll-based and was capacity-analyzed on a small VPS (measured capacity in [METRICS.md](../METRICS.md)), which is why a persistent-connection tier was not added. See [ARCHITECTURE.md](ARCHITECTURE.md#the-presence-and-consent-edit-path-storefront).

## Layer 2: the customer data foundation

### The three database zones

Documented in [ARCHITECTURE.md](ARCHITECTURE.md#three-zone-data-model). Summary:

| Zone | Tables | Write path |
|---|---|---|
| **ERP Zone** | ~35 | Heartbeats only, never routes |
| **Relations Zone** (`rel_*`) | 16 | User writes through the dashboard |
| **Portal Zone** (`portal_*`) | 1 | Sync from an external portal instance |

### The contact catalog and identity spine

Two nightly-rebuilt systems sit on top of the ERP zone and turn raw records into a governed, identity-resolved base:

- **Customer contact catalog**: a governed PostgreSQL mirror of the full customer and contact base (current counts in [METRICS.md](../METRICS.md)). A nightly self-healing enumeration re-walks the source so the mirror repairs its own drift. Deterministic pure-SQL grouping identified the duplicate groups, and a staged verified-write remediation applied the corrections, complete June 2026.
- **Identity resolution engine**: Splink probabilistic record linkage collapses many contacts into one person. The nightly rebuild worker runs unattended only after that cycle's exclusion-flag review is complete, an honest gate rather than an unconditional automatic run. The resulting spine resolves those contacts into a deduplicated set of persons (current count in [METRICS.md](../METRICS.md)), with cannot-link invariants guarding known-distinct people from merging.

Number-level detail and the certified-build metrics live in [ARCHITECTURE.md](ARCHITECTURE.md#layer-2-customer-data-foundation).

## Layer 3: the intelligence layer

Three systems read the foundation and produce forecasts and reporting without writing back into the operational zones:

- **Demand forecasting**: classifies each item by demand pattern (ADI and CV2) and routes to AutoETS, Croston SBA, or a recent-mean fallback, with WAPE and MASE rolling-holdout backtesting and censoring correction from a 757K-row inventory ledger. Built and backtested, not activated in production.
- **Sales trends reporting**: a category-to-SKU drill-down matrix with signed year-over-year deltas, date-range and granularity controls, and CSV export; in production since July 6, 2026. The companion profitability view intentionally excludes SKUs with uncosted components rather than display inaccurate margins.
- **Product knowledge system**: option-graph decomposition to component SKUs, provenance-tracked spec harvest, interface-derived compatibility, a single content-review console (live June 26, 2026), and a one-fetch public product-page aggregate endpoint at roughly 300ms.

Detail and metrics live in [ARCHITECTURE.md](ARCHITECTURE.md#layer-3-intelligence).

## Layer 4: the AI-agent tool layer

An MCP server exposes 117 tools as verified in July 2026. Reads pass a dual-layer read-only SQL guard; writes are preview-then-confirm; a three-phase pre-deployment security gate runs before release. See [ARCHITECTURE.md](ARCHITECTURE.md#layer-4-ai-agent-tool-layer) and [ADR-021](../decisions/021-pre-deployment-security-audit-pattern.md).

## The service cluster map

A July 2026 re-measure counts roughly 160 service modules across the platform (see [METRICS.md](../METRICS.md)). The table below groups the original operational core by responsibility; the four-layer additions above extend it.

| Cluster | Notable files |
|---|---|
| Data pipeline / sync | 9 heartbeats plus `nightly_sync` |
| ERP low-level | `erp_rest_client.py` (872 lines), `erp_auth_service.py` (2,917, the second largest) |
| Pricing & sales | `pricing_service.py` (1,848) |
| Tax & compliance | `tax_recon_service.py` (3,906, the largest service in the core) |
| Orders & fulfillment | `po_sync_service.py` (1,067), `erp_order_sync.py` (697) |
| Shipping carriers | `tracking_service.py` (1,482), `usps_service.py` (1,395), `fedex_service.py` (1,055) |
| Product catalog | `catalog_service.py` (740), `option_display.py` (381) |
| Email marketing | `monday_service.py` (763), `moosend_service.py` (306) |
| Microsoft / Excel | `msgraph_client.py` (146), `msgraph_excel_heartbeat.py` (294) |
| Event management | `expo_fetch_heartbeat.py` (469), `expo_service.py` (615) |
| Connectors / IoT | `module_telemetry_service.py` (249), `netid_service.py` (447) |
| QC & testing | `qc_service.py` (1,885), `testing_service.py` (833) |
| Auth & users | `user_service.py` (985), `seat_monitor.py` (228) |
| Infrastructure | `api_health_service.py`, `cloudflare_service.py`, `redis_service.py`, `s3_service.py`, `cache_service.py`, `service_flags.py` |
| Reporting & monitoring | `activity_summary.py` (1,436), `sync_report_service.py` (504) |
| Review & feedback | `feedback_service.py` (543) |

## Cross-cutting patterns

Seven architectural patterns appear across three or more services. Each has its own ADR because each was a deliberate choice, not an accident of growth.

### 1. Per-entity operation locks with bounded LRU

Used in `pricing_service.py` (per product UUID), `deal_heartbeat.py`, and `avalara_heartbeat.py`. A `threading.Lock` is created per entity and stored in an `OrderedDict` capped at 500 entries. On overflow, the oldest unlocked entries are evicted. Acquisition is non-blocking: if already locked, the operation returns immediately with an "in progress" signal rather than queuing. A global lock was the alternative, and it would have serialized concurrent pricing operators working on different products, which violates the principle that operators should not block each other. See [ADR-008](../decisions/008-per-product-operation-locks.md).

### 2. Circuit breaker with service-flags API integration

Every heartbeat maintains a `_consecutive_errors` counter and checks `is_service_disabled()` at the top of every tick. After 10 consecutive errors, `disable_service(name)` writes to a file-backed flag visible across all Gunicorn workers atomically, and a WARNING-level log announces the trip. The flag survives process restart, so a service that was in a bad state when the server went down stays disabled until it is explicitly re-enabled through the service-flags admin page. The threshold of 10 was chosen from production experience with the inventory heartbeat. See [ADR-005](../decisions/005-circuit-breakers-on-external-apis.md).

### 3. Thundering-herd stagger on startup

Every heartbeat's first tick sleeps a random interval (`random.uniform(30, 120)` for deal_heartbeat, `(10, 60)` for avalara, `(15, 45)` for tracking) before starting. The comment in the deal heartbeat reads: "Stagger first tick to avoid thundering herd across services/workers." The pattern and the reasoning are identical across the tier.

### 4. Checkpoint and hydration on restart

The background heartbeat services implement `_hydrate()`: on startup they query `api_health_log` via `api_health_service.hydrate_last_run` to restore last run time, count, and duration. The request-triggered pricing service does not need this, but for the background tier the pattern is universal. The effect is that a process restart does not reset the visible operational state; the dashboard shows the same "last ran at" timestamp as before the restart.

### 5. SSE plus POST dual-path with fallback signal

Every long-running operation in `pricing_service.py` exists in two forms: a blocking POST handler and a Server-Sent Events generator that yields per-item progress events. Both paths acquire the same per-product threading lock, so they are race-safe. If the SSE path cannot acquire a database connection (pool exhaustion), it yields `{'event': 'error', 'retry_post': True}`, a signal for the frontend to switch cleanly to the POST fallback without treating the operation as failed. The fallback signal exists so that if the connection pool is exhausted mid-operation, including during a concurrent sale revert, the SSE path degrades cleanly to the POST path instead of surfacing as a failure. The SSE generator uses `get_standalone_connection()` because Flask's request-teardown fires when the handler returns while the generator keeps yielding afterward. See [ADR-016](../decisions/016-sse-post-dual-path.md) and [ADR-008](../decisions/008-per-product-operation-locks.md).

### 6. Idempotent schema migrations with `ADD COLUMN IF NOT EXISTS`

Every service that owns tables runs its own inline DDL at startup, guarded by `IF NOT EXISTS` and wrapped in `try / except OperationalError`. `tax_recon_service.py` alone has 13 named migration functions, each safe to run every time. There is no separate migration tool. Every service manages its own schema evolution, version-controlled by the code that uses those tables. After the PostgreSQL migration, a PostgreSQL advisory lock (`pg_try_advisory_lock(43)`) was added at the top of the startup maintenance routine so only one Gunicorn worker runs the DDL batch while the other waits or skips. See [ADR-019](../decisions/019-idempotent-schema-migrations.md).

### 7. `sync_changelog` as the cross-cutting activity feed

One table. Every service writes to it. QC session completions write with `entity_type='qc_event'`. Pricing writes via `_record_price_change()`. Tracking writes via `_log_shipment_transition()`. Heartbeats write field-level diffs on every change. One `SELECT` reconstructs a chronological event timeline across pricing, QC, logistics, tax, and email, without joining a dozen per-domain audit tables. `api_health_log` is the parallel operations log, kept deliberately separate: `sync_changelog` records what changed in the business, `api_health_log` records what the system did operationally. They correlate by timestamp but have different lifecycles. See [ADR-020](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md).

## The operations dashboard

The operator-facing surface is a set of static HTML pages loaded directly from Flask with no server-side templating. Every page bootstraps itself via ES modules and hits `/api/v1/*` for data. See the [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) companion document for the full story.

Featured pages by scale:

- `product.html` (5,603 lines): five-tab product detail editor covering Overview, SKUs, Options, Content, and Price History. The flagship page for in-browser rich editing.
- `sales.html` (3,547 lines): sale campaign manager with SSE-driven apply/revert progress.
- `linking.html` (2,632 lines): product-to-platform linking with drag-and-drop.
- `email-preview.html` (2,620 lines): marketing email preview before Moosend push.
- `sync-log.html` (2,354 lines): ERP sync history with field-diff drill-down.
- `price-increase.html` (2,271 lines): bulk price update workflow with SSE progress.
- `shipping.html` (2,218 lines): FedEx/USPS label generation workstation.
- `system.html` (2,016 lines): system health dashboard with Chart.js service trend lines.

Every page authenticates through `page-guard.js`, which calls `/api/auth/me` once per page load and caches the result on `window._nexusAuthPromise` so both `cn-shell` (navigation rendering) and the page init share a single round-trip.