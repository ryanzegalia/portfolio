# Conservative Merging with Hard Cannot-Link Invariants

**Status:** Accepted | **Date:** 2026-06-25 | **Theme:** data-quality

## Context

In customer identity resolution, a false merge that joins two distinct customers is more damaging than a missed merge, because it leaks data between real people. Shared contact details make this failure easy to trigger: a dealer account and an unrelated consumer can carry the same ship-to contact email, and any-contact matching signals or an over-trusting edge rule can chain them into one cluster. When downstream re-merge stages are allowed to override earlier splits, the same shared-contact evidence can re-join distinct customers: on the certified build's held-out set, an earlier override-permissive configuration would have re-joined 161 of 395 correctly split accounts across three root causes, which the hard cannot-link invariant and surname structural guard now hold apart.

## Decision

The pipeline adopted hard cannot-link invariants that downstream stages cannot override, switched from any-contact signals to owner-scoped signals (owner email and owner surname), and added a structural guard that splits any cluster holding two or more verified owner emails across two or more surnames. On the certified build this held to a 0.48% false-merge rate at 86.8% held-out recall.

## Alternatives Considered

- **Optimize F1 symmetrically, treating false merges and missed merges as equal-cost errors.** This did not fit the context because the costs are not symmetric: a wrong merge leaks data between customers, while a missed merge only leaves a duplicate that a later, stronger signal can still join.
- **Route every proposed merge through manual review.** This did not fit the context because merge volume is too high to review in full. Human review is reserved for flagged, ambiguous cases instead, where a person adds the most value.

## Consequences

Recall is deliberately sacrificed to keep the false-merge rate low, so some true duplicates persist until owner-scoped evidence strong enough to justify joining them arrives. The cannot-link invariants and the surname structural guard add stages and rules to the pipeline, which is more to maintain and reason about. The payoff is a bounded worst case: the invariants cap the most expensive failure mode rather than chasing a symmetric accuracy score.