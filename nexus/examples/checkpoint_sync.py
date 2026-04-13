"""Incremental checkpoint sync with false-positive suppression.

Syncs a remote product catalog into a local SQLite database using stamp-based
incremental fetches. Only records modified after the last checkpoint are pulled.

Key behaviors:
  - _norm() collapses type chaos (0 vs 0.0 vs "0" vs None vs "") to prevent
    spurious diffs.
  - Checkpoint advances ONLY after successful commit, never before.
  - full_refresh re-scans everything but leaves the checkpoint intact.
  - Voided/duplicate records deduplicated: active > voided, highest ID on ties.

See: decisions/006-checkpoint-based-incremental-sync.md
Run: python checkpoint_sync.py
"""

import sqlite3


# ---------------------------------------------------------------------------
# Normalization: the single function that prevents most false-positive diffs
# ---------------------------------------------------------------------------

def _norm(val):
    """Collapse type-ambiguous values into a canonical form for comparison.

    The same field comes back as 0, 0.0, "0", None, or "" depending on which
    endpoint you hit. Without normalization every tick flags phantom changes.
    """
    if val is None or (isinstance(val, str) and val.strip() == ""):
        return None
    if isinstance(val, str):
        try:
            return float(val)
        except ValueError:
            return val.strip()

    if isinstance(val, bool):
        return 1.0 if val else 0.0

    if isinstance(val, (int, float)):
        return float(val)

    return val


def _row_changed(old_row, new_row, fields):
    """Return True only if a real field value differs after normalization."""
    for f in fields:
        if _norm(old_row.get(f)) != _norm(new_row.get(f)):
            return True
    return False


# ---------------------------------------------------------------------------
# Deduplication: prefer active records, break ties by highest ID
# ---------------------------------------------------------------------------

_STATUS_RANK = {"active": 0, "pending": 1, "voided": 2}


def _dedup(records):
    """Keep one record per product_code: active > voided, highest id wins ties."""
    best = {}
    for rec in records:
        code = rec["product_code"]
        if code not in best:
            best[code] = rec
            continue
        existing = best[code]
        e_rank = _STATUS_RANK.get(existing["status"], 99)
        n_rank = _STATUS_RANK.get(rec["status"], 99)
        if n_rank < e_rank or (n_rank == e_rank and rec["id"] > existing["id"]):
            best[code] = rec
    return list(best.values())


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

SYNC_FIELDS = ("name", "price", "weight", "status")


def _init_db(conn):
    """Create tables for products and sync checkpoints."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT UNIQUE NOT NULL,
            name         TEXT,
            price        REAL,
            weight       REAL,
            status       TEXT DEFAULT 'active'
        );
        CREATE TABLE IF NOT EXISTS sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    """)


def _get_checkpoint(conn, key):
    """Read the stored checkpoint value, defaulting to 0."""
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key = ?", (key,)
    ).fetchone()
    return int(row[0]) if row else 0


def _set_checkpoint(conn, key, value):
    """Write checkpoint using upsert so it works on first run too."""
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


# ---------------------------------------------------------------------------
# Sync engine
# ---------------------------------------------------------------------------

def run_sync(conn, fetch_fn, full_refresh=False):
    """Fetch changed records, diff against local state, upsert real changes.

    Returns a dict of counts: fetched, inserted, updated, skipped, checkpoint.
    """
    if full_refresh:
        # Scan everything, but do NOT touch the checkpoint afterward.
        since = 0
    else:
        since = _get_checkpoint(conn, "product_stamp")

    remote_records = fetch_fn(since)
    remote_records = _dedup(remote_records)

    inserted = 0
    updated = 0
    skipped = 0
    max_stamp = since

    for rec in remote_records:
        max_stamp = max(max_stamp, rec.get("stamp", 0))

        existing = conn.execute(
            "SELECT product_code, name, price, weight, status "
            "FROM products WHERE product_code = ?",
            (rec["product_code"],),
        ).fetchone()

        if existing is None:
            conn.execute(
                "INSERT INTO products (product_code, name, price, weight, status) "
                "VALUES (?, ?, ?, ?, ?)",
                (rec["product_code"], rec["name"], rec["price"],
                 rec["weight"], rec["status"]),
            )
            inserted += 1
        else:
            old = dict(zip(
                ("product_code", "name", "price", "weight", "status"),
                existing,
            ))
            if _row_changed(old, rec, SYNC_FIELDS):
                conn.execute(
                    "UPDATE products SET name=?, price=?, weight=?, status=? "
                    "WHERE product_code=?",
                    (rec["name"], rec["price"], rec["weight"],
                     rec["status"], rec["product_code"]),
                )
                updated += 1
            else:
                skipped += 1

    # Checkpoint advances ONLY after successful commit, ONLY in delta mode.
    conn.commit()
    if not full_refresh and max_stamp > since:
        _set_checkpoint(conn, "product_stamp", max_stamp)
        conn.commit()

    return {
        "fetched": len(remote_records),
        "inserted": inserted,
        "updated": updated,
        "skipped_false_positives": skipped,
        "checkpoint": _get_checkpoint(conn, "product_stamp"),
    }


