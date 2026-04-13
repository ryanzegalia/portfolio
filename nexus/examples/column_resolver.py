"""
4-Tier CSV Column Resolver
--------------------------
Resolves messy CSV column headers from different vendors into canonical names
using a four-tier strategy: exact match, alias lookup, weighted fuzzy scoring,
and content sniffing. Built for data pipelines that ingest CSVs from multiple
sources where column naming is never consistent.

The real problem: vendor A calls it "Order Total", vendor B calls it
"order_grand_total", vendor C calls it "Grand Tot." and vendor D just
labels it "amount" but the cells are all currency values. This resolver
handles all four without manual mapping per vendor.

See: decisions/004-four-tier-smart-column-resolver.md
"""

import re
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Optional

# ---------------------------------------------------------------------------
# Column normalization
# ---------------------------------------------------------------------------

def _normalize(s: str) -> str:
    """Normalize a header string for comparison.
    Lowercase, strip quotes/non-breaking spaces/whitespace, collapse
    punctuation into spaces. Preserves '#' because it carries meaning
    in headers like 'Order #'."""
    s = s.replace("\xa0", " ").replace('"', "").replace("'", "").strip().lower()
    s = re.sub(r"(?<=[a-z])#", " #", s)  # "confirmation#" -> "confirmation #"
    s = re.sub(r"[._\-/()]", " ", s)
    return re.sub(r"\s+", " ", s).strip()

# ---------------------------------------------------------------------------
# Alias registry (compiled ONCE at import, not per-parse). Add one string
# here when a new vendor shows up instead of writing a custom parser.
# ---------------------------------------------------------------------------
COLUMN_ALIASES: dict[str, list[str]] = {
    "order id":       ["order #", "order no", "order num", "order number",
                       "purchase id", "po number", "confirmation #"],
    "order date":     ["date", "purchase date", "transaction date", "created date"],
    "customer name":  ["name", "buyer name", "sold to", "ship to name", "billing name"],
    "customer email": ["email", "buyer email", "contact email", "account email", "e mail"],
    "product name":   ["item", "item name", "description", "product", "sku description"],
    "quantity":       ["qty", "units", "count", "qty ordered", "quantity ordered"],
    "unit price":     ["price", "item price", "rate", "unit cost", "price each", "unit rate"],
    "subtotal":       ["line total", "extended price", "ext price", "line amount", "row total"],
    "tax amount":     ["tax", "sales tax", "tax collected", "vat", "tax charged"],
    "shipping cost":  ["shipping", "freight", "delivery charge", "ship cost", "postage"],
    "order total":    ["total", "grand total", "order grand total", "amount due"],
    "status":         ["order status", "fulfillment status", "state", "delivery status"],
    "shipping state": ["state", "ship to state", "destination state", "ship state"],
}

# Reverse lookup: normalized alias -> canonical name.
# Built once at import so every parse call is O(1) for tier-2 lookups.
_ALIAS_LOOKUP: dict[str, str] = {}
for _canonical, _aliases in COLUMN_ALIASES.items():
    _ALIAS_LOOKUP[_normalize(_canonical)] = _canonical
    for _alias in _aliases:
        _ALIAS_LOOKUP[_normalize(_alias)] = _canonical

# ---------------------------------------------------------------------------
# Content-sniffing patterns (Tier 4)
# ---------------------------------------------------------------------------
_CONTENT_PATTERNS = {
    "currency": re.compile(r"^\$?-?[\d,]+\.\d{2}$"),
    "date": re.compile(r"^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$"),
    "email": re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$"),
    "integer": re.compile(r"^\d{1,6}$"),
    "state_code": re.compile(r"^[A-Z]{2}$"),
    "id_like": re.compile(r"^[A-Z]{0,4}[\-#]?\d{4,}$"),
}

# Which canonical columns tend to contain which content type (tiebreaker bonus).
_CONTENT_HINTS = {
    "order id": ["id_like"], "order date": ["date"], "customer email": ["email"],
    "quantity": ["integer"], "unit price": ["currency"], "subtotal": ["currency"],
    "tax amount": ["currency"], "shipping cost": ["currency"],
    "order total": ["currency"], "shipping state": ["state_code"],
}

