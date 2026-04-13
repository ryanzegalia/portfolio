# Nexus -- Technology Stack

> Technologies verified against source code. See [ADR-002](../decisions/002-postgresql-migration-with-sqlite3-compat-shim.md) for the SQLite-to-PostgreSQL migration.

## Main Nexus API (runs on production VPS)

### Runtime

| Component | Choice | Why |
|---|---|---|
| Language | Python 3 | Ecosystem coverage for every integration we needed (tax engine, FedEx, USPS, PM tool, MS Graph). Ships with enough stdlib that the dependency surface stays small. |
| Web framework | Flask 2.3.3 | Flat route decorators map cleanly to the API surface. The system doesn't need async, WebSockets, or Pydantic validation -- Flask stays out of the way. |
| WSGI server | Gunicorn 21.2.0 | Two sync workers on a 1.9GB VPS. Switched to gthread workers after sale-day load testing revealed connection exhaustion under peak traffic -- see [ADR-026](../decisions/026-vps-sizing-for-sale-day-traffic-spikes.md). |
| Reverse proxy | nginx | Handles TLS, gzip, request buffering. Sits behind Cloudflare. |
| CDN + edge | Cloudflare | Edge caching for public feeds (catalog, events, sales). `cloudflare_service.py` purges specific URLs after edits. |

### Database

| Component | Choice | Why |
|---|---|---|
| Primary database | **PostgreSQL** | Migrated from SQLite after SQLite's single-writer model started causing 30-second request hangs during concurrent backfills. |
| Connection pooling | `psycopg2.pool.ThreadedConnectionPool` (min=1, max=8 per worker) | Flask teardown fires on request end; keeping persistent pooled connections solved the open-transaction problem that was blocking writers. |
| Compatibility layer | Custom `PgConnection` wrapper class in `api/utils/db.py` | Every service already used the sqlite3-style `conn.execute(sql, params)` shortcut. Rather than touching every call site, the wrapper exposes the same API backed by a psycopg2 `RealDictCursor`. 200+ call sites migrated with zero rewrites. See [ADR-002](../decisions/002-postgresql-migration-with-sqlite3-compat-shim.md). |
| External pooling (production) | PgBouncer | Adds a second layer of pooling between the app and Postgres for cross-worker reuse. |
| Fulfillment read replica | AWS RDS MySQL (`pymysql` 1.1.0) | Read-only connection via `fulfillment_db.py` for hazmat order lookups. Separate schema, separate credentials, enforced read-only. |

### Cache, queue, and cross-worker state

| Component | Choice | Why |
|---|---|---|
| Cache / rate limiter | Redis (`redis >= 5.0`) | `redis_service.py` is a shared singleton with graceful fallback if Redis is down. Used for `Flask-Limiter` rate-limit counters and for sharing the ERP auth session across workers so we don't burn a license seat on every worker. |
| In-memory cache | Custom `cache_service.py` | TTL-based, per-worker. Used for small hot-path lookups like catalog keys. |
| Cross-worker feature flags | File-based `service_flags.py` | Allows disabling a misbehaving heartbeat across all Gunicorn workers atomically. Used by the circuit breaker pattern to externalize the breaker state. |

### HTTP clients and parsing

| Component | Choice | Why |
|---|---|---|
| HTTP (REST APIs) | `requests >= 2.31` | Used by `erp_rest_client.py`, carrier clients, and most integration services. `requests.Session` provides connection pooling. |
| HTTP (scraping + OAuth) | `httpx 0.27.2` | `erp_auth_service.py` and `portal_client.py` need httpx-specific features (async primitives, finer timeout control). Both clients run side by side rather than forcing one paradigm across services with different needs. |
| HTML parsing | `beautifulsoup4 >= 4.12` | The ERP's office backend returns PHP-rendered HTML. BeautifulSoup handles the deal management, warehouse, and PO pages consistently. |
| Excel parsing | `openpyxl >= 3.1` and `pandas >= 2.0` | openpyxl for structured cell-by-cell reads (expo ticket imports). pandas for bulk dataframes (Microsoft Graph Excel sync). |
| RSA encryption | `pycryptodome >= 3.20` | The ERP's login uses RSA-encrypted password submission with PKCS1 v1.5 padding. `erp_auth_service.py` imports `Crypto.PublicKey.RSA` and `Crypto.Cipher.PKCS1_v1_5` directly. |
| PDF generation | `reportlab >= 4.0` + `PyPDF2 >= 3.0` | `hazmat_pdf.py` overlays order data on the official IATA Shipper's Declaration template using SVG coordinate mapping. |

