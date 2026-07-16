# Carrier Address-Validation Migration (USPS to Shippo)

**Status:** Accepted | **Date:** 2026-06-29 | **Theme:** integration

## Context

USPS announced that its address-validation API would become a paid, license-locked product, effective 2026-07-12. Rep-facing address tools in the platform depended on that endpoint for correcting and confirming customer addresses. A validation source that continues to work past the deadline was needed, ideally without adding a new paid dependency.

## Decision

The remaining rep-facing address validation was migrated to Shippo, which was already integrated and paid for through existing shipping workflows, so it carried no marginal cost. The migration was checked against 11 hard cases (rural routes, PO boxes, and new construction); the sample did not surface an address mismatch. Bulk address classification had already standardized on FedEx as the primary source for rate and throughput reasons, with Shippo kept as the tie-breaker.

## Alternatives Considered

Paying for USPS licensing did not fit this context because it would add recurring cost for a capability the platform already had available inside an existing, paid integration. Adopting a dedicated address-validation vendor of the Google or SmartyStreets class did not fit either: it would mean a new vendor relationship and contract for no marginal accuracy advantage at this address volume, coverage the existing Shippo integration already provided.

## Consequences

The migration removes one external dependency ahead of a hard vendor deadline rather than reacting after a break. Carrier-specific response quirks, the small differences in how each provider formats and flags a corrected address, are handled in a single adapter, so the rest of the system sees one normalized result. The trade-off is that address correctness now rides on Shippo's data for the rep-facing path and FedEx for bulk classification, so any provider-side accuracy regression surfaces through those adapters and is the place to watch. Validating the cutover against known-hard cases before the deadline kept the change ahead of the USPS transition instead of behind a failure.