# Platform-Side Shipping Label Generation

**Status:** Accepted | **Date:** 2026-07-16 | **Theme:** integration

## Context

The warehouse shipping-station work needed an answer to a question that had stalled for nearly a month: where should shipping labels be generated, inside the hosted ERP's native shipping module or on the platform side? The ERP is the system of record for orders and fulfillments, which argues for keeping label generation there; but the shipping-station UI, the carrier integrations (FedEx, USPS, Shippo), and the rate logic all live on the platform, and the ERP's shipping module is vendor-controlled and cannot be extended to drive a custom station workflow. Both the shipping-station UI and the USPS integration work were blocked on this decision.

## Decision

Labels are generated platform-side, through Shippo. The platform already carried a paid, integrated Shippo relationship handling address validation ([ADR-046](046-carrier-validation-migration.md)) and USPS tracking fallback ([ADR-009](009-carrier-api-fallback-for-mid-access-control.md)), so label generation completes a trio of capabilities on one adapter rather than opening a new integration. The ERP remains authoritative for the fulfillment record; the platform generates the label and the existing sync path carries the fulfillment state back, so the system-of-record boundary does not move.

## Alternatives Considered

Generating labels in the ERP's native shipping module kept everything in the system of record but could not drive the custom shipping-station workflow, and every future carrier or rate change would be gated on the ERP vendor. A dedicated label vendor was rejected on the same grounds as in ADR-046: a new vendor relationship for a capability an existing paid integration already offers.

## Consequences

The decision unblocked the shipping-station UI and the USPS label work immediately. The platform takes on the carrier-compliance surface for labels (rate accuracy, service mapping, hazmat constraints), which is acceptable because the platform already owns that surface for tracking and validation: one adapter, one place to watch. The risk to monitor is divergence between platform-generated labels and the ERP's fulfillment expectations; the mitigation is that fulfillment state still flows through the existing verified sync path rather than a new one.
