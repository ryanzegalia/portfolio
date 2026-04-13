# ADR-035: Product Version Linked List for the ERP Duplication-Based Versioning

## Context

the ERP (the company's ERP) handles product changes by duplicating the record rather than updating it in place. Every SKU change, option rename, or pricing modification creates a new row in the ERP's `models` table with a fresh ID, and the old row is marked void (prefixed with `^`). The part number -- which Nexus uses as the stable product identifier -- stays the same across versions, but the internal the ERP ID changes on every edit.

This creates a downstream problem in Nexus. For every product there might be 5, 10, or 50 historical versions stored in the ERP. Nexus needs to know which version is current, trace back through version history for reporting ("what was the price 6 months ago?"), handle references to old versions gracefully (a purchase order may reference an old version ID even though the product has since been updated), and resolve any historical version ID to the current product without requiring a full-table scan.

## Decision

Model the version chain as a linked list inside the `product_versions` table, using `predecessor_id` and `successor_id` columns that both reference `erp_product_id` within the same table.

```sql
CREATE TABLE product_versions (
    erp_id INTEGER PRIMARY KEY,
    uuid TEXT REFERENCES products(uuid),
    predecessor_id INTEGER,        -- ID of previous version
    successor_id INTEGER,          -- ID of next version
    web_active INTEGER,
    is_current INTEGER,
    void_prefix TEXT,              -- '^' for voided versions
    created_at TIMESTAMPTZ,
    ...
);
```

`predecessor_id` points backward to the previous version; `successor_id` points forward to the next. The current version has `successor_id = NULL` and `is_current = 1`. Older versions have `successor_id` pointing to the version that replaced them. Given any `erp_id`, traversing the chain in either direction takes O(chain length) -- typically 5-20 hops.

The `product_resolver.py` service handles lookup. Given any historical `erp_id`, it walks the `successor_id` chain until it reaches the current version (or hits a NULL successor). The current version's `uuid` is the stable identifier used throughout the rest of Nexus.

Every new product sync compares the incoming the ERP snapshot against the stored version chain. If a new version has appeared (new ID with matching part number), the old version gets `successor_id` set to the new one, `is_current = 0`, and the new version is inserted with `predecessor_id` pointing back.

## Alternatives Considered

- **Recursive CTE traversal on every lookup.** Would give the same traversal without storing explicit links. Rejected because the linked list is cheap to maintain (one column update per version transition) and makes queries far simpler. A CTE traversal adds complexity to every query that touches version history.

- **Materialized "current version" view only.** Would handle the "which version is current" question but lose the history. Nexus needs the history for price change audits and cross-version reporting.

- **Store the whole chain as a JSON array on the current version row.** Would work but makes single-version lookups painful -- you'd have to scan every current row to find whether a given historical ID appears in any chain.

- **Mirror the ERP's own model table structure.** Nexus already stores the raw the ERP ID column. The linked list is additive -- it doesn't replace the raw data, it adds relationship metadata that the ERP doesn't expose.

- **Use a graph database.** Overkill. The relationships are simple linked lists, not arbitrary graphs. A relational table with two self-referential columns is sufficient.

## Consequences

Resolving any historical `erp_id` to the current product is a simple `successor_id` walk -- no recursive queries, no application-layer recursion with a depth limit. Price history across versions is natural: join `price_history` against `product_versions` by `erp_id`, walk the chain, and every price change across every version is visible. Voided products stay queryable. the ERP's versioning model is contained in one service (`product_resolver.py`); the rest of the codebase sees a clean "product → current version" abstraction.

The costs: chain-walking has a performance cost, fine for 5-20 hops but a problem if a product went through hundreds of versions (the longest chain observed in production is ~15). Broken chains are possible if the sync logic has a bug -- if `predecessor_id` and `successor_id` get inconsistent, the walk produces wrong results. A nightly consistency check (part of the nightly sync pipeline) validates chain integrity. The chain also only grows forward with no garbage collection of very old versions, so for a product with a long history the chain accumulates indefinitely -- not yet a practical problem, but the ceiling exists.