# ---------------------------------------------------------------------------
# Mock data source (simulates a remote catalog API)
# ---------------------------------------------------------------------------

_CATALOG = [
    {"id": 1, "product_code": "WDG-100", "name": "Standard Widget",
     "price": 9.99, "weight": 0.5, "status": "active", "stamp": 1},
    {"id": 2, "product_code": "WDG-200", "name": "Deluxe Widget",
     "price": 19.99, "weight": 1.2, "status": "active", "stamp": 1},
    # Voided duplicate of WDG-200: dedup should prefer active id=2 over this
    {"id": 3, "product_code": "WDG-200", "name": "Deluxe Widget",
     "price": 19.99, "weight": 1.2, "status": "voided", "stamp": 1},
    {"id": 4, "product_code": "GZM-050", "name": "Gizmo Mini",
     "price": 4.5, "weight": 0, "status": "active", "stamp": 1},
]

_TICK = 0


def mock_fetch(since):
    """Return records with stamp > since. Mutates catalog between ticks."""
    global _TICK
    _TICK += 1

    if _TICK == 2:
        # Tick 2: real price change + new product
        _CATALOG[0] = {**_CATALOG[0], "price": 10.99, "stamp": 2}
        _CATALOG.append(
            {"id": 5, "product_code": "SPR-001", "name": "Sprocket Alpha",
             "price": 7.25, "weight": 0.3, "status": "active", "stamp": 2},
        )
    elif _TICK == 3:
        # Tick 3: false-positive bait. Remote sends weight as "0" (string)
        # instead of 0 (int), and price as "4.50" instead of 4.5.
        # _norm() should suppress both.
        _CATALOG[3] = {**_CATALOG[3], "weight": "0", "price": "4.50", "stamp": 3}

    return [dict(r) for r in _CATALOG if r["stamp"] > since]


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    conn = sqlite3.connect(":memory:")
    _init_db(conn)

    def _show(label, r):
        print(f"\n--- {label} ---")
        print(f"  Fetched: {r['fetched']}  Inserted: {r['inserted']}  "
              f"Updated: {r['updated']}  Skipped: {r['skipped_false_positives']}")
        print(f"  Checkpoint: {r['checkpoint']}")

    print("=" * 62)
    print("Checkpoint Sync Demo")
    print("=" * 62)

    # Tick 1: initial load (voided duplicate WDG-200 id=3 gets dropped)
    _show("Tick 1: Initial delta sync", run_sync(conn, mock_fetch))
    print("  Note: WDG-200 voided duplicate (id=3) dropped, active (id=2) kept.")

    # Tick 2: real price change + new product
    _show("Tick 2: Price change + new product", run_sync(conn, mock_fetch))

    # Tick 3: false-positive bait (0 vs "0", 4.5 vs "4.50")
    result = run_sync(conn, mock_fetch)
    _show("Tick 3: Type-ambiguous data (0 vs '0', 4.5 vs '4.50')", result)
    if result["skipped_false_positives"] > 0:
        print(f"  _norm() suppressed {result['skipped_false_positives']} "
              "false-positive diff(s).")

    # Full refresh: re-scan without advancing checkpoint
    saved_cp = _get_checkpoint(conn, "product_stamp")
    result = run_sync(
        conn, lambda _s: [dict(r) for r in _CATALOG], full_refresh=True,
    )
    _show(f"Full refresh (checkpoint was {saved_cp})", result)
    assert _get_checkpoint(conn, "product_stamp") == saved_cp
    print(f"  Checkpoint unchanged at {saved_cp}. Next delta tick still works.")

    # Final DB state
    print("\n--- Final catalog state ---")
    rows = conn.execute(
        "SELECT product_code, name, price, weight, status "
        "FROM products ORDER BY product_code"
    ).fetchall()
    fmt = "  {:<12} {:<20} {:>7} {:>7} {}"
    print(fmt.format("Code", "Name", "Price", "Weight", "Status"))
    print(fmt.format("-" * 12, "-" * 20, "-" * 7, "-" * 7, "-" * 8))
    for code, name, price, weight, status in rows:
        print(fmt.format(code, name, f"{price:.2f}", f"{weight:.1f}", status))

    print("\n" + "=" * 62)
    print("All ticks complete. Zero false-positive writes.")
    print("=" * 62)