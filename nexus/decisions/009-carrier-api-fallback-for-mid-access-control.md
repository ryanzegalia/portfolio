# ADR-009: USPS to Shipping API Fallback for MID-Based Access Control

## Context

The company creates most USPS shipping labels through the shipping API. When the shipping API creates a label, it embeds the shipping API's own MID (Meter ID) in the tracking barcode -- not the primary brand's MID. Until April 2026, this didn't matter for tracking: any tracking number could be queried against the USPS Tracking API regardless of which MID issued it.

Starting April 1, 2026, USPS implemented MID-based access controls. Queries for a tracking number are authorized only for the MID that issued it. This meant Nexus's direct USPS polling was about to return "access denied" for every shipping-API-issued label -- which is most of them. Hundreds of active shipments were at risk of losing tracking coverage.

Labels created directly through the USPS API (using the primary brand's own MID) would not be affected -- but at the time, all active USPS shipments were the shipping API-originated. The deadline was hard.

## Decision

Route USPS tracking queries through the shipping API's tracking API instead of direct USPS. The shipping API is authorized to query tracking for labels it created. A new service (`shippo_tracking_service.py`, 181 lines) wraps the shipping API's tracking endpoint, and `tracking_service.py` routes USPS shipments through the new path while keeping FedEx unchanged.

The routing uses the existing `source` column on the `shipments` table (`'erp'` for the shipping API-originated labels, `'nexus'` for direct USPS labels) -- a simple SQL filter made the hybrid routing cheap to implement.

Phased rollout:

- **Phase 1 (immediate, before April 1):** Polling swap. USPS tracking goes through the shipping API. USPS label creation unchanged -- still direct USPS API.
- **Phase 2 (deferred):** The shipping API webhooks instead of polling. Push-based, eliminates the rate limit concern entirely. Deferred because Phase 1 was enough for the deadline.

## Alternatives Considered

- **Get USPS to authorize Nexus's direct queries.** Not in the primary brand's control. USPS's new policy is MID-scoped; there's no override mechanism.

- **Switch all label creation to the shipping API.** Would have eliminated the problem but is a much larger change with its own cost implications (the shipping API charges per label). Deferred -- the tracking-only workaround buys time to evaluate full migration later.

- **Stop polling USPS entirely; rely on the ERP status updates.** The ERP gets a rough status but not the event-level detail Nexus uses for delivery delay alerts. Loss of fidelity was unacceptable.

- **The shipping API tracking webhooks instead of polling.** Architecturally cleaner -- no polling, no rate limit ceiling. But the integration work is larger (receive webhook, verify signature, update shipment state), and the April 1 deadline was 10 days out. Polling ships first, webhooks later.

- **Maintain both direct-USPS polling and the shipping API polling in parallel.** Rejected because direct USPS polling would return access-denied errors for the shipping API-issued labels starting April 1, and handling that error as "try the shipping API now" adds failure-path complexity. Cleaner to route by source column upfront.

## Consequences

Tracking coverage survived April 1 with zero operational downtime. Hundreds of active shipments kept their tracking visibility through the cutover.

The shipping API's rate limits are far more generous than USPS's direct API: USPS direct was capped at 60 calls/hour, while the shipping API's GET endpoint allows 4,000 calls/minute in live mode. The polling path is now less constrained than it was before the switch.

The shipping API also returns better data -- the `eta` field is more reliable (USPS drops it on Out for Delivery), and substatus codes give finer event detail.

The shipping API is now a load-bearing integration. A shipping API outage breaks USPS tracking coverage.

The shipping API's tracking API has its own schema that differs from USPS's -- `tracking_service.py` normalizes the shipping API's substatus codes into the same unified 8-status enum FedEx uses. The mapping table adds maintenance surface.

Webhooks are deferred, so polling continues. Cost is minimal given the shipping API's rate limits, but polling is architecturally less elegant than push-based. The decision is also reactive to a vendor policy change rather than proactive design.