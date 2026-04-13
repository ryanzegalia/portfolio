# ADR-017: Sale Revert Race Conditions and price_history Dedup

## Context

The revert path had a concurrency gap: if the SSE stream failed mid-operation, the UI could unlock prematurely and allow a second concurrent revert on the same product. This exposed four compounding issues that the six-layer defense addresses.

## Decision

**Fix all four layers in a single incident response:**

**Layer 1 -- Pool headroom:** Raise `DB_POOL_MAX` from 5 to 8. With 2 Gunicorn workers, that is 16 total connections, within PgBouncer's limits. This alone would not have prevented the incident (a busier system would still exhaust the pool) but raises the threshold.

**Layer 2 -- Graceful pool error handling:** Wrap `get_standalone_connection()` in try/except for `PoolError`. On exception, yield `{'event': 'error', 'retry_post': True}` instead of crashing. The frontend reads this as a signal to switch to the POST fallback cleanly.

**Layer 3 -- Single unlock point:** Remove `unlockNavigation()` from the SSE try/finally. The UI unlocks only at the very end of the operation, after the POST fallback completes -- not when the SSE path errors.

**Layer 4 -- Client-side operation guard:** Add a module-level `Set` of in-flight operations, keyed by product UUID. A second click on the same product is ignored on the client before the request even hits the server.

**Layer 5 -- Server-side operation lock:** `threading.Lock` dict keyed by product UUID, non-blocking acquire, bounded 500-entry LRU. If two concurrent requests for the same product somehow get past the client-side guard, the second one is rejected at the server.

**Layer 6 -- price_history dedup:** Before INSERT into `price_history`, check for a duplicate within a 60-second window (same entity_type, entity_id, field_name, new_value). Skip if found. This is the last-gate defense -- even if every other layer fails, the audit table stays clean.

Six layers, fixed in dependency order.

## Alternatives Considered

- **Just fix the pool exhaustion.** Was the first instinct. Would have prevented the specific incident but left the underlying problems (missing operation lock, premature unlock, missing dedup) in place. The next incident would have exposed a different combination.

- **Just add the operation lock.** Would prevent concurrent operations but not the pool exhaustion, not the premature unlock, and not the duplicate records if the lock were ever bypassed. One layer of defense is not enough when the failure mode has multiple contributing causes.

- **Skip the price_history dedup because the locks should make duplicates impossible.** Rejected because locks can fail (worker restart, process crash mid-operation, future refactor that misses the lock call). The dedup check at INSERT time costs microseconds and catches every remaining case. Belt-and-suspenders.

## Consequences

**Good:**
- The specific March 2026 incident is structurally impossible under the new design. Five independent layers would have to fail for a duplicate to be created.
- The `price_history` audit trail stays clean even under failure scenarios the design did not anticipate. The 60-second dedup window is wide enough to catch concurrent retries and narrow enough not to skip legitimate near-simultaneous changes.
- The fix is a reusable template. Any future multi-step operation that streams progress can follow the same layered pattern: pool headroom, graceful error, single unlock, client guard, server lock, dedup.

**Bad / costs:**
- Six layers is a lot of defense for one operation. Reading the code requires understanding each layer and how they interact. The apply/revert paths are noticeably denser after this fix.
- The `_operation_locks` dict introduced in this fix was itself the subject of a follow-up audit finding (unbounded growth). Every fix has its own potential regressions.
- The `fallback_options` carry-through fix was specific to this code path. Other code paths that mix SSE and POST delivery would need their own audit. The pattern is clear but not enforced automatically.
