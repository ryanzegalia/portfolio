# Customer Contact Catalog and Deduplication

## Problem

The ERP customer base carried no identity hygiene. Measured across the base before deduplication, 77% of contacts shared an email address with at least one other contact, and the worst single email was attached to 165 separate contact records. Multi-account buyers were common, since the same person or business often held both a B2B and a B2C account. Downstream teams keyed off records that pointed at the same real customer under different IDs, with no reliable way to tell which accounts belonged together.

## Approach

The foundation is a governed Postgres mirror of the ERP customer and contact tables, cs_customers and cs_contacts, refreshed by a nightly enumeration job that self-heals on transient ERP errors instead of aborting a full run. As of 2026-07-09 the mirror held **43,000+ customers and 117,000+ contacts** (live query). On that substrate, an idempotent pure-SQL recompute assigns every account a deterministic dup_group_id from three normalized keys: phone reduced to its last ten digits, a normalized email, and a normalized address key. Because the recompute is pure SQL and deterministic, re-running it on unchanged data produces the same groups, which makes it safe to run on a schedule. The June 15 2026 pass found **16,705 duplicate groups covering 29,124 accounts**, an average of 1.74 accounts per real customer with a maximum of 32.

A parallel address-classification effort corrected residential and commercial flags across the base. USPS validation was evaluated first but did not fit this context: its API capped at 60 lookups per hour, unusable for roughly 50,000 records. FedEx address classification became the bulk engine at about 20 records per second through 10-way concurrency, with Shippo scoped to a tie-breaker role, consulted only when FedEx returned UNKNOWN or MIXED. That split cut a roughly five-hour run down to about fifteen minutes.

Every correction flowed through a staged write pipeline that verifies each change rather than trusting the write. Across the project the pipeline applied about **31,650 flag corrections** (31,592 through the pipeline plus roughly 60 pilot and direct writes) with no known drift and no bad writes recorded. A 471-record unclassified tail was reviewed and confirmed to be ordinary addresses, not failures. The classification project completed on production 2026-06-08, when the contact base stood at roughly 82,000.

## Technical Highlights

- **Deterministic pure-SQL dedup.** Group assignment runs entirely in SQL from three normalized keys, so it is idempotent and re-runnable on a schedule without accumulating side effects. See [ADR-038](../decisions/038-pure-sql-dedup-recompute.md).
- **Carrier tiering by cost and coverage.** FedEx handles bulk classification at speed; Shippo is reserved as a tie-breaker for the ambiguous UNKNOWN and MIXED cases only, which keeps per-record cost down while still resolving the hard tail. See [ADR-046](../decisions/046-carrier-validation-migration.md).
- **Verify-on-write corrections.** Each flag change is confirmed after the write, so a silently rejected update is caught instead of assumed applied.
- **Self-healing enumeration.** The nightly mirror job continues past transient ERP errors, so one flaky call does not abandon an entire refresh.
- **Legacy data-quality catch.** During the sweep, the remediation pipeline surfaced and neutralized a dormant stored-XSS payload that had been sitting in legacy customer data since before the platform existed.

## Outcome

The dedup layer turned an opaque customer base into a queryable one: 16,705 duplicate groups covering 29,124 accounts as of June 15 2026, so any account can be traced back to the real customer behind it. The classification project finished on production June 8 2026 with about 31,650 verified flag corrections and no known drift, and its 471-record unclassified tail resolved to ordinary addresses rather than errors.

Reliability work continued after that milestone. Enumeration counts showed the contact mirror had quietly stalled at roughly 82,000 rows: the contacts table lacked a unique index, so the ON CONFLICT upserts had been failing silently since around June 3. Diagnosing the missing index and adding it restored ingestion the same day, June 29 2026, after which the mirror recovered to its full size, 117,000+ contacts by early July 2026. The catch is the point here: an enumeration check surfaced a silent stall, and a structural fix closed it.

Around the same time, USPS announced its validation API would become a paid, license-locked product. The remaining rep-facing tools moved to Shippo and were validated against eleven hard cases, covering rural routes, PO boxes, and new construction, returning matching deliverability on all eleven with no deliverable mismatches.