# ---------------------------------------------------------------------------
# Similarity scoring (Tier 3)
# ---------------------------------------------------------------------------

def _jaccard_tokens(a: str, b: str) -> float:
    """Jaccard similarity on word tokens."""
    ta, tb = set(_normalize(a).split()), set(_normalize(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)

def _char_similarity(a: str, b: str) -> float:
    """SequenceMatcher ratio on normalized strings."""
    return SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()

def _fuzzy_score(header: str, canonical: str) -> float:
    """Weighted blend: 60% token overlap + 40% character similarity.
    Token overlap catches reordered words ('total order' vs 'order total').
    Character similarity catches abbreviations ('qty' vs 'quantity')."""
    return 0.6 * _jaccard_tokens(header, canonical) + 0.4 * _char_similarity(header, canonical)

# ---------------------------------------------------------------------------
# Content sniffing (Tier 4)
# ---------------------------------------------------------------------------

def _sniff_column_type(values: list[str]) -> Optional[str]:
    """Sample cell values and vote on the dominant content pattern.
    Returns the winning pattern if >50% of samples match, else None."""
    if not values:
        return None
    samples = [v.strip() for v in values if v.strip()][:20]
    if len(samples) < 2:
        return None

    votes: dict[str, int] = defaultdict(int)
    for val in samples:
        for pname, pattern in _CONTENT_PATTERNS.items():
            if pattern.match(val):
                votes[pname] += 1

    if not votes:
        return None
    best = max(votes, key=votes.get)
    if votes[best] / len(samples) > 0.50:
        return best
    return None

# ---------------------------------------------------------------------------
# Main resolver
# ---------------------------------------------------------------------------

THRESHOLD_AUTO = 0.85    # >= this: accept silently
THRESHOLD_WARN = 0.60    # >= this but < auto: accept with warning
                         # < warn: reject, column stays unresolved

def resolve_columns(
    headers: list[str],
    targets: list[str],
    sample_rows: Optional[list[list[str]]] = None,
) -> dict:
    """Resolve raw CSV headers to canonical column names.

    Tier 1: Exact match after normalization
    Tier 2: Alias table lookup (O(1) dict hit)
    Tier 3: Weighted fuzzy scoring (token Jaccard + char SequenceMatcher)
    Tier 4: Content sniffing bonus (examines actual cell values)

    Returns dict with: mapping, tiers, warnings, unresolved.
    """
    target_set = {_normalize(t): t for t in targets}
    mapping: dict[str, int] = {}
    tiers: dict[str, int] = {}
    warnings: list[str] = []
    matched: set[str] = set()

    for idx, raw_header in enumerate(headers):
        norm = _normalize(raw_header)
        best_canonical: Optional[str] = None
        best_score = 0.0
        best_tier = 0

        # --- Tier 1: Exact match after normalization ---
        if norm in target_set and norm not in matched:
            best_canonical = target_set[norm]
            best_score = 1.0
            best_tier = 1

        # --- Tier 2: Alias lookup ---
        if best_tier == 0 and norm in _ALIAS_LOOKUP:
            candidate = _ALIAS_LOOKUP[norm]
            c_norm = _normalize(candidate)
            if c_norm in target_set and c_norm not in matched:
                best_canonical = candidate
                best_score = 1.0
                best_tier = 2

        # --- Tier 3: Fuzzy match ---
        if best_score < THRESHOLD_AUTO:
            for t_norm, t_orig in target_set.items():
                if t_norm in matched:
                    continue
                score = _fuzzy_score(raw_header, t_orig)
                if score > best_score:
                    best_score, best_canonical, best_tier = score, t_orig, 3
                # Also score against known aliases of this target
                for alias in COLUMN_ALIASES.get(t_norm, []):
                    s = _fuzzy_score(raw_header, alias)
                    if s > best_score:
                        best_score, best_canonical, best_tier = s, t_orig, 3

        # --- Tier 4: Content sniffing bonus ---
        # When a fuzzy candidate sits in the warning zone (0.60-0.84),
        # check if the actual cell values match what we'd expect for that
        # column type. A hit bumps the score by 0.15.
        if (sample_rows
                and best_canonical
                and THRESHOLD_WARN <= best_score < THRESHOLD_AUTO):
            col_values = [row[idx] for row in sample_rows if idx < len(row)]
            detected = _sniff_column_type(col_values)
            if detected:
                expected = _CONTENT_HINTS.get(_normalize(best_canonical), [])
                if detected in expected:
                    best_score = min(best_score + 0.15, 1.0)
                    best_tier = 4

        # --- Record match ---
        if best_canonical and _normalize(best_canonical) not in matched:
            if best_score >= THRESHOLD_AUTO:
                mapping[best_canonical] = idx
                tiers[best_canonical] = best_tier
                matched.add(_normalize(best_canonical))
            elif best_score >= THRESHOLD_WARN:
                mapping[best_canonical] = idx
                tiers[best_canonical] = best_tier
                matched.add(_normalize(best_canonical))
                warnings.append(
                    f"'{raw_header}' -> '{best_canonical}' "
                    f"({best_score:.0%} confidence, tier {best_tier})"
                )

    unresolved = [t for t in targets if _normalize(t) not in matched]
    return {
        "mapping": mapping,
        "tiers": tiers,
        "warnings": warnings,
        "unresolved": unresolved,
    }

# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------
_TIER_LABELS = {1: "exact", 2: "alias", 3: "fuzzy", 4: "content-sniff"}

if __name__ == "__main__":
    # Two CSV exports from different e-commerce vendors, same logical data,
    # completely different column naming.
    vendor_a_headers = [
        "Order #", "Date", "Buyer Name", "E-Mail", "Item Description", "Qty",
        "Price Each", "Line Total", "Sales Tax", "Freight", "Grand Total",
        "Fulfillment Status", "Ship To State",
    ]
    vendor_a_rows = [
        ["ORD-10542", "03/15/2026", "Alice Park", "alice@example.com", "Widget Pro 3000",
         "2", "$49.99", "$99.98", "$8.50", "$12.00", "$120.48", "shipped", "PA"],
        ["ORD-10543", "03/15/2026", "Bob Chen", "bob@example.com", "Gadget Lite",
         "1", "$29.95", "$29.95", "$2.55", "$5.00", "$37.50", "pending", "NJ"],
    ]

    vendor_b_headers = [
        "Confirmation#", "Purchase Date", "Sold To", "Contact Email", "SKU Description",
        "Units", "Unit Rate", "Ext. Price", "Tax Charged", "Delivery Charge",
        "Amount Due", "Order Status", "Destination State",
    ]
    vendor_b_rows = [
        ["B-88401", "2026-03-15", "Carol Diaz", "carol@shop.co", "Sprocket Kit",
         "5", "$12.50", "$62.50", "$5.31", "$8.99", "$76.80", "complete", "CA"],
        ["B-88402", "2026-03-16", "Dan Yee", "dan@mail.org", "Bolt Pack 100ct",
         "10", "$3.99", "$39.90", "$3.39", "$6.50", "$49.79", "processing", "TX"],
    ]

    targets = [
        "order id", "order date", "customer name", "customer email", "product name",
        "quantity", "unit price", "subtotal", "tax amount", "shipping cost",
        "order total", "status", "shipping state",
    ]

    print("=" * 70)
    print("4-Tier CSV Column Resolver Demo")
    print("=" * 70)

    for label, hdrs, rows in [
        ("Vendor A", vendor_a_headers, vendor_a_rows),
        ("Vendor B", vendor_b_headers, vendor_b_rows),
    ]:
        print(f"\n--- {label} ---")
        print(f"Raw headers: {hdrs}\n")

        result = resolve_columns(hdrs, targets, sample_rows=rows)

        for canonical, col_idx in result["mapping"].items():
            tier = result["tiers"][canonical]
            tier_label = _TIER_LABELS.get(tier, f"tier-{tier}")
            print(f"  {hdrs[col_idx]:25s} -> {canonical:20s} [{tier_label}]")

        if result["warnings"]:
            print("\n  Warnings:")
            for w in result["warnings"]:
                print(f"    {w}")

        if result["unresolved"]:
            print(f"\n  Unresolved: {result['unresolved']}")
        else:
            print(f"\n  All {len(targets)} columns resolved.")

    print("\n" + "=" * 70)
    print("Both vendors mapped to the same canonical schema, zero manual config.")
