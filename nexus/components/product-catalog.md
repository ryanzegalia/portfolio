# Product Catalog
> Part of the Nexus production automation platform

Transforms the ERP's raw product data into a website-ready catalog with stable URLs, human-friendly option names, and computed pricing.

Five services turn the ERP's raw product data into a website-ready catalog.

## What it is

The transformation layer between the ERP's ERP data model (which uses duplication-based versioning and raw option names) and the public website's JSON catalog (which expects human-friendly names, stable URLs, and computed option pricing). Also handles historical product version resolution and change ripple analysis.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/catalog_service.py` | 740 | Main transformation. Reads from PostgreSQL, outputs `products.v1.json` and `sales.v1.json` in the format the website expects. Uses UUID to catalog_key mapping with 3-tier priority (DB url_mappings -- hardcoded fallback -- auto-derivation). |
| `api/services/option_display.py` | 381 | Maps raw the ERP option names to 11 human-friendly categories used in email templates and the catalog. |
| `api/services/option_metadata.py` | 285 | Display rules for product options on the website. |
| `api/services/change_ripple.py` | 278 | Computes the blast radius of an option change -- which products and SKUs are affected. Pure read-only analysis. |
| `api/services/product_resolver.py` | 220 | Resolves historical `models_id` references to the current active product version via the linked-list chain. |
| `api/services/url_mapping_service.py` | 30 | Read-only lookup for catalog keys from `url_mappings` table. Minimal utility. |

## Scale

- **56+ product types** handled
- **11 option display categories** in `option_display.py`
- **3-tier URL mapping priority**: DB overrides -- hardcoded fallbacks -- auto-derivation from slugified name
- **Public API, no auth** -- the catalog endpoints are cached via Cloudflare edge with short TTLs

## Key Decisions

- **[ADR-035: Product version linked list for the ERP duplication](../decisions/035-product-version-linked-list-for-erp-duplication.md)** -- the `product_versions` table uses `predecessor_id` and `successor_id` columns to encode the ERP's duplication-based versioning as a navigable graph. `product_resolver.py` walks the chain to resolve any historical `models_id` to the current version.
- **Public catalog is Cloudflare-cached.** `catalog_service.py` sets `public cache headers` via `set_public_cache_headers()`. `cloudflare_service.py` purges specific URLs after edits. Short TTLs (10 seconds) because CF edge does the real caching; the short TTL avoids multi-worker stale data.
- **Drop-in JSON replacement for the previous static export.** The catalog API was designed so the website team didn't have to change anything -- it replaced the static `products.v1.json` file with a live API endpoint that returns the same structure. Zero frontend changes required.
- **Option filtering by type or brand** -- `/api/v1/catalog?brand=brand-a` or `?brand=brand-b` filters the output without re-querying the database.

## Integration Points

**Reads from:**
- `products`, `product_content`, `skus`, `product_options`, `sku_options`
- `product_versions` (for historical resolution)
- `url_mappings` (for catalog key overrides)
- `rel_option_metadata`, `rel_option_groups`, `rel_option_choices` (Relations Zone metadata)

**Writes to:**
- Nothing (read-only service layer).

**Outputs:**
- `products.v1.json` via `/api/v1/catalog` (public)
- `sales.v1.json` via `/api/v1/catalog?type=sales` (public)
- Cache purges via Cloudflare API after upstream data changes