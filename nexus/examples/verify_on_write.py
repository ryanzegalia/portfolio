"""Verify-on-write pricing with three-state audit trail.

Pushes a price change to a remote backend, waits for persistence, reads
back the value, and confirms it landed within tolerance. If the read-back
doesn't match, the operation is flagged for review -- never silently marked
as succeeded.

Key behaviors:
  - Three-state lifecycle: queued -> applied -> verified (or mismatch/error).
  - 500ms persistence delay before read-back (empirically tuned for the ERP).
  - $0.01 tolerance on the comparison (backend rounds differently than Python).
  - Per-product threading lock prevents concurrent writes to the same entity.
  - Non-blocking acquire: a second caller gets "already in progress" instantly.
  - Silent rejections (backend accepts the write but doesn't persist) are caught.

See: decisions/011-three-state-price-queue.md
     decisions/008-per-product-operation-locks.md
Run: python verify_on_write.py
"""

import threading
import time
from collections import OrderedDict


# ---------------------------------------------------------------------------
# Three-state audit record
# ---------------------------------------------------------------------------

class PriceChangeRecord:
    """One price change through its lifecycle.

    queued  -- intent recorded, nothing sent yet
    applied -- backend accepted the write (HTTP 200), persistence unknown
    verified -- read-back confirmed the value landed
    mismatch -- read-back returned a different value (operator review needed)
    error   -- something broke; message says what
    """

    def __init__(self, product_id, option_id, new_price, old_price=None):
        self.product_id = product_id
        self.option_id = option_id
        self.old_price = old_price
        self.new_price = new_price
        self.status = "queued"
        self.queued_at = time.time()
        self.applied_at = None
        self.verified_at = None
        self.readback_price = None
        self.error = None

    def mark_applied(self):
        self.status = "applied"
        self.applied_at = time.time()

    def mark_verified(self, readback):
        self.status = "verified"
        self.verified_at = time.time()
        self.readback_price = readback

    def mark_mismatch(self, readback):
        self.status = "mismatch"
        self.verified_at = time.time()
        self.readback_price = readback

    def mark_error(self, msg):
        self.status = "error"
        self.error = msg


# ---------------------------------------------------------------------------
# Per-product operation lock (bounded LRU, non-blocking)
# ---------------------------------------------------------------------------

class OperationLockCache:
    """Bounded cache of per-entity locks.

    Non-blocking acquire returns False immediately if the entity is already
    locked. When the cache exceeds max_size, the oldest UNLOCKED entries
    are evicted -- a lock held by an active operation is never removed.
    """

    def __init__(self, max_size=500):
        self._max = max_size
        self._locks = OrderedDict()
        self._guard = threading.Lock()

    def try_acquire(self, entity_id):
        with self._guard:
            if entity_id in self._locks:
                self._locks.move_to_end(entity_id)
                lock = self._locks[entity_id]
            else:
                lock = threading.Lock()
                self._locks[entity_id] = lock
                self._evict()
            return lock.acquire(blocking=False), lock

    def release(self, entity_id):
        with self._guard:
            lock = self._locks.get(entity_id)
        if lock:
            lock.release()

    def _evict(self):
        while len(self._locks) > self._max:
            victims = [k for k, v in self._locks.items() if not v.locked()]
            if not victims:
                break
            del self._locks[victims[0]]


# ---------------------------------------------------------------------------
# Mock ERP backend
# ---------------------------------------------------------------------------

class MockERP:
    """Simulates a backend with delayed persistence and configurable failures.

    write_price() accepts immediately but the value doesn't appear in
    read_price() until persistence_delay_ms later. One option ID is
    configured to silently reject writes (returns 200 but doesn't persist).
    """

    def __init__(self, persistence_delay=0.4, reject_option=None):
        self._pending = {}       # (product, option) -> (price, write_time)
        self._persisted = {}     # (product, option) -> price
        self._reject = reject_option
        self._delay = persistence_delay

    def write_price(self, product_id, option_id, price):
        """Accept a price write. Returns True (200 OK). May not persist."""
        key = (product_id, option_id)
        if option_id == self._reject:
            return True  # accepted but silently dropped
        self._pending[key] = (price, time.time())
        return True

    def read_price(self, product_id, option_id):
        """Read the current price. Pending writes become visible after delay."""
        key = (product_id, option_id)
        if key in self._pending:
            price, wrote_at = self._pending[key]
            if time.time() - wrote_at >= self._delay:
                self._persisted[key] = price
                del self._pending[key]
        return self._persisted.get(key)


# ---------------------------------------------------------------------------
# Verify-on-write engine
# ---------------------------------------------------------------------------

