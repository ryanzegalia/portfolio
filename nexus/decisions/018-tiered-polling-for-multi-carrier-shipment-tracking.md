# ADR-018: Tiered Polling for Multi-Carrier Shipment Tracking

## Context

Nexus tracks dozens of active shipments at peak across FedEx and USPS (via the shipping API), with pattern detection for UPS and Amazon. Each carrier has a tracking API with rate limits. FedEx allows roughly 1,000 calls/day. USPS direct was 60 calls/hour (bottleneck). The shipping API's limit gives significant headroom.

The naive approach -- poll every active shipment every N minutes -- works at small scale but fails at two extremes: shipments that are about to deliver should be polled frequently (delivery events are time-sensitive), and shipments sitting in "label created" limbo for days should not consume polling budget (no events are happening).

Polling every shipment hourly would exceed FedEx's daily limit. A smarter approach was needed: more often when deliveries are imminent, less often when packages are sitting idle.

## Decision

**Three polling tiers based on shipment urgency:**

| Tier | Statuses included | Cadence |
|---|---|---|
| **Urgent** | `OUT_FOR_DELIVERY` | Every 30 minutes |
| **Active** | `IN_TRANSIT`, `SHIPPED` | Every 2 hours |
| **Dormant** | `LABEL_CREATED`, `EXCEPTION`, `DELAYED` | Every 6 hours |

**Business-hours weighting.** The poll schedule concentrates calls during 7am-9pm ET when deliveries actually happen. Overnight (9pm-7am) runs one full poll at midnight ET to catch any late scans, then stays quiet until morning. This cuts overnight API usage by approximately 80% without affecting delivery-event latency.

`TERMINAL_STATUSES = {"DELIVERED", "RETURNED"}` -- terminal shipments stop polling entirely. A terminal status sets `polling_active=0` which removes the row from future poll queries. No budget wasted on delivered packages.

**Deterministic carrier detection.** Tracking numbers have carrier-specific formats: `1Z` prefix for UPS, 20+ digit `92`/`93`/`94` prefix for USPS, 12/14/15-digit numeric for FedEx. `detect_carrier()` routes queries to the correct service based on format, not on a stored carrier tag (which can be wrong -- a one-time migration at table creation corrects USPS shipments that were historically misclassified as FedEx).

**COALESCE for ETA preservation.** When updating shipment state from a carrier response, the SQL uses `COALESCE(%s, estimated_delivery)` so if the carrier drops the ETA field from a later poll, the known good ETA is not overwritten with NULL.

## Alternatives Considered

- **Hourly polling for everything.** With dozens of active shipments across a full day, hourly polling exceeds FedEx's 1,000 call/day limit. A flat cadence fails the budget constraint.

- **Adaptive rate based on remaining quota.** Rejected as harder to reason about and debug. Fixed tiers are predictable; quota-based adaptation introduces feedback loops.

- **Webhooks from carriers.** FedEx and USPS both offer webhook notifications. Evaluated and deferred -- the operational complexity (signature verification, replay protection, retry on webhook delivery failure) was higher than the polling path's complexity at current scale. Revisit if the shipment volume grows past thousands of concurrent packages.

- **Push events from the shipping API instead of pulling.** The shipping API supports webhooks. Same rationale as above -- deferred, not rejected. The tiered polling system is the current implementation; webhooks are a Phase 2 improvement.

## Consequences

**Good:**
- API budget stays within carrier limits for every tier. FedEx peak estimated at approximately 492 calls/day. Both well under limits.
- Delivery events surface fast -- OUT_FOR_DELIVERY shipments get polled every 30 minutes, so the operator sees "Delivered" notifications within minutes of the carrier scan.
- Dormant shipments do not consume budget. A LABEL_CREATED shipment sitting for 5 days gets polled 20 times total instead of hundreds of times with an hourly cadence.
- Terminal status stops all future polling -- clean exit from the polling loop.
- Business-hours weighting reflects the actual pattern of delivery activity. Overnight calls are reserved for catching occasional late scans.

**Bad / costs:**
- The status enum has to be mapped consistently across carriers. FedEx has 40+ internal status codes, USPS has 11+ categories, the shipping API has its own substatus codes. All get normalized into the shared 8-status enum. The mapping tables are maintenance surface.
- Tier classification is static. A shipment stuck in EXCEPTION for 2 days polls slowly (6-hour cadence), but the operator might want faster polling because it is anomalous. There is no "operator-requested urgent poll" override today. Easy to add -- not needed yet.
- Business-hours weighting is timezone-specific (Eastern). If the business ever had customers with different peak delivery windows, this would need revisiting.

Current implementation in `api/services/tracking_service.py`: `POLL_TIERS` dict, `TERMINAL_STATUSES` set, `detect_carrier()`, `poll_shipments_by_tier()`, and inline SQL using `COALESCE(%s, estimated_delivery)` for ETA preservation.
