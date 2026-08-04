# Customer Identity Resolution

## Problem

A multi-brand B2B/B2C hardware manufacturer carried roughly 43,000 customer accounts in its ERP, where one real customer often held several: households, shared emails, repeat guest checkouts, and dealer staff. Exact-match deduplication cannot collapse these, fragmenting the view of the same person across internal systems. A wrong merge is worse than a missed one, because it leaks one customer's orders and contact history into another customer's view. The design target is therefore precision ahead of recall.

## Approach

The engine uses Splink probabilistic record linkage over the governed Postgres mirror, joined with cross-signals from the support desk and the customer portal, to group accounts into persons and clusters. Because a future authoritative source (portal-verified accounts) may eventually replace the heuristic matching, the resolver sits behind a pluggable seam: the system launched on a conservative provisional matcher behind an interface, so a stronger source can swap in without downstream rework (ADR-039, 2026-06-14). The certified build deployed to production on 2026-06-22 grouped **~27,900 persons into ~7,700 clusters across ~23,500 members and ~1,300 hierarchy accounts**, measured on that same build at a **0.48% false-merge rate, 88.8% of persons definitively known, and 86.8% held-out recall**. Serving is split from truth: Postgres remains the source of record, while Typesense is a nightly-rebuilt derived index that backs the customer viewer. Rollout advances through phased gates, identity tables first, then facet ingestion, then the internal UI, and only later any customer-facing surface, keeping unreviewed builds away from customers by design.

## Technical Highlights

- **Pluggable resolver seam.** The provisional matcher lives behind an interface so an authoritative portal-account source can replace it later without touching downstream stages, which keeps the launch conservative without painting the future into a corner (ADR-039).
- **Owner-scoped email edges.** An early "trusted verified-email edge" joined on any contact email on an account rather than the account owner's, which merged a high-value dealer account with an unrelated consumer account that shared a ship-to contact email. Review caught it, and the v6 matcher restricted the edge to owner emails (2026-06-23).
- **Hard cannot-link invariants.** After the matcher was fixed, downstream stages re-merged 161 of the 395 accounts it had correctly split, traced to three causes: a missing owner-email gate in adjudication, surname cohesion judged on all contacts instead of the owner, and a flag that disabled split protection. The fix added a name-normalization comparator plus cannot-link invariants that no downstream stage may override (2026-06-25).
- **Structural split guard.** Any cluster holding two or more verified owner emails across two or more surnames is split automatically, a belt-and-suspenders backstop against the same class of over-merge (ADR-040).
- **Truth and serving separated.** Typesense is rebuilt nightly as a read index while Postgres stays authoritative, so a search-layer rebuild does not mutate identity state.

## Outcome

Before the engine, exact-match dedup could not collapse these duplicate accounts, fragmenting each customer's view across internal systems. The certified build (2026-06-22) collapsed roughly 43,000 accounts into ~27,900 persons at a measured 0.48% false-merge rate, with 88.8% of persons definitively known. As the underlying contact mirror grew, later rebuilds kept pace: a rebuild verified on 2026-07-09 produced ~29,500 persons across ~8,200 clusters (~24,800 cluster members, ~1,300 hierarchy accounts), and the spine stood at ~30,000 persons as of August 2026. Because false merges are the expensive error, the two-tier defense of owner-scoped edges plus non-overridable cannot-link invariants is the load-bearing result: the over-merge that review caught once is now caught automatically by both the matcher and an independent structural guard.

## Limitations

Automatic nightly rebuilds are deliberately gated off. The rebuild worker runs on a dedicated worker VPS, but an unguarded nightly run could delete legitimate whole-person records from the live spine before the dealer and staff exclusion flags are complete, so the spine refreshes only through reviewed manual runs until those flags land. The current matcher is provisional by design, and the pluggable seam exists precisely because portal-verified accounts are the intended authoritative replacement.

See also: [ADR-039: Pluggable identity resolver seam](../decisions/039-pluggable-identity-resolver-seam.md), [ADR-040: Conservative merge and cannot-link invariants](../decisions/040-conservative-merge-cannot-link.md).