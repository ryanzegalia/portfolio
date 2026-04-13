# ADR-008: Per-Product Operation Locks with Bounded LRU Cache

## Context

On 2026-03-24, a sale revert operation under load exhausted the database connection pool, which dropped the SSE stream. When the stream dropped, the UI unlocked prematurely, allowing a second click before the first operation completed. Two concurrent revert operations ran against the same product, producing duplicate `price_history` records. The system had no per-product concurrency guard -- this edge case revealed the need for one.

The fix needed to hold up at two layers: the frontend couldn't be allowed to fire the same operation twice, and the backend couldn't be allowed to run two concurrent operations on the same product even if the frontend misbehaved.

## Decision

Per-product server-side locks using a module-level dict of `threading.Lock` objects keyed by `product_uuid`. Non-blocking acquire -- if the lock is already held, the request returns immediately with `{'error': 'Operation already in progress'}` or (for SSE paths) yields an error event. The lock dict is a bounded LRU cache: `OrderedDict` capped at 500 entries, with the oldest unlocked entries evicted when the cap is hit.

From `pricing_service.py:42-43`:

```python
# Per-product operation locks -- prevents concurrent apply/revert on the same product.
# Uses OrderedDict as a bounded LRU cache to avoid unbounded memory growth.
```

Also added: a client-side guard -- a module-level `Set` tracks in-flight product UUIDs so a double-click can't queue a second request even before it hits the server. And a pool headroom bump -- `DB_POOL_MAX` increased from 5 to 8, which with 2 Gunicorn workers gives 16 total connections, within PgBouncer's limits.

And a `price_history` dedup check -- before INSERT, look for a duplicate within a 60-second window (same entity_type, entity_id, field_name, new_value) and skip if found. Belt and suspenders -- the primary fix is the lock, the dedup is the seatbelt in case the lock ever leaks.

The unbounded dict was actually the first implementation. The pre-deployment security audit caught it and noted: "Unbounded `_operation_locks` dict -- Lock per product UUID, never cleaned up. Memory grows indefinitely. Also per-process only (not cross-worker safe). Fix: Add LRU eviction (cap at 500 entries)." The 500-entry LRU was added in the same commit as a note to re-evaluate advisory locks later if cross-worker pricing collisions ever become a real thing.

## Alternatives Considered

- **Database advisory locks (`pg_try_advisory_lock`).** Would work cross-worker without the in-process dict. Rejected on latency -- advisory locks require a round-trip to Postgres for every operation, which adds measurable overhead to the hot path. For a pattern that fires on every pricing operation across the day, the in-process lock is orders of magnitude cheaper. This is worth revisiting if the pattern ever needs cross-worker coordination.

- **Global lock for all pricing operations.** Rejected because sales campaigns run with multiple operators working in parallel on different products. A global lock would have serialized all concurrent operators, defeating the parallelism the system was designed for.

- **Blocking acquire with timeout.** Rejected because the right UX for a second click is "no, you can't do that right now" -- not "wait 30 seconds while we queue it." Non-blocking with an immediate error message gives the user fast feedback and keeps the UI responsive.

- **Unbounded lock dict.** Rejected after the pre-deployment security audit identified memory growth as a real concern. The LRU cap at 500 entries costs ~40 KB and eliminates the risk.

## Consequences

The specific failure mode that caused the duplicate history records can no longer happen. Two concurrent reverts on the same product are rejected at the server before either can write.

Memory is bounded. 500 entries x ~80 bytes per lock is trivial (~40 KB), and the eviction fires on product turnover rather than runaway growth.

The pattern is portable. `deal_heartbeat.py` and `tax_engine_heartbeat.py` picked it up for their own single-instance operations with no new code -- just a local `self._lock = threading.Lock()` because they don't need per-entity scoping.

In-process lock state is lost on worker restart. If a request acquires a lock, the worker crashes mid-operation, and the lock is gone -- a follow-up request would be allowed even though the underlying operation is half-complete. The DB-level `price_history` dedup covers this, but the lock alone is not restart-safe.

LRU eviction applies to unlocked entries only -- a locked entry is never evicted. A deadlocked lock would persist and block its slot forever. No deadlock is possible in the current code (every acquire has a paired release in a `try/finally`), but the invariant is a known fragile point.