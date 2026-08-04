# Nexus Technology Stack

> Every technology listed here was verified against `api/requirements.txt`, `api/config.py`, `api/utils/db.py`, `connector/requirements.txt`, or import statements in service files during a July 2026 review. The platform began in late December 2025 and has run in production since February 2026. Older documentation says SQLite; that is out of date. The migration to PostgreSQL happened on 2026-03-01 (see [ADR-002](../decisions/002-postgresql-migration-with-sqlite3-compat-shim.md)). PostgreSQL via PgBouncer remains the base of the stack.

~260 service modules / ~975 routes / ~215K lines of Python (August 2026 re-measure), see METRICS.md.

## Main Nexus API (runs on the production VPS)

### Runtime

| Component | Choice | Why |
|---|---|---|
| Language | Python 3 | Ecosystem coverage for every integration the platform needed (Avalara, FedEx, USPS, Monday, Microsoft Graph). The stdlib carries enough that the dependency surface stays small. |
| Web framework | Flask 2.3.3 | Flat route decorators match the shape of the API surface. Async, WebSockets, and Pydantic validation were not needed here, so Flask stayed out of the way. |
| WSGI server | Gunicorn 21.2.0 | Runs gthread workers on a small VPS. The switch to gthread came after sale-day load testing surfaced connection exhaustion under peak traffic. See [ADR-026](../decisions/026-vps-sizing-for-sale-day-traffic-spikes.md). |
| Reverse proxy | nginx | Handles TLS, gzip, and request buffering. Sits behind a CDN. |
| CDN + edge | CDN edge cache | Edge caching for public feeds (catalog, events, sales). `cloudflare_service.py` purges specific URLs after edits. |

### Database

| Component | Choice | Why |
|---|---|---|
| Primary database | **PostgreSQL** | Migrated from SQLite on 2026-03-01: its single-writer model could not sustain concurrent backfills without serializing writes into multi-second stalls, so Postgres replaced it to remove the single-writer bottleneck. |
| Connection pooling | `psycopg2.pool.ThreadedConnectionPool` (min=1, max=8 per worker) | Flask teardown fires on request end; keeping persistent pooled connections solved the open-transaction problem that was blocking writers. |
| Compatibility layer | Custom `PgConnection` wrapper class in `api/utils/db.py` | Every service already used the sqlite3-style `conn.execute(sql, params)` shortcut. Rather than touching every call site, the wrapper exposes the same API backed by a psycopg2 `RealDictCursor`. Over 200 call sites migrated with no rewrites. See [ADR-002](../decisions/002-postgresql-migration-with-sqlite3-compat-shim.md). |
| External pooling (production) | **PgBouncer** | A second layer of pooling between the app and Postgres for cross-worker reuse. This is the base pooling layer in production. |
| Derived search index | **Typesense** | A typo-tolerant search index over the catalog and contact data, rebuilt from the PostgreSQL source of truth. Search stays off the primary query path and Postgres stays authoritative. Postgres full-text was considered and did not fit the typo-tolerance and ranking needs at this size; a hosted search vendor was set aside to keep the data first-party. |
| Fulfillment read replica | AWS RDS MySQL (`pymysql` 1.1.0) | Read-only connection via `fulfillment_db.py` for hazmat order lookups. Separate schema, separate credentials, enforced read-only. |

### Cache, queue, and cross-worker state

| Component | Choice | Why |
|---|---|---|
| Cache / rate limiter | Redis (`redis >= 5.0`) | `redis_service.py` is a shared singleton with graceful fallback if Redis is down. Used for `Flask-Limiter` rate-limit counters and for sharing the hosted ERP's auth session across workers, so a license seat is not burned on every worker. |
| In-memory cache | Custom `cache_service.py` | TTL-based, per-worker. Used for small hot-path lookups like catalog keys. |
| Cross-worker feature flags | File-based `service_flags.py` | Disables a misbehaving heartbeat across all Gunicorn workers atomically. Used by the circuit-breaker pattern to externalize the breaker state. |

### HTTP clients and parsing

