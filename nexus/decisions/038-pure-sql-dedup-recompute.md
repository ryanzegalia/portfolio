# Deterministic Duplicate Groups via Pure-SQL Recompute

**Status:** Accepted | **Date:** 2026-06-15 | **Theme:** data-quality

## Context

Customer records arriving from multiple upstream sources accumulate duplicates that block clean reporting and identity resolution. Detecting those duplicates needs a single source of truth that any process can reproduce, rather than a grouping that drifts depending on which code path last touched a record. The requirement is a deterministic, auditable grouping over the mirrored account data.

## Decision

Duplicate grouping is computed by an idempotent pure-SQL pass over the mirror that normalizes matching keys (phone last-10, email, and an address key) and assigns a deterministic dup_group_id. The recompute is rerunnable at any time and produces identical results for identical inputs; the first full compute produced 16,705 duplicate groups across 29,124 accounts (2026-06-15).

## Alternatives Considered

Incremental application-side grouping would maintain group membership in application code as records change. It did not fit a data-quality layer whose value depends on being reproducible, because it spreads the matching logic across code paths and invites drift between them, leaving no single rerunnable pass to appeal to as truth.

Immediate probabilistic or machine-learning matching would catch near-duplicates the key-based pass misses, which is real value. It did not fit at this layer because folding fuzzy matching in first would trade determinism for recall before a stable floor existed. That work was deferred to the separate identity-resolution engine, which builds on the conservative deterministic grouping rather than replacing it.

## Consequences

The recompute is cheap to run and auditable, since the grouping is expressed entirely in SQL over the mirror and can be rerun to confirm any group. Group IDs are stable for identical inputs, so downstream consumers can treat a dup_group_id as reproducible rather than a moving target. Probabilistic matching layers on top of this floor instead of competing with it, keeping the deterministic result available even as fuzzier matching evolves. The trade-off is recall: key-based normalization will not catch duplicates that differ in the normalized fields, which is the gap the identity-resolution engine is meant to close.
