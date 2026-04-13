"""
Resource-Scoped Non-Blocking Lock Cache with LRU Eviction
==========================================================

Pattern: per-resource operation locks that fail fast on contention instead
of deadlocking callers, with bounded memory via LRU eviction of idle locks.

Problem: concurrent API requests can mutate the same resource simultaneously
(e.g., two threads both repricing product #42). A global lock serializes
everything. A per-resource lock is better, but naive dict-of-locks grows
without bound.

Solution: an OrderedDict of Lock objects keyed by resource ID. When a second
caller hits a resource already under mutation, acquire(blocking=False) returns
immediately with a "busy" signal. When the cache exceeds its capacity, eviction
walks insertion order and removes only UNLOCKED entries -- a lock currently held
is never evicted, even if it is the oldest.

See: decisions/008-per-product-operation-locks.md
"""

import threading
import time
import random
from collections import OrderedDict


class ResourceLockCache:
    """Bounded cache of per-resource non-blocking locks.

    Each resource key gets its own threading.Lock. Callers acquire with
    blocking=False so a second request for an in-use resource fails fast
    instead of queuing behind it.

    When the cache exceeds max_size, the oldest UNLOCKED entries are
    evicted. Locked entries are skipped -- you never yank a lock out
    from under an active operation.
    """

    def __init__(self, max_size: int = 8):
        self._max_size = max_size
        self._locks: OrderedDict[str, threading.Lock] = OrderedDict()
        # Guard protects the OrderedDict itself (not the per-resource locks)
        self._guard = threading.Lock()
        # Counters for demo observability
        self.stats = {"acquires": 0, "rejects": 0, "evictions": 0}
        self._stats_lock = threading.Lock()

    def _record(self, event: str) -> None:
        with self._stats_lock:
            self.stats[event] += 1

    def acquire(self, resource_id: str) -> bool:
        """Try to acquire the lock for resource_id.

        Returns True if acquired, False if another thread already holds it.
        Never blocks.
        """
        lock = self._get_or_create(resource_id)
        got_it = lock.acquire(blocking=False)
        if got_it:
            self._record("acquires")
        else:
            self._record("rejects")
        return got_it

    def release(self, resource_id: str) -> None:
        """Release the lock for resource_id."""
        with self._guard:
            lock = self._locks.get(resource_id)
        if lock is None:
            raise ValueError(f"No lock exists for resource '{resource_id}'")
        lock.release()

    def _get_or_create(self, resource_id: str) -> threading.Lock:
        """Return the lock for a resource, creating it if needed.

        If creation pushes us over max_size, evict the oldest unlocked
        entries until we are back within bounds.
        """
        with self._guard:
            if resource_id in self._locks:
                # Move to end so recently-used keys survive eviction
                self._locks.move_to_end(resource_id)
                return self._locks[resource_id]

            lock = threading.Lock()
            self._locks[resource_id] = lock
            self._evict_if_needed()
            return lock

    def _evict_if_needed(self) -> None:
        """Walk insertion order, removing unlocked entries until within bounds.

        MUST be called while holding self._guard. Skips any lock that is
        currently held -- those are active operations we cannot interrupt.
        """
        if len(self._locks) <= self._max_size:
            return

        victims = []
        for key, cached_lock in self._locks.items():
            # locked() is a non-blocking status check, not an acquire
            if not cached_lock.locked():
                victims.append(key)
            # Stop as soon as evicting these would bring us within bounds
            if len(self._locks) - len(victims) <= self._max_size:
                break

        for key in victims:
            del self._locks[key]
            self._record("evictions")

    def size(self) -> int:
        with self._guard:
            return len(self._locks)

    def held_keys(self) -> list[str]:
        """Return resource IDs whose locks are currently held."""
        with self._guard:
            return [k for k, v in self._locks.items() if v.locked()]

    def all_keys(self) -> list[str]:
        with self._guard:
            return list(self._locks.keys())


# ---------------------------------------------------------------------------
# Demo helpers
# ---------------------------------------------------------------------------

_print_lock = threading.Lock()


def _log(thread_name: str, msg: str) -> None:
    """Thread-safe print with aligned columns."""
    with _print_lock:
        print(f"  [{thread_name:<12}] {msg}")


