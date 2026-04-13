# ERP Integration Layer
> Part of the Nexus production automation platform

The deepest external integration in Nexus -- the ERP is the company's ERP and the authoritative source for products, orders, inventory, pricing, and deals.

A four-file layer that handles all communication with the ERP's two interfaces -- the REST API (authenticated, JSON) and the office backend (authenticated HTML, scraped for data the REST API doesn't expose).

## What it is

Together these files are the backbone of every data sync in Nexus.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/erp_rest_client.py` | 872 | REST API client -- JWT HS256 auth with 1-hour token caching, `requests.Session` for connection pooling, UTF-8 sanitization (`_sanitize_response()`) because the ERP occasionally returns Latin-1. |
| `api/services/erp_auth_service.py` | **2,917** | Second largest file in the codebase. RSA-encrypted password login to the office backend, `httpx` session with cookies, HTML scraping via BeautifulSoup. Handles pricing writes, template management, PO scraping, deal scraping. |
| `api/services/erp_proxy.py` | 911 | Proxies requests to the ERP office backend on behalf of dashboard pages that need live data (Price Adjustment Tool, Template Manager). |
| `api/services/warehouse_scraper.py` | 125 | Small utility -- scrapes `the warehouse page.php3` to retrieve real warehouse names, because the REST API only returns "Warehouse 1", "Warehouse 2" generics. |

## Scale and verified numbers

- **Two authentication paths**: JWT HS256 for REST (1-hour token cache, 60s refresh buffer), RSA-encrypted password + cookies for office backend (`pycryptodome` for RSA, `httpx` for session)
- **~12+ heartbeat services** call into these files as their primary read surface
- **~5 pricing services** call into `erp_auth_service.py` for writes
- **License seat management** -- `seat_monitor.py` watches the ERP's unauthenticated `the vendor login page` page to detect available seats and block connections when none are free

## Why two interfaces

the ERP's REST API is the clean modern surface -- authenticated, returns JSON, supports pagination and delta queries. Nexus uses it everywhere it can. But the REST API doesn't expose every field that matters. Notably:

- Pricing writes go to the office backend (REST is read-only for pricing)
- Deal management (coupons, discounts, thresholds) isn't in the REST response
- Purchase orders and receiving events are only in the PO management page
- Template management (email templates, etc.) is office-backend only

The `erp_auth_service.py` file exists to handle these cases. It maintains an authenticated session that mimics a browser (Mozilla user-agent, cookie jar, form submissions) and scrapes the HTML responses with BeautifulSoup. 2,917 lines because PHP form scraping is verbose and every edge case needs handling.

## Key architectural decisions

- **[ADR-014: Redis for cross-worker state](../decisions/014-redis-for-cross-worker-shared-state.md)** -- the ERP office backend session is shared across Gunicorn workers via Redis so Nexus doesn't burn a license seat per worker.
- **[ADR-010: Deal drift scrape over REST API](../decisions/010-deal-drift-scrape-over-rest-api.md)** -- concrete example of why the office backend is necessary. REST returns deals but not discount amounts or coupon codes.
- **Seat-aware connection gating.** `seat_monitor.py` runs a state machine (CONNECTED -> WARNING -> DISCONNECTED) based on scraped seat availability. When zero seats are free, the office backend login path is blocked; when 1 seat remains, a warning is logged.

## Inputs and outputs

**Reads from:**
- the ERP REST API (products, SKUs, orders, inventory, tax transactions, contacts)
- the ERP office backend (pricing forms, deal forms, PO pages, warehouse names, templates)

**Writes to (via office backend):**
- Pricing updates (sale and permanent markdowns)
- Deal toggles and coupon creations
- Template edits

**Consumed by:** Every heartbeat service, every pricing operation, `tax_recon_service` (for enrichment), `po_sync_service` (for receiving data), `deal_heartbeat` (for drift detection).
