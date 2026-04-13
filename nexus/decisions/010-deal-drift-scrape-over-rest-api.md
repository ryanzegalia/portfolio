# ADR-010: Deal Drift Detection via HTML Scrape, Not REST API

## Context

Deal drift detection catches unauthorized pricing changes within 24 hours. the ERP's deal/promotion system is configured through a web admin form. Deals have dozens of fields -- coupon code, discount amount, discount type (percent vs dollar), threshold amounts, active flag, date ranges, channel restrictions. Any employee with admin access can edit these, with no audit log and no change notifications.

In early 2026, a major sale event exposed a gap in deal configuration monitoring. Coupon codes had been blanked, discount amounts zeroed, and amount types changed from Percent to Dollar on a set of affected deals -- changes that went undetected because no automated system existed to monitor deal configuration, regardless of source. The fix required two things: address the immediate gap, and add monitoring that would catch drift going forward from any source (the Nexus sale planner, a direct admin edit in the ERP, or anything else).

The monitoring layer required reading full deal state from the ERP. The REST API was the obvious first choice. The ERP REST API's `GET /deals` endpoint returns deal metadata but omits the specific fields that were getting corrupted: `coupon_code`, `discount_amount`, `amount_type`, `order_amount`. The REST response would have confirmed the deal exists, but not that the discount amount had been zeroed.

## Decision

**Scrape the `the deal management page?action=edit&id=N` page for every tracked deal, parse 34 form fields via BeautifulSoup, and diff field-by-field against the previous snapshot.**

The bridge to the ERP uses the same authenticated HTTP session that `erp_auth_service.py` already maintains for pricing operations -- RSA-encrypted login, cookie-based session. A nightly heartbeat (24-hour cadence plus 0-60s jitter) iterates through deal IDs from `deal_group_members`, fetches each edit page, parses it, and writes a complete snapshot to `deal_snapshots`. Then diffs against the previous snapshot and writes any changed fields to `deal_change_log` with a severity flag.

Fields in `CRITICAL_FIELDS` (coupon_code, discount_amount, discount_type, active_status, etc.) get elevated logging. Fields in `SKIP_COMPARE_FIELDS` (synced_at, raw_form_data, id, erp_deal_id, snapshot_id) are excluded from the diff so every snapshot doesn't appear to have changed.

The heartbeat has:
- **Circuit breaker** at 10 consecutive errors, per the platform standard.
- **Thundering-herd stagger** -- first tick waits `random.uniform(30, 120)` seconds before running.
- **Rate limiting** between scrapes: `random.uniform(0.5, 1.5)` seconds between deals.
- **30-day snapshot retention** -- old snapshots pruned to keep the table bounded.
- **Deal ID source with fallback** -- read from `deal_group_members` table; if empty, fall back to the range 1-220.

## Alternatives Considered

- **REST API polling.** Tried first. The REST API omits the critical fields. Dead on arrival.

- **Database-trigger based audit.** Would require access to the ERP's underlying database, which is not available. the ERP is a vendor-managed system.

- **Webhooks from the ERP.** the ERP doesn't offer deal-change webhooks.

- **Wait until a customer reports a problem.** The reactive approach that preceded this system. Explicitly rejected as the whole motivation for this ADR.

- **Require every deal edit to go through Nexus's sale planner.** Would work technically (the sale planner validates inputs) but doesn't stop direct the ERP admin edits by other employees. The drift detection catches all paths, not just Nexus's own write path.

## Consequences

**Good:**
- Silent deal changes become visible within 24 hours. Critical field changes fire at elevated severity, so the operator sees them in the activity feed immediately.
- The scrape is authoritative: the edit form is the same form employees use, so whatever Nexus reads is exactly what the ERP stores.
- The pattern is reusable. Any other vendor system with form-editable state and no audit log could be monitored this way.
- The diff captures intent-vs-effect separately from Nexus's own write path. If any source (Nexus, direct admin edit, vendor update) changes a deal, the drift detection catches it.

**Bad / costs:**
- Scraping HTML is fragile. If the ERP redesigns the `the deal management page` page, every field parse breaks at once. Mitigated by the circuit breaker (stops hammering on parse failures) and by the fact that the ERP hasn't changed this page in approximately 2 years.
- 24-hour cadence means the drift detection window is 24 hours. A deal corrupted at 2:00 AM would be caught the next night. For most scenarios that is fast enough (customers hit the deal later in the day), but a shorter cadence would catch damage faster -- a trade-off against API politeness and the ERP server load.
- The scrape consumes the ERP session seats (one at a time for the scrape duration). Not an issue at 24-hour cadence but would matter if the cadence were shortened.
- Requires the `erp_auth_service.py` session to be alive. If the session is down, the heartbeat can't run.

Current implementation in `api/services/deal_heartbeat.py`: 34 named fields scraped per deal, 8 critical fields triggering elevated severity, circuit breaker threshold at 10 consecutive errors, 30-day snapshot retention.