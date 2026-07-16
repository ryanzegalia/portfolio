# ADR-004: Four-Tier Smart Column Resolver for Tax Reconciliation

## Context

Every month, the accounting team reconciled tax data across three different systems -- the tax engine (the tax processor), the ERP (order management), and Stripe (payments). Each system exports a CSV with its own column naming conventions. The tax engine has historically renamed fields across versions. The ERP exports have pre-header metadata rows and use a mix of "Order #", "Order No", and "Order Number" across different export types. Stripe uses camelCase IDs nobody else uses.

The original parser used hardcoded column positions: `col.get('Column Name', fallback_index)`. If the column name matched, it read from that column. If not, it silently fell back to the hardcoded index. This is a data corruption bug waiting to happen.

From the pre-hardening plan:

> "The current parser uses `col.get('Column Name', fallback_index)` -- if a column name doesn't match, it silently falls back to a hardcoded column position. If column ORDER changed but the file still passes detection (which only checks 2-3 signature columns), data would map to wrong columns. This is silent data corruption -- the worst kind of bug for non-technical users."

> "The users -- the accounting team lead and the rest of the accounting team -- are non-technical. The tool needs to 'just work like magic' regardless of: column names changing between the ERP/the tax engine/Stripe software updates, column order changing in exports, uploading the wrong file by accident, partial or corrupted CSV files."

## Decision

**Four-tier column resolution.** For every expected column, try the tiers in order, accept the first one that succeeds above a threshold:

1. **Tier 1 -- Exact match (after normalization).** Lowercase the header, strip whitespace, strip quotes, strip `\xa0` (non-breaking space), collapse multiple spaces, remove punctuation. Match against the canonical name. Covers ~70% of real-world headers.

2. **Tier 2 -- Alias table.** A curated dict mapping canonical names to a list of known variants. `"merchandise_sales_tax"` -> `["merch sales tax", "merchandise tax", "mst", ...]`. Covers the remaining ~25% -- the cases where the tax engine renamed a field and the rename is already catalogued.

3. **Tier 3 -- Fuzzy match.** Combines Jaccard token similarity (60% weight) with `difflib.SequenceMatcher` character similarity (40% weight). If the score is >= 0.85, auto-accept silently. If 0.60-0.84, accept but attach a warning: *"Column 'Merch. Sales Tax' matched to 'Merchandise Sales Tax' (78% confidence)"*. Below 0.60, reject and add to the `unmatched` list with the best guess for operator review.

4. **Tier 4 -- Content sniffing.** If none of the above resolved a column, look at the actual data. Does the column contain values that match a known pattern? Amounts have dollar ranges. Dates have a date pattern. Transaction IDs have a specific format. This tier is a last-resort tiebreaker -- it adds a confidence bonus to a borderline fuzzy match rather than standing alone.

From the plan:

> "Don't just fail -- try really hard to figure out what the columns are, THEN fail gracefully if genuinely stumped. Belt and suspenders."

Header normalization is shared across all tiers. The docstring (`tax_recon_service.py:43-46`):

> "Normalize a column header for comparison. Lowercase, strip quotes/\\xa0/whitespace, collapse spaces, remove punctuation. Note: # is preserved (meaningful in 'Order #', 'Return #')."

## Alternatives Considered

- **Hardcoded column positions** (the original, rejected). Silent data corruption on any column reorder. Non-recoverable for non-technical users.

- **Fail on unknown columns.** Safer than silent corruption but hostile to the user. The accounting team lead uploads an the tax engine export, it fails because the tax engine renamed `MerchSalesTax` to `MerchandiseSalesTax`, and they have no idea why. The fix would require an engineering patch every time a vendor ships an update.

- **Ask the user to map columns manually.** Used in generic CSV import tools (Excel "Text Import Wizard" style). Rejected because the reconciliation pipeline runs dozens of times per month and the mapping is the same 99% of the time. Manual override is available for the `unmatched` case, but it's the fallback, not the default.

- **LLM-based column inference.** Would have worked but adds an API dependency, a cost per run, and non-determinism. The four-tier resolver is fully deterministic, runs offline, and covers ~99% of real-world headers.

- **Regex-based header matching.** Similar to the alias table but harder to maintain. Adding a regex for every new variation is more ceremony than adding a string to a list. Alias table won.

## Consequences

**Good:**
- The accounting team has not had a parser failure since the four-tier resolver shipped. The tax engine renamed `CUST/VENDOR CODE` to `customer id` in one release; the fuzzy tier caught it with 81% confidence and attached a low-severity warning. Zero engineering intervention.
- The alias table doubles as a change log. Adding `"merch_tax" -> "merchandise_sales_tax"` is a one-line commit that documents a vendor rename.
- Warnings with confidence scores teach the user what to trust. A 95% match is silent; a 72% match says "I accepted this but you might want to check." No hidden magic.
- Content sniffing as a tiebreaker (not a standalone tier) keeps the resolver deterministic -- no column gets resolved purely on data inspection, only on name matching with content as a bonus signal.
- The pattern is reusable. Any future parser that has to handle naming drift can drop in the same resolver.

**Bad / costs:**
- The 3,906-line `tax_recon_service` file is the single largest service in the codebase. A significant fraction of that is the column resolver, the alias table, and the per-field type handlers. It's dense and requires careful reading.
- Fuzzy thresholds (0.60, 0.85) are judgment calls. Set them too low and wrong columns get accepted; set them too high and the alias table has to cover everything.
- A truly unknown column still requires operator intervention. The resolver gets as close as possible but some columns can only be resolved by a human the first time. That's a bounded one-time cost.
- The content sniffing tier is the least-tested. It rarely fires in practice, which means bugs in it wouldn't surface until an edge case.