| Component | Choice | Why |
|---|---|---|
| HTTP (REST APIs) | `requests >= 2.31` | Used by `erp_rest_client.py`, carrier clients, and most integration services. `requests.Session` provides connection pooling. |
| HTTP (scraping + OAuth) | `httpx 0.27.2` | `erp_auth_service.py` and `portal_client.py` use httpx-specific features (async primitives, finer timeout control). Both clients run side by side rather than forcing one paradigm across services with different needs. |
| HTML parsing | `beautifulsoup4 >= 4.12` | The ERP's office backend returns PHP-rendered HTML. BeautifulSoup handles the deal_manager, warehouse_manager, and po_manager pages consistently. |
| Excel parsing | `openpyxl >= 3.1` and `pandas >= 2.0` | openpyxl for structured cell-by-cell reads (trade-show ticket imports). pandas for bulk dataframes (Microsoft Graph Excel sync). |
| Client-side encryption | `pycryptodome >= 3.20` | The ERP's login flow requires client-side encrypted credential submission; the auth service implements the vendor's required scheme. |
| PDF generation | `reportlab >= 4.0` + `PyPDF2 >= 3.0` | `hazmat_pdf.py` overlays order data on the official IATA Shipper's Declaration template using SVG coordinate mapping. |

### Address validation

| Component | Choice | Why |
|---|---|---|
| Address classification | FedEx and Shippo address APIs | Carrier APIs give authoritative residential/commercial classification, so address correctness does not depend on a hand-maintained database. FedEx served as bulk primary with Shippo as tie-breaker in the contact-catalog remediation pass (~31,650 staged, verified flag corrections, completed June 2026). |

### Background processing

| Component | Choice | Why |
|---|---|---|
| Scheduler | `APScheduler >= 3.10` | Used alongside plain `threading.Thread` loops. Each heartbeat service owns its own loop with a jittered `time.sleep` between ticks. |
| Browser automation | `playwright >= 1.40` | Required for trade-show ticketing platform downloads, which do not have an API. Headless browser with saved session cookies. |
| Structured logging | `loguru >= 0.7` | Replaces stdlib logging in every service. Used for structured fields (service name, trigger source, duration, outcome) that flow into the activity feed. |
| Image processing | `Pillow >= 10.0` | WebP conversion on sale image uploads before pushing to object storage. |

### Data foundation and intelligence

These run on a dedicated worker VPS so heavier batch jobs do not compete with request traffic on the production VPS.

| Component | Choice | Why |
|---|---|---|
| Probabilistic record linkage | **Splink** | Collapses many contacts into one real person. Deterministic pure-SQL grouping already handles exact and near-exact duplicates cheaply and repeatably; Splink scores the fuzzy pairs that deterministic rules drop (a shortened name, a changed address, a typo). A hand-run merge queue was considered and did not fit the contact volume. Cannot-link invariants prevent known-distinct people from merging. |
| Classical time-series forecasting | AutoETS, Croston SBA, recent-mean | Each item is classified by demand pattern (ADI and CV2) and routed to the model that fits: AutoETS for series with regular signal, Croston SBA for intermittent demand, recent-mean for the sparsest items. Deep-learning forecasting did not fit this context because per-SKU history is short and the output has to be explainable against a manual planning curve. |
| Backtesting | WAPE and MASE on rolling holdout | Accuracy is scored out-of-sample on rolling holdout rather than in-sample fit, with censoring correction from a 757K-row inventory ledger so stockouts are not read as low demand. Built and backtested; not activated in production. |

### AI-agent tool layer

| Component | Choice | Why |
|---|---|---|
| Agent interface | Model Context Protocol server runtime | Exposes 118 tools (verified August 2026) that let an AI agent operate the platform. A dual-layer read-only SQL guard keeps generated queries from mutating data, and every write is preview-then-confirm so nothing applies without explicit approval. A three-phase pre-deployment security gate runs before release. See [ADR-021](../decisions/021-pre-deployment-security-audit-pattern.md). |

### Cloud services

| Component | Choice | Why |
|---|---|---|
| File storage | AWS S3 (`boto3 >= 1.34`) | Presigned PUT URLs for sale images and video uploads. `s3_service.py` hides bucket and prefix mapping from clients. |
| Identity / OAuth | Company portal JWT | Only company employees with the `EMPLOYEE` role in their JWT can reach the dashboard. `portal_client.py` validates tokens and creates users lazily on first login. |
| Email delivery | SMTP relay via Google Workspace | `email_service.py` uses `smtplib` with an App Password. The layer is thin because Google handles delivery. |
| Microsoft integration | `msal` (lazy import in `msgraph_client.py`) | MSAL refresh-token flow for SharePoint/OneDrive file access. Read-only (Files.Read scope); Nexus never writes back to SharePoint. |
| Notifications | Discord webhooks | Plain POST to a webhook URL. Used by `coupons.py` when a new coupon is created. No SDK; it is just a URL. |

### Deployment

- **Local dev:** a Windows workstation running Flask on a local dev port.
- **Staging:** an internal staging server.
- **Production:** a small VPS behind a CDN, with a companion dedicated worker VPS for heavier background jobs (identity resolution rebuilds, forecast backtests).

Deploys flow from local, to staging, to production. Each environment has its own configuration with distinct API keys and database URLs.

## Nexus Connector (ships to customer PCs as a signed Windows executable)

The connector is a separate application from the main API. It runs on the customer's PC, manages wireless hardware modules over 802.15.4 radio, and syncs test results back to the Nexus API.

### Two-process architecture

The connector splits into a Python 3 UI layer and a Python 2.7 radio bridge. The split is a hard constraint, not a preference: SNAPconnect, the library that talks to the radio, is Python 2.7-only and has no Python 3 port. Rather than freezing the whole app on Python 2.7, the bridge is isolated to a Tornado HTTP subprocess on port 9101, and the Python 3 Flask app on port 9100 talks to it over localhost HTTP. Clean process boundary, no pickling, no version shim. See [ADR-022](../decisions/022-python-27-bridge-isolation-via-http-subprocess.md).

### Connector stack

| Component | Choice | Why |
|---|---|---|
| UI language | Python 3 | All the modern parts of the connector (BLE, Flask, outbox sync, OAuth) run here. |
| UI web framework | Flask 3.x | A newer major version than the main API (which is on 2.3). The connector was bootstrapped more recently, on Flask 3. |
| UI library | vanilla Web Components (custom elements), no framework | Matches the main dashboard's approach. Three tabs (two hardware brands plus Hazmat) as independent custom elements. |
| Bridge language | Python 2.7 | Hard constraint from SNAPconnect. |
| Bridge framework | Tornado | Already part of the SNAPconnect runtime; no added dependency. |
| Radio library | SNAPconnect (Synapse Wireless) | The library that speaks the SNAP 802.15.4 protocol. Runs inside the Python 2.7 subprocess only. |
| BLE | `bleak >= 0.21` | Python 3, async. Runs on a dedicated background asyncio thread isolated from Flask's WSGI request thread. Used for hardware module testing. |
| System tray | `pystray + Pillow` | Windows tray icon and right-click menu. |
| Local storage | SQLite | `bridge_events.db` (bridge event log, session registry, module identity cache), `test_records.db` (hardware test sessions), and a local module DB. All confined to the customer's PC. |
| Packaging | PyInstaller (single-folder) | `bootstrapper.spec` with `upx=False` on purpose: UPX packing triggers AV false positives that compound the unsigned-binary reputation problem. |
| Code signing | Azure Trusted Signing (Windows) plus Apple Developer ID (macOS), planned, in the low hundreds of dollars a year total | Microsoft's March 2024 reputation-policy change made traditional EV certificates stop providing instant SmartScreen bypass. Azure Trusted Signing does. See [ADR-023](../decisions/023-azure-trusted-signing-over-ov-ev-cert.md). |

### Connector to Nexus sync

The connector never calls the customer-facing company portal. It talks only to the Nexus API. Sync uses the outbox pattern: every test session gets a UUID at creation time, is persisted locally first, and a background thread pushes unsynced records every 30 seconds with exponential backoff (30s, 60s, 120s, up to 600s, with a 10-retry ceiling). HTTP 400/422 is treated as permanent failure so malformed data does not loop forever. The VPS deduplicates on the UUID. Authentication is a SHA256-hashed API key per connector instance.

## Dashboard UI (serves from the Flask API)

### No framework, no build step

