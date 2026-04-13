# Deal Drift Detection
> Part of the Nexus production automation platform

The audit layer within the coupon management system. Nightly snapshot-and-diff service that catches unauthorized or unexpected changes to promotional deal configuration in the ERP within 24 hours.


## What it is

A nightly drift detection service that captures complete snapshots of every promotional deal configured in the ERP, diffs them field-by-field against the previous snapshot, logs critical field changes at elevated severity, and exposes a force-run API for on-demand audit -- all without using the ERP REST API (because REST omits the critical discount fields).

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/deal_heartbeat.py` | 779 | Background thread, nightly scrape of `the deal management page`, field-by-field diff, severity-tiered change logging. |
| `api/routes/v1/deals.py` | 1,272 | HTTP surface -- deal group management, toggle operations, custom grouping layer on top of the ERP. |
| `api/routes/v1/coupons.py` | 699 | Coupon creation and tracking; Discord webhook notifications on create. |

## Scale and verified numbers

- **24-hour cadence** + `random.uniform(0, 60)` second jitter
- **34 named form fields** scraped per deal (`DEAL_FORM_FIELDS`)
- **8 critical fields** (`CRITICAL_FIELDS`) trigger elevated severity logging: coupon_code, promo_amount, amount_type, active_status, etc.
- **5 metadata fields** (`SKIP_COMPARE_FIELDS`) excluded from the diff: synced_at, raw_form_data, id, erp_deal_id, snapshot_id
- **Circuit breaker threshold: 10** consecutive errors (platform standard)
- **Snapshot retention: 30 days**
- **Thundering-herd stagger: 30-120 seconds** on first tick
- **Rate limit between scrapes: `random.uniform(0.5, 1.5)`** seconds -- polite to the ERP

## Key architectural decisions

- **[ADR-010: Deal drift scrape over REST API](../decisions/010-deal-drift-scrape-over-rest-api.md)** -- why `the deal management page` scraping instead of the REST API. The REST API omits discount amounts, coupon codes, and threshold fields -- the exact fields that need monitoring. The form is the authoritative source.
- **[ADR-005: Circuit breakers on every external API call](../decisions/005-circuit-breakers-on-external-apis.md)** -- deal_heartbeat uses the platform circuit breaker pattern. Tripped after 10 consecutive errors via `service_flags.disable_service('deal_heartbeat')`.
- **Deal ID source with fallback.** Reads tracked deal IDs from `deal_group_members` (the live curated list). If that table is empty, falls back to the range 1-220 as the default scan set.
- **Session re-auth on expiry.** If the ERP auth session expires mid-run, deal_heartbeat automatically re-authenticates via `erp_auth_service.ensure_authenticated()` and retries the current deal before giving up.
- **Normalization to prevent phantom drift.** Every scraped value is stripped of whitespace before comparison. A trailing space on one snapshot and no trailing space on the next would not look like a change.

## Why this exists

Deal configuration changes in the ERP -- from the Nexus sale planner, direct admin edits, or vendor-side updates -- had no automated detection. Deal drift detection catches configuration changes within 24 hours, regardless of source. The nightly scrape diffs every tracked deal's 34 form fields against the previous snapshot, and critical field changes (coupon codes, discount amounts, active status) fire at elevated severity so the operator sees them immediately in the activity feed.

## Inputs and outputs

**Reads from:**
- the ERP office backend (`the deal management page?action=edit&id=N`) via authenticated session
- `deal_group_members` (tracked deal IDs)

**Writes to:**
- `deal_snapshots` (full snapshot per deal per run)
- `deal_change_log` (field-level diff history with severity flag)
- `api_health_log` (operational metrics and circuit breaker state)
- `sync_changelog` (cross-cutting activity feed)
