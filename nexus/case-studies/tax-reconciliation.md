# Case Study: Tax Reconciliation

## Problem

Every month, the company accounting team ran a three-way tax reconciliation by hand. The process: export CSVs from the tax engine, the ERP, and Stripe, clean the columns (each system used different names for the same fields), paste into a state-by-state template, compare what was charged against what was calculated against what was paid, and investigate every discrepancy.

The accounting team lead's own estimate: one full week per month. That is 12 weeks a year spent verifying the books were consistent. Column renames in vendor exports were a recurring pain point -- if the tax engine renamed a field between two exports, the team had to notice, figure out which column was now which, and manually re-map before any numbers could be compared.

## Approach

`tax_recon_service.py` -- the largest single service in the Nexus codebase -- is a fully automated three-way reconciliation engine that handles column drift on its own.

The core is a **4-tier column resolver**. For every expected field, the resolver tries tiers in order and accepts the first match above a confidence threshold:

1. **Exact match** after header normalization (lowercase, strip whitespace, strip non-breaking spaces, strip punctuation). Handles 70% of real-world columns.
2. **Alias table lookup** -- a curated dict mapping canonical names to known variants. Covers the remaining 25%. Adding a new alias is a one-line commit.
3. **Fuzzy match** combining token Jaccard similarity (60% weight) with character-level `SequenceMatcher` (40% weight). Auto-accept at 0.85; accept with a low-confidence warning at 0.60-0.84; reject below 0.60.
4. **Content sniffing** -- look at actual cell values to bonus-score borderline fuzzy matches. Amounts have dollar ranges; dates have date patterns; transaction IDs have specific formats.

Every import is stored as an entity with field-level change tracking. Re-importing the same month's data is idempotent -- any changes since the last import write to `tax_recon_changes`, giving the team a diff of what changed between runs.

The tax engine side runs as a background heartbeat on a 5-minute cadence. `tax_engine_heartbeat.py` pulls new transactions from the tax engine's REST API (free, unlimited reads -- confirmed with the tax engine), creates the ERP stub records automatically, and enriches them against the ERP REST API in the same tick. Both sides of the reconciliation appear in Nexus without any manual export.

On top of the reconciliation, the same data drives a 50-state post-Wayfair economic nexus dashboard. For every state, Nexus tracks year-to-date sales and transaction counts against the state's own nexus threshold (most states: $100K OR 200 transactions; NY requires both; Kansas has zero threshold). The dashboard shows current exposure and projected crossings so the team sees where the primary brand is approaching economic nexus before it happens, not after.

## Technical Highlights

- **4-tier column resolver** with Jaccard token similarity, character-level fuzzy matching, and content-based tiebreaking. Handles the tax engine column renames automatically without code changes.
- **40+ canonical column names** with hundreds of alias variants in `COLUMN_ALIASES`. Adding a new alias is a one-line commit.
- **Idempotent upserts** with field-level change log. Re-importing produces a diff, not a duplicate.
- **13 inline idempotent schema migrations** -- every schema evolution is a no-op when re-run. Deploying the service a hundred times produces the same final schema.
- **Free-reads the tax engine integration.** `GET /transactions` costs nothing, so the 5-minute polling cadence is effectively free. POST endpoints (which count against the tax engine's 7,500/year quota) are never called from Nexus.
- **Post-Wayfair nexus engine** covering all 50 states + DC with state-specific thresholds, per-state AND/OR logic flags, and year-to-date projections.

## Outcome

**37,847 transactions** reconciled across the tax engine, the ERP, and Stripe. The accounting team lead's monthly reconciliation went from **~1 week/month to automated** -- discrepancies surface in the dashboard as soon as they are detected, not a month later.

No known parser failures since the **4-tier column resolver** shipped. the tax engine has renamed fields at least twice in the observed window; the fuzzy tier caught both without human intervention, attaching low-confidence warnings so the team knew to verify.

The nexus dashboard caught near-crossings in two states before the threshold was reached, giving finance time to prepare registrations instead of scrambling after the fact. Because the reconciliation data was already flowing through the system, adding 50-state nexus exposure tracking was a natural extension -- about 200 lines of Python and a lookup table of state thresholds.

See also: [ADR-004: Four-tier smart column resolver](../decisions/004-four-tier-smart-column-resolver.md), [ADR-015: Tax Engine Reconciliation Read-Only Pattern](../decisions/015-tax-engine-reconciliation-read-only-pattern.md), [ADR-019: Idempotent schema migrations](../decisions/019-idempotent-schema-migrations.md).