# Case Study: Pricing Automation

## Problem

Every sale at the company used to be a multi-day manual process. With **800+ configurable product options** across the catalog, running a sale meant logging into the ERP's admin backend and clicking through every product, every option, every price field -- updating each one by hand, verifying each one by hand.

Price change history was limited to the login session -- no field-level change log, no rollback capability. Reverting prices at the end of a sale meant clicking through the same 800 options again, in reverse. The operational cost was **2+ days per sale cycle**. The pricing automation service removes that class of manual work and the errors that rode along with it.

## Approach

The pricing automation service (`pricing_service.py`) treats every price change as an operation with three states: **queued**, **applied**, and **verified**. Pushing a price to the ERP is "applied." Reading the page back from the ERP and confirming the value persisted is "verified." The difference matters: the ERP silently rejects some edits, and there's no way to know except by reading back the value after the write.

The service runs through every option in a sale, one at a time, applying the new price, waiting 500 milliseconds for the ERP to persist the change, then immediately re-scraping the same page and comparing to within $0.01. If the verification fails, the option is flagged for review rather than marked complete. The full audit trail lands in `price_history` -- every push, every verify, every revert, with timestamps and operator IDs.

Concurrency was the hard part. Multiple operators working on multiple sales can't block each other (sales are parallelizable by design) but two operators working on the *same* product would corrupt the database. The solution is a per-product threading lock stored in a bounded LRU cache -- 500 products can be locked simultaneously, older unlocked entries are evicted to keep memory bounded, and non-blocking acquire means a collision returns "already in progress" instantly instead of queuing a second operation.

Real-time progress streams via Server-Sent Events. The operator watches a progress bar update per-option as the system works. If the SSE stream fails (connection pool exhaustion, transient network blip), the server yields `{retry_post: True}` and the frontend silently switches to a blocking POST for the same operation. The operator sees a brief pause; the operation completes; no restart required.

## Technical Highlights

- **Verify-on-write semantics.** The ERP doesn't always persist writes on the first attempt. Every price change gets a verification read-back within 500ms. If the read doesn't match, the operation is flagged for review.
- **Three-state queue** (queued -> applied -> verified) with a session-level state machine wrapped around it (draft -> in_progress -> completed -> reverted). Session status is computed from option states, never stored independently.
- **Per-product threading locks with bounded LRU.** Non-blocking acquire, 500-entry cap, oldest-unlocked eviction. Multiple operators, one lock per product.
- **SSE + POST dual path with automatic failover.** Real-time progress with fallback to blocking POST on pool exhaustion. The operator never has to restart an operation.
- **Full revert support.** Reverting walks every verified option and pushes the original price back through the same verify-on-write pipeline. The original price is captured at deploy time so reverts are always possible.
- **`price_history` dedup with 60-second window.** Belt-and-suspenders defense against concurrent writes creating duplicate audit entries.
- **Six-layer defense** -- pool headroom, graceful pool error, single unlock point, client guard, server lock, DB dedup. Each layer addresses a distinct failure mode discovered through production use.

## Outcome

A sale that took **2+ days** of manual clicking now completes in **~3 hours** -- most of that is the operator reviewing proposed changes before clicking "apply." The automation itself runs in minutes; the human review step is the bottleneck by design.

Verification failures are flagged for review instead of silently completing, and every push, verify, and revert lands in the audit trail.

The pattern is used for two recurring sale workflows: Black Friday campaigns and the spring sale. Both use the same apply-verify-revert pipeline, the same state machine, and write to the same internal catalog records for full audit history.

See also: [ADR-008: Per-product operation locks](../decisions/008-per-product-operation-locks.md), [ADR-011: Three-state price queue](../decisions/011-three-state-price-queue.md), [ADR-016: SSE + POST dual path](../decisions/016-sse-post-dual-path.md), [ADR-017: Sale revert race conditions](../decisions/017-sale-revert-race-conditions-and-dedup.md), [Verify-on-write demo](../examples/verify_on_write.py).
