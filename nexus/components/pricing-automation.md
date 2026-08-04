# Pricing Automation
> Part of the Nexus production automation platform

The pricing system is the single most operationally-critical subsystem in Nexus -- an error here is an error customers see at checkout.


## What it is

A verify-on-write pricing engine that applies sale prices, permanent markdowns, and bulk price increases to the ERP's catalog with per-product concurrency control, real-time progress streaming to the browser, a three-state queue that distinguishes "pushed" from "verified," and a complete audit trail. Supports revert at any point.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/pricing_service.py` | 1,848 | Apply/verify/revert for sale pricing and permanent adjustments. Owns the per-product lock dict and the SSE+POST dual path. |
| `api/services/change_ripple.py` | 278 | Computes the blast radius of a pricing change across affected SKUs. Pure analysis, no writes. |
| `api/routes/v1/prices.py` | 2,636 | HTTP surface -- price increase sessions, bulk operations, session lifecycle. |
| `api/routes/v1/sales.py` | 2,366 | Sale campaign management with phase scheduling. |

## Scale and verified numbers

- **11,000+ product option rows** tracked across the catalog (live count in the option tables, 2026-08-03)
- **2-3 days of manual work** -> **~3 hours** with automation (pre/post time tracking)
- **Per-product operation locks** cap at 500 concurrent entries in an LRU cache
- **3-state queue**: `queued -> applied -> verified` per option; session-level: `draft -> in_progress -> completed -> reverted`

## Key architectural decisions

- **[ADR-008: Per-product operation locks with bounded LRU cache](../decisions/008-per-product-operation-locks.md)** -- prevents concurrent apply/revert on the same product; non-blocking acquire returns "in progress" immediately.
- **[ADR-011: Three-state price queue](../decisions/011-three-state-price-queue.md)** -- distinguishes "we tried to push" from "we confirmed the push landed."
- **[ADR-016: SSE + POST dual-path with fallback signal](../decisions/016-sse-post-dual-path.md)** -- real-time progress via Server-Sent Events, automatic fallback to blocking POST on pool exhaustion.
- **[ADR-017: Sale revert race conditions and price_history dedup](../decisions/017-sale-revert-race-conditions-and-dedup.md)** -- six-layer concurrency defense hardened through production use.

## Inputs and outputs

**Reads from:**
- `sales` table (sale metadata, phases, discounts)
- `sale_products` and `sale_product_options` (what to apply)
- `product_options` (current state in Nexus)
- the ERP office backend via `erp_auth_service.py` (current live prices)

**Writes to:**
- the ERP office backend (applies the new price via authenticated HTTP POST)
- `sale_product_options` (state updates: queued -> applied -> verified)
- `price_history` (immutable audit of every change)
- `price_queue` (pending write-back items)
- `sync_changelog` (cross-cutting activity feed)

**Triggers:**
- User action from the Sales management page (`sales.html`)
- User action from the Price Increase workflow (`price-increase.html`)
- Programmatic via API (`POST /api/v1/sales/:id/apply`, `POST /api/v1/price-increase/:id/apply`)

## The featured story

See the [Pricing Automation case study](../case-studies/pricing-automation.md) for the narrative-voice version of this component -- problem, approach, technical highlights, outcome.