def _simulate_operation(
    cache: ResourceLockCache,
    resource_id: str,
    thread_name: str,
    hold_seconds: float = 0.3,
) -> None:
    """Try to acquire a resource lock, do fake work, then release."""
    if cache.acquire(resource_id):
        _log(thread_name, f"ACQUIRED  lock for '{resource_id}'")
        time.sleep(hold_seconds)
        cache.release(resource_id)
        _log(thread_name, f"RELEASED  lock for '{resource_id}'")
    else:
        _log(thread_name, f"REJECTED  '{resource_id}' is busy -- fail fast")


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 64)
    print("Resource-Scoped Non-Blocking Lock Cache Demo")
    print("=" * 64)

    # Small cache so eviction is visible quickly
    cache = ResourceLockCache(max_size=4)

    # ------------------------------------------------------------------
    # Scenario 1: Two threads hit the SAME resource
    # Second thread gets rejected immediately (no deadlock).
    # ------------------------------------------------------------------
    print("\n--- Scenario 1: Contention on a single resource ---")
    print("    Two threads both want 'product-100'. Second fails fast.\n")

    t1 = threading.Thread(
        target=_simulate_operation,
        args=(cache, "product-100", "writer-A"),
        kwargs={"hold_seconds": 0.4},
    )
    t2 = threading.Thread(
        target=_simulate_operation,
        args=(cache, "product-100", "writer-B"),
        kwargs={"hold_seconds": 0.1},
    )
    t1.start()
    time.sleep(0.05)  # let writer-A grab the lock first
    t2.start()
    t1.join()
    t2.join()

    print(f"\n    Stats so far: {cache.stats}")

    # ------------------------------------------------------------------
    # Scenario 2: Different resources in parallel (no contention)
    # ------------------------------------------------------------------
    print("\n--- Scenario 2: Independent resources in parallel ---")
    print("    Four threads, four different products. All succeed.\n")

    threads = []
    for i in range(4):
        name = f"worker-{i}"
        resource = f"product-{200 + i}"
        t = threading.Thread(
            target=_simulate_operation,
            args=(cache, resource, name),
            kwargs={"hold_seconds": 0.15},
        )
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    print(f"\n    Cache size after 4 new resources: {cache.size()}")
    print(f"    Cached keys: {cache.all_keys()}")
    print(f"    Stats so far: {cache.stats}")

    # ------------------------------------------------------------------
    # Scenario 3: Eviction under pressure
    # Cache is max_size=4. We hold 2 locks and insert 4 more keys,
    # forcing eviction. Only UNLOCKED entries get evicted.
    # ------------------------------------------------------------------
    print("\n--- Scenario 3: Eviction with held locks ---")
    print("    Holding 2 locks, then flooding 4 new resources into a")
    print("    size-4 cache. Only idle entries get evicted.\n")

    # Manually acquire two locks to keep them held during eviction
    cache.acquire("order-A")
    cache.acquire("order-B")
    _log("main-thread", "HOLDING   'order-A' and 'order-B'")
    _log("main-thread", f"Before flood: keys={cache.all_keys()}")

    # Flood new resources -- triggers eviction of unlocked keys
    for i in range(4):
        resource = f"sku-{i}"
        cache.acquire(resource)
        cache.release(resource)

    _log("main-thread", f"After flood:  keys={cache.all_keys()}")
    _log("main-thread", f"Held locks:   {cache.held_keys()}")

    # Verify held locks survived eviction
    held = cache.held_keys()
    assert "order-A" in held, "order-A should survive eviction"
    assert "order-B" in held, "order-B should survive eviction"
    _log("main-thread", "PASSED    held locks survived eviction")

    # Clean up
    cache.release("order-A")
    cache.release("order-B")

    # ------------------------------------------------------------------
    # Scenario 4: Mixed contention with many threads
    # 8 threads fight over 3 resources. Some win, some fail fast.
    # ------------------------------------------------------------------
    print("\n--- Scenario 4: 8 threads, 3 resources ---")
    print("    High contention. Winners hold briefly, losers move on.\n")

    fresh_cache = ResourceLockCache(max_size=6)
    resources = ["inventory-X", "inventory-Y", "inventory-Z"]
    threads = []

    for i in range(8):
        resource = random.choice(resources)
        name = f"thread-{i}"
        hold = round(random.uniform(0.05, 0.2), 3)
        t = threading.Thread(
            target=_simulate_operation,
            args=(fresh_cache, resource, name),
            kwargs={"hold_seconds": hold},
        )
        threads.append(t)

    # Stagger starts slightly so contention is realistic
    for t in threads:
        t.start()
        time.sleep(0.02)
    for t in threads:
        t.join()

    print(f"\n    Final stats: {fresh_cache.stats}")
    print(f"    Cache size:  {fresh_cache.size()}")

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    print("\n" + "=" * 64)
    print("Key behaviors demonstrated:")
    print("  1. Second caller on a held resource fails fast (no deadlock)")
    print("  2. Independent resources lock without contention")
    print("  3. Eviction skips held locks (only idle entries removed)")
    print("  4. High-contention scenario stays responsive")
    print("=" * 64)