### Background processing

| Component | Choice | Why |
|---|---|---|
| Scheduler | `APScheduler >= 3.10` | Used alongside plain `threading.Thread` loops. Each heartbeat service owns its own loop with a jittered `time.sleep` between ticks. |
| Browser automation | `playwright >= 1.40` | Required for industry expo ticket downloads, which don't have an API. Headless browser with saved session cookies. |
| Structured logging | `loguru >= 0.7` | Replaces stdlib logging in every service. Used for structured fields (service name, trigger source, duration, outcome) that flow into the activity feed. |
| Image processing | `Pillow >= 10.0` | WebP conversion on sale image uploads before pushing to S3. |

### Cloud services

| Component | Choice | Why |
|---|---|---|
| File storage | AWS S3 (`boto3 >= 1.34`) | Presigned PUT URLs for sale images and CS video uploads. `s3_service.py` hides bucket/prefix mapping from clients. |
| Identity / OAuth | Company portal JWT | Only company employees with the `EMPLOYEE` role in their JWT can access the dashboard. `portal_client.py` validates tokens and creates users lazily on first login. |
| Email delivery | SMTP relay via Google Workspace | `email_service.py` uses `smtplib` with an App Password. Thin layer because Google handles delivery. |
| Microsoft integration | `msal` (lazy import in `msgraph_client.py`) | MSAL refresh-token flow for SharePoint/OneDrive file access. Read-only (Files.Read scope) -- Nexus never writes back to SharePoint. |
| Notifications | Discord webhooks | Plain POST to webhook URL. Used by `coupons.py` when a new coupon is created. No Discord SDK -- it's just a URL. |

### Deployment

- **Local dev:** Windows PC running a local development server
- **Staging:** the internal staging server
- **Production:** Hetzner CPX11 VPS running at the production domain

Deploys flow local to staging to production. Each environment has its own `.env` with distinct API keys and database URLs.

## Nexus Connector (ships to customer PCs as a signed Windows executable)

The connector is a completely separate application from the main API. It runs on the customer's PC, manages wireless modules over 802.15.4 radio, and syncs test results back to the production API.

### Two-process architecture

The connector splits into a Python 3 UI layer and a Python 2.7 radio bridge. The split isn't a preference -- it's a hard constraint, because the only library that talks to the USB radio dongle is Python 2.7 and has never been ported. Rather than freezing the whole app on Python 2.7, the bridge is isolated to a Tornado HTTP subprocess on port 9101 and the Python 3 Flask app (port 9100) talks to it over localhost HTTP. Clean process boundary, no pickling, no version shim. See [ADR-022](../decisions/022-python-27-bridge-isolation-via-http-subprocess.md).

### Connector stack

| Component | Choice | Why |
|---|---|---|
| UI language | Python 3 | All the modern parts of the connector (BLE, Flask, outbox sync, OAuth) run here. |
| UI web framework | Flask 3.x | A newer major version than the main API (which is on 2.3). The connector was bootstrapped more recently on Flask 3. |
| UI library | vanilla Web Components (custom elements), no framework | Matches the main dashboard's approach. Three tabs (Primary, Wireless, Hazmat) as independent custom elements. |
| Bridge language | Python 2.7 | Hard constraint from the radio library. |
| Bridge framework | Tornado | Already part of the radio library runtime; no added dependency. |
| Radio library | Proprietary 802.15.4 library | The only library that implements the vendor's 802.15.4 protocol. Runs inside the Python 2.7 subprocess exclusively. |
| BLE | `bleak >= 0.21` | Python 3. Async. Runs on a dedicated background asyncio thread isolated from Flask's WSGI request thread. Used for wireless module testing. |
| System tray | `pystray + Pillow` | Windows tray icon and right-click menu. |
| Local storage | SQLite | `bridge_events.db` (bridge event log + session registry + module identity cache), `test_records.db` (wireless module test sessions), local module DB. All confined to the customer's PC. |
| Packaging | PyInstaller (single-folder) | `bootstrapper.spec` with `upx=False` deliberately -- UPX packing triggers AV false positives which compound the unsigned-binary reputation problem. |
| Code signing | **Azure Trusted Signing** (Windows) + Apple Developer ID (macOS) -- planned, $220/year total | Microsoft's March 2024 reputation policy change made traditional EV certificates stop providing instant SmartScreen bypass. Azure Trusted Signing does. See [ADR-023](../decisions/023-azure-trusted-signing-over-ov-ev-cert.md). |

### Connector to Nexus sync