The dashboard is vanilla JavaScript with ES modules loaded directly in the browser: no React, Vue, Angular, Svelte, TypeScript, Vite, Webpack, Rollup, or esbuild. The tradeoff is that heavy pages (`product.html` is 5,603 lines) contain all their logic inline. The benefit is that every file is readable as-is, edit-to-browser iteration is instant with no build step, and there is no build tooling to maintain or upgrade.

### Shared infrastructure

| Component | Choice | Why |
|---|---|---|
| Shell component | `<cn-shell>`, a native Web Component (1,037 lines) | Handles sidebar, header, environment badge, OAuth UI, ERP seat-status polling, feedback button, and mobile menu on every page. One element; every page declares `<cn-shell page="x">`. |
| Auth flow | Company portal OAuth via popup plus `window.postMessage` (`auth.js`, 372 lines) | No iframe redirect dance. The popup posts a JWT back to the opener, which stashes it in `sessionStorage` for external API calls. Server-side auth is separate (Flask session cookies). |
| Page access guard | `page-guard.js` (153 lines) | Calls `/api/auth/me` on every protected page. Admin users bypass; regular users are gated on the `user.page_access` array. The result is cached on `window._nexusAuthPromise` so `cn-shell` and the page init do not both make the same request. |
| Shared data layer | `data.js` (1,745 lines) | Wraps all `/api/v1/*` calls. Every page imports named functions (`getProducts`, `getStats`) rather than calling `fetch()` directly. `fetchJSON()` handles a 401 to redirect universally. |
| Charts | Chart.js (vendored, not CDN) | `chart-theme.js` reads CSS custom properties at runtime and sets Chart.js global defaults, so charts re-theme automatically when tokens change. |

### Design system

Three-layer CSS, all custom, no Tailwind or Bootstrap:

- `tokens.css` (375 lines): CSS custom properties for colors, typography, spacing, shadows, z-index, animation. Single source of truth.
- `base.css`: opinionated reset plus body defaults.
- `components.css`: cards, stat-cards, buttons, badges, tables, forms.

Light mode only in the main dashboard. The `styleguide.html` demo is the one place `data-theme="dark"` appears.

### Real-time features

Three pages use Server-Sent Events (`EventSource`) for long-running backend operations:

- `sales.html`: sale activation/deactivation progress
- `price-increase.html`: bulk price update progress
- `firmware.html`: device flashing progress

SSE is used over WebSockets because the traffic is one-directional (server to client) and the existing Flask request path handles it with `yield` generators.

### Passive diagnostics

`bug-capture.js` (460 lines) loads on every page via `cn-shell`. It intercepts `console.log/warn/error` (50-entry rolling buffer), listens for `window.onerror` and `unhandledrejection`, tracks interaction breadcrumbs (clicks, keys, scroll, focus, navigation), watches overlay appearance via `MutationObserver`, and captures viewport and connection info. When a user clicks the feedback button, this context is attached to the bug report automatically, with no extra work for the user.

## What is deliberately NOT in the stack

| Not here | Why |
|---|---|
| ORM (SQLAlchemy, Tortoise) | Raw SQL is idiomatic throughout. An ORM would add a layer for a codebase whose queries are already well understood. |
| TypeScript | Same reason as no JS framework: the build-step cost exceeds the type-safety benefit at this size. |
| GraphQL server | The REST route surface covers every frontend need; GraphQL would add a layer for no gain. |
| Separate migration tool (Alembic, Flyway) | Each service owns its own inline `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS`, guarded by an `OperationalError` catch. Idempotent by construction. See [ADR-019](../decisions/019-idempotent-schema-migrations.md). |
| Message broker (RabbitMQ, Kafka, Redis Streams) | Nothing in the system needs ordered event streams. The `price_queue` table is a 3-state write-back buffer that replaces a broker for the one place it would have been tempting. |
| Celery or RQ | Heartbeats are threading loops; long-running operations stream via SSE. No need for a separate task-queue process. |
| Deep-learning demand forecasting | Per-SKU history is short and the forecast has to be explainable against a manual planning curve, so classical time-series models fit this context and a neural approach did not. |
| Stripe SDK | Stripe data arrives as CSV exports processed by `tax_recon_service.py`. Not a live API integration, just a data source. |
