# Sales Trends and Profitability Reporting
> Part of the Nexus production automation platform

Category-to-SKU sales reporting with signed year-over-year deltas, and a profitability companion that refuses to show a margin the data cannot support.

## What it is

The report that answers what sold and what it made, from category level down to the individual SKU, in production since July 6, 2026. The hard part is not the arithmetic: when a product's configuration changes, the ERP does not update that product, it creates another one, so a single physical product picks up several identities over the years and its sales history splits across all of them. The report reads through the product version chain (see [ADR-035](../decisions/035-product-version-linked-list-for-erp-duplication.md)) so a product's history is whole again, which is what made the question answerable at all.

The profitability companion computes margin only where cost data exists. SKUs containing components that were never costed are excluded from margin entirely rather than shown wrong -- leadership acts on this report, so a margin built from partial costs would be acted on as though it were complete.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/sales_trends_service.py` | 662 | The drill-down matrix engine -- category to SKU, signed year-over-year deltas, range and granularity controls. |
| `api/services/profitability_service.py` | 1,924 | Margin computation with cost-coverage gating. |
| `api/routes/v1/sales_trends.py` | 429 | HTTP surface for the reporting matrix and CSV export. |
| `api/routes/v1/profitability.py` | 671 | HTTP surface for the profitability view. |

## Scale and verified numbers

- Verified against roughly **72,000 rows** of sales history inside a **1,893-test suite** at deploy; the suite stood at **2,182 tests** when the profitability companion merged
- **99.5% cost-data coverage** on trailing-year revenue for the margin view
- Deployed to production **2026-07-06**, profitability companion following the same month

## Key decisions

- **A missing number over a wrong one.** Uncosted SKUs are excluded from margin, not estimated. The gap is visible and named, which is safer for a purchasing decision than a confident number built on partial costs.
- **Version-chain reunification.** Sales history is read through the product version linked list, so the report sees one product where the ERP sees several. Without this the drill-down would undercount every product the ERP had ever duplicated.
- **The current month is excluded from pace.** A half-finished month would read as a decline in any year-over-year view, so pace projections use complete months only, and the in-progress year is marked partial.
- **Test-suite-first delivery.** The report shipped inside a suite that verifies its aggregations against known history, because a reporting error here does not look like an error -- it looks like a business trend.

## Integration Points

**Reads from:**
- The ERP-zone sales and SKU history tables (mirrored by the heartbeats)
- `product_versions` (the version chain, for history reunification)
- The cost tables behind the profitability gate

**Writes to:**
- Nothing (read-and-render reporting layer; CSV export on demand)