VERIFY_DELAY = 0.5   # seconds to wait before read-back
TOLERANCE = 0.01     # dollar tolerance on the comparison

_locks = OperationLockCache(max_size=8)  # small for demo visibility


def apply_and_verify(erp, product_id, option_id, new_price, old_price=None):
    """Push a price, wait, read back, confirm.

    Returns a PriceChangeRecord in a terminal state (verified/mismatch/error).
    Non-blocking: if the product is already locked, returns error immediately.
    """
    record = PriceChangeRecord(product_id, option_id, new_price, old_price)

    acquired, _ = _locks.try_acquire(product_id)
    if not acquired:
        record.mark_error("Product already locked -- operation in progress")
        return record

    try:
        # Phase 1: push the price
        ok = erp.write_price(product_id, option_id, new_price)
        if not ok:
            record.mark_error("Backend rejected the write")
            return record
        record.mark_applied()

        # Phase 2: wait for persistence, then read back
        time.sleep(VERIFY_DELAY)
        readback = erp.read_price(product_id, option_id)

        if readback is None:
            record.mark_mismatch(readback)
        elif abs(readback - new_price) <= TOLERANCE:
            record.mark_verified(readback)
        else:
            record.mark_mismatch(readback)

        return record
    except Exception as e:
        record.mark_error(str(e))
        return record
    finally:
        _locks.release(product_id)


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

def _show(label, rec):
    elapsed = ""
    if rec.verified_at and rec.queued_at:
        elapsed = f" ({(rec.verified_at - rec.queued_at) * 1000:.0f}ms)"
    rb = f"${rec.readback_price:.2f}" if rec.readback_price is not None else "None"
    print(f"  {rec.option_id:<12} ${rec.old_price or 0:.2f} -> "
          f"${rec.new_price:.2f}  readback={rb}  [{rec.status}]{elapsed}")
    if rec.error:
        print(f"  {'':12} error: {rec.error}")


if __name__ == "__main__":
    print("=" * 66)
    print("Verify-on-Write Pricing Demo")
    print("=" * 66)

    # --- Scenario 1: happy path ---
    print("\n--- Scenario 1: Successful apply + verify ---")
    erp = MockERP()
    rec = apply_and_verify(erp, "PROD-100", "OPT-A", 49.99, old_price=39.99)
    _show("happy", rec)
    assert rec.status == "verified"

    # --- Scenario 2: concurrent lock rejection ---
    print("\n--- Scenario 2: Concurrent lock (non-blocking reject) ---")
    # Hold a lock on PROD-200
    acquired, lock = _locks.try_acquire("PROD-200")
    assert acquired
    # Second caller gets rejected instantly
    rec = apply_and_verify(erp, "PROD-200", "OPT-B", 29.99)
    _show("locked", rec)
    assert rec.status == "error"
    lock.release()
    # Retry succeeds
    rec = apply_and_verify(erp, "PROD-200", "OPT-B", 29.99, old_price=24.99)
    _show("retry", rec)
    assert rec.status == "verified"

    # --- Scenario 3: silent backend rejection ---
    print("\n--- Scenario 3: Silent rejection (backend drops the write) ---")
    erp_reject = MockERP(reject_option="OPT-GHOST")
    rec = apply_and_verify(erp_reject, "PROD-300", "OPT-GHOST", 19.99, old_price=14.99)
    _show("ghost", rec)
    assert rec.status == "mismatch"
    print("  Note: Backend returned 200 but the price never persisted.")

    # --- Scenario 4: bulk sequential ---
    print("\n--- Scenario 4: Bulk update (800+ options, sequential) ---")
    erp = MockERP()
    options = [(f"OPT-{i:03d}", 10.00 + i * 0.50, 9.00 + i * 0.50)
               for i in range(6)]
    results = []
    for opt_id, new_p, old_p in options:
        rec = apply_and_verify(erp, "PROD-SALE", opt_id, new_p, old_price=old_p)
        results.append(rec)

    verified = sum(1 for r in results if r.status == "verified")
    flagged = sum(1 for r in results if r.status != "verified")
    print(f"  {len(results)} options processed: {verified} verified, {flagged} flagged")
    for r in results:
        _show("bulk", r)
    assert verified == len(results)

    # --- Summary ---
    print("\n" + "=" * 66)
    print("Key behaviors demonstrated:")
    print("  1. Apply -> wait -> read-back -> compare within $0.01")
    print("  2. Non-blocking lock rejects concurrent ops on same product")
    print("  3. Silent backend rejections caught by verify step")
    print("  4. Bulk operations run sequentially through same pipeline")
    print("=" * 66)
