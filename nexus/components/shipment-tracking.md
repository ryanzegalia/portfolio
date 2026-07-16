# Shipment Tracking
> Part of the Nexus production automation platform

Multi-carrier shipment tracking with tiered polling, deterministic carrier routing, and a critical April 2026 fallback when USPS changed their access control rules.

## What it is

A multi-carrier tracking pipeline that discovers shipments from the ERP, polls FedEx (batched) and USPS (via the shipping API after April 2026) using carrier-format-detected routing, normalizes carrier-specific status codes into a unified 8-status enum, stores all event history locally for zero-latency dashboard reads, and segments shipments into three urgency tiers to prioritize polling resources. Tracking number patterns for UPS and Amazon are detected but not actively polled.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/tracking_service.py` | 1,482 | Primary service -- ingestion, carrier detection, tiered polling, status normalization. |
| `api/services/fedex_service.py` | 1,055 | Full FedEx REST client -- OAuth2, rate quotes, label gen, address validation, tracking. Bill-on-scan model. |
| `api/services/usps_service.py` | 1,395 | Full USPS REST client -- OAuth2 + Payment Auth tokens, labels, tracking. Prepaid model. |
| `api/services/shippo_tracking_service.py` | 181 | USPS tracking fallback via the shipping API (post-April-2026 carrier access control change). |
| `api/routes/v1/shipping.py` | 1,496 | HTTP surface -- multi-carrier label generation workstation for warehouse staff. |
| `api/routes/v1/tracking.py` | 238 | Read-only dashboard surface. |

## Scale

- **Hundreds of active shipments** at peak
- **3 urgency tiers**: urgent (OUT_FOR_DELIVERY -- every 30 min), active (IN_TRANSIT, SHIPPED -- every 2h), dormant (LABEL_CREATED, EXCEPTION, DELAYED -- every 6h)
- **40+ FedEx status codes** mapped to 8 unified statuses (`FEDEX_STATUS_MAP`)
- **11 USPS status categories** normalized into the same enum
- **40+ the ERP `method_id` values** mapped to carrier service types
- **16 hazmat method IDs** tracked across FedEx and USPS
- **FedEx batch size: 30** shipments per API call (rate-limit friendly)
- **Business-hours weighting**: concentrated 7am-9pm ET, single midnight sweep overnight

## Key Decisions

- **[ADR-018: Tiered polling for multi-carrier shipment tracking](../decisions/018-tiered-polling-for-multi-carrier-shipment-tracking.md)** -- urgent/active/dormant cadences with business-hours weighting.
- **[ADR-009: USPS to the shipping API fallback for carrier access control change](../decisions/009-carrier-api-fallback-for-mid-access-control.md)** -- the April 1, 2026 USPS policy change broke direct polling for the shipping API-created labels.
- **Deterministic carrier detection from tracking number format.** `detect_carrier()` uses pattern rules -- `1Z` prefix for UPS, 20+ digit `92/93/94` prefix for USPS, 12/14/15-digit numeric for FedEx. Documented as deterministic -- tracking number patterns are unique per carrier.
- **`COALESCE` for ETA preservation.** SQL uses `COALESCE(%s, estimated_delivery)` so if a later poll drops the ETA field, we do not overwrite a known good ETA with NULL.
- **Terminal status stops polling.** `TERMINAL_STATUSES = {"DELIVERED", "RETURNED"}`. Terminal shipments get `polling_active=0` and exit the poll query entirely.
- **Recipient info cached at ingest.** One the ERP contact API call per shipment at discovery time, stored in the row. Dashboard reads require zero external calls.
- **One-time migration** at table creation splits comma-separated multi-tracking rows into individual records and corrects historical USPS-as-FedEx misclassification.

## External read surface for support automation (July 2026)

In July 2026 the tracking layer gained a versioned external API (`/api/v1/tracking/*`) built for the company's support-desk automation: a support bot can look up shipment status and delivery exceptions without touching the ERP directly. The platform acts as a buffer in front of the system of record, with the surface API-key gated, rate-limited, and read-only. Lookups join through order headers so responses are brand-aware across the company's product lines. The integration was verified live against 11,000+ shipment rows with 100% sales-channel coverage before the bot went to production.

The integration audit also surfaced two operational risks in the surrounding support tooling that were documented and scheduled rather than left latent: an uncached edge worker generating roughly 290K requests per week against a shared rate-limit bucket, and a vendor API-token deprecation with a hard 2027 deadline that requires an OAuth migration.

## Integration Points

**Reads from:**
- the ERP REST API (`/v1/shipment`, `/v1/contact`)
- FedEx Track API (batched, up to 30 per call)
- USPS Web Tools / the shipping API Tracking API (per-shipment)
- `shipments` table (local cache for dashboard)

**Writes to:**
- `shipments` (discovered shipments, cached recipient info)
- `shipment_events` (per-event history)
- `api_call_log` (operational metrics)
- `shipping_labels` (Nexus-generated labels cross-reference)
- `sync_changelog` (cross-cutting activity feed)

**Triggers:**
- `TrackingHeartbeat` daemon thread on 300s cadence
- Manual poll via API endpoint
- Real-time via `shipping.html` for newly-generated labels
