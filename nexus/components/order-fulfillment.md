# Order & Fulfillment
> Part of the Nexus production automation platform

Four services cover the order-to-delivery pipeline from the ERP ingestion through hazmat compliance.


## What it is

The order ingestion path -- new orders arrive from the ERP every 5 minutes via the order heartbeat, tax details are scraped from billing pages, purchase orders are captured from the office backend, and a read-only fulfillment database replica serves hazmat document generation.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/order_heartbeat.py` | 950 | 5-minute background poller of the ERP REST API for new orders. In-memory SKU cache (500 max) per tick. Brand routing: brand_id=1 -> the primary brand, brand_id=5 -> the wireless line. |
| `api/services/erp_order_sync.py` | 697 | Fetches orders via REST API plus scrapes billing pages for tax line-item breakdown. Also scrapes returns/tax refund pages. Checkpoint delta with 0.3s request delay. |
| `api/services/po_sync_service.py` | 1,067 | Scrapes the ERP office backend to capture purchase orders and detect receiving events. Three trigger paths: nightly pipeline, manual API, inventory-triggered checks. |
| `api/services/po_shipment_sync.py` | 544 | Reads POShipments tab from the shared pricing workbook via Microsoft Graph. Editorial sync (never bulk deletes, self-healing via `is_stale` flag). |
| `api/services/fulfillment_db.py` | 346 | Read-only connection to the primary brand fulfillment AWS RDS MySQL read replica via `pymysql`. Used by hazmat PDF generation. Strict read-only by design. |

## Scale and verified numbers

- **Order heartbeat cadence**: 5 minutes
- **SKU cache size**: 500 (reset per tick)
- **PO sync trigger paths**: 3 (nightly, manual, inventory-triggered)
- **the ERP request delay**: 0.3 seconds between scrapes (rate-limit politeness)
- **Circuit breaker threshold**: 10 consecutive errors (platform standard)

## Key architectural decisions

- **[ADR-005: Circuit breakers on every external API call](../decisions/005-circuit-breakers-on-external-apis.md)** -- order_heartbeat uses the standard circuit breaker pattern.
- **[ADR-006: Checkpoint-based incremental sync](../decisions/006-checkpoint-based-incremental-sync.md)** -- order_heartbeat advances checkpoint only after successful batch.
- **PO sync scrapes the office backend.** The ERP REST API has zero endpoints for purchase orders or receiving events. `po_sync_service.py` scrapes the PO management page authenticated pages -- the only way to get PO data into Nexus. Triggered from nightly pipeline (daily refresh), manual API call (on-demand), and inventory heartbeat (when stock arrives, check for associated receiving event).
- **Fulfillment DB is a separate read replica.** `fulfillment_db.py` connects to an AWS RDS MySQL instance (not the main PostgreSQL), using `pymysql` with `DictCursor`. It's the only MySQL connection in the codebase. Used exclusively for hazmat PDF generation to look up order line items and shipping addresses.
- **Editorial sync pattern for PO shipments.** `po_shipment_sync.py` never bulk deletes -- it marks records `is_stale` when they disappear from the source, then self-heals when they reappear. Prevents data loss from transient Excel file issues.

## Inputs and outputs

**Reads from:**
- the ERP REST API (`GET /v1/order`, `GET /v1/order_line_item`)
- the ERP office backend (the PO management page, billing pages, tax refund pages)
- AWS RDS MySQL read replica (fulfillment data for hazmat)
- Microsoft Graph (`POShipments` tab of the shared pricing workbook)

**Writes to:**
- `order_headers`, `order_line_items`, `order_fulfillments`
- `cs_purchase_orders`, `cs_po_receivers`, `cs_po_receiver_items`
- `erp_po_shipments` (Wilton-bound rows only)
- `sync_changelog`