The connector never calls the customer-facing company portal. It only talks to the Nexus API. Sync uses the outbox pattern: every test session gets a UUID at creation time, is persisted locally first, and a background thread pushes unsynced records every 30 seconds with exponential backoff (30s to 60s to 120s to ... to 600s, 10-retry ceiling). HTTP 400/422 is treated as permanent failure so malformed data doesn't loop forever. The VPS deduplicates on the UUID. Authentication is SHA256-hashed API key per connector instance.

## Dashboard UI (serves from the Flask API)

### No framework, no build step

56 pages, 31 JS modules, all vanilla JavaScript with ES modules loaded directly in the browser. No framework or build step. The tradeoff is that heavy pages (`product.html` is 5,603 lines) contain all their logic inline. The benefit is that every file is readable as-is, instant edit-to-browser iteration with no build step, and zero build tooling to maintain or upgrade.

### Shared infrastructure

| Component | Choice | Why |
|---|---|---|
| Shell component | `<cn-shell>` -- native Web Component (1,037 lines) | Handles sidebar, header, environment badge, OAuth UI, ERP seat status polling, feedback button, and mobile menu on every page. One element; every page just declares `<cn-shell page="x">`. |
| Auth flow | Company portal OAuth via popup + `window.postMessage` (`auth.js`, 372 lines) | No iframe redirect dance. The popup posts a JWT back to the opener, which stashes it in `sessionStorage` for external API calls. Server-side auth is separate (Flask session cookies). |
| Page access guard | `page-guard.js` (153 lines) | Calls `/api/auth/me` on every protected page. Admin users bypass; regular users are gated on `user.page_access` array. Result is cached on `window._nexusAuthPromise` so `cn-shell` and the page init don't both make the same request. |
| Shared data layer | `data.js` (1,745 lines) | Wraps all `/api/v1/*` calls. Every page imports named functions (`getProducts`, `getStats`) rather than calling `fetch()` directly. `fetchJSON()` handles 401 to redirect universally. |
| Charts | Chart.js (vendored, not CDN) | `chart-theme.js` reads CSS custom properties at runtime and sets Chart.js global defaults, so charts re-theme automatically when tokens change. |

### Design system

Three-layer CSS, all custom, no Tailwind or Bootstrap:

- `tokens.css` (375 lines) -- CSS custom properties for colors, typography, spacing, shadows, z-index, animation. Single source of truth.
- `base.css` -- opinionated reset + body defaults.
- `components.css` -- cards, stat-cards, buttons, badges, tables, forms.

Light mode only. No dark mode in the main dashboard -- the `styleguide.html` demo is the only place `data-theme="dark"` appears.

### Real-time features

Three pages use Server-Sent Events (`EventSource`) for long-running backend operations:

- `sales.html` -- sale activation/deactivation progress
- `price-increase.html` -- bulk price update progress
- `firmware.html` -- device flashing progress

SSE over WebSockets because the traffic is one-directional (server to client) and the existing Flask request path handles it with `yield` generators.

### Passive diagnostics

`bug-capture.js` (460 lines) loads on every page via `cn-shell`. It intercepts `console.log/warn/error` (50-entry rolling buffer), listens for `window.onerror` and `unhandledrejection`, tracks interaction breadcrumbs (clicks, keys, scroll, focus, navigation), watches overlay appearance via `MutationObserver`, and captures viewport/connection info. When a user clicks the feedback button, this context is automatically attached to the bug report -- no extra work for the user.

## What's deliberately NOT in the stack

| Not here | Why |
|---|---|
| ORM (SQLAlchemy, Tortoise) | Raw SQL is idiomatic throughout. The query patterns are simple enough that an ORM would add abstraction without reducing complexity. |
| TypeScript | Same reason as no JS framework -- the build step cost exceeds the type-safety benefit at this size. |
| GraphQL server | 596 REST routes cover every frontend need; GraphQL would add a layer for no gain. |
| Separate migration tool (Alembic, Flyway) | Each service owns its own inline `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS`, guarded by `OperationalError` catch. Idempotent by construction. See [ADR-019](../decisions/019-idempotent-schema-migrations.md). |
| Message broker (RabbitMQ, Kafka, Redis Streams) | Nothing in the system needs ordered event streams. The `price_queue` table is a 3-state write-back buffer that replaces a broker for the one place it would have been tempting. |
| Celery or RQ | Heartbeats are threading loops; long-running operations stream via SSE. No need for a separate task queue process. |
| Stripe SDK | Stripe data arrives as CSV exports processed by `tax_recon_service.py`. Not a live API integration -- just a data source. |