# Compatibility Derived from Interface Definitions, Not Manual Tables

**Status:** Accepted | **Date:** 2026-06-24 | **Theme:** data-model

## Context

Product compatibility, the "works with" relationships between products, was maintained as hand-curated pairs. That model scales quadratically: every new product can relate to every existing one, and the review queue carried a standing backlog of 519 pairs awaiting confirmation. Manual pair curation also goes stale silently, since a missing edge looks the same as a deliberate incompatibility.

## Decision

Compatibility is derived from connector-interface definitions declared on each product rather than from hand-entered pairs. A product declares its connector interfaces, and fitment edges are computed from those declarations. A pilot on an isolated staging clone generated 824 fitment edges from 36 seeded interface rows. Ownership also moved from the content-review queue into product setup: because fitment now derives from structural interface data, that data is owner-locked so a single change cannot silently alter edges across many products, while editorial prose stays reviewer-owned where the review workflow already lives.

## Alternatives Considered

Keeping manual pair curation did not fit this context because the quadratic maintenance and the standing backlog it produced were the problem being solved, and its silent staleness makes coverage gaps invisible. Inferring compatibility from co-purchase or behavioral data did not fit either: those signals are correlational and produce plausible-but-wrong fitment, recommending combinations that sell together but do not physically connect. Interface declarations are ground truth for whether two products fit, so derivation runs from that data rather than from statistics.

## Consequences

In the isolated staging-clone pilot, adding one product with declared interfaces yielded its full fitment set automatically (824 edges from 36 seeded rows); rolled out, this removes the need for a curator to enter each new pair by hand. Derived edges still pass an adversarial verification stage before publish: an earlier rule-based pass raised coverage from 57% to 99.6%, and verification caught 19 incorrect edges before they could reach recommendations. The main new burden is governance of the interface vocabulary itself, which becomes schema: interface names have to be defined and maintained carefully, because every product's fitment now depends on them. The verification gate remains between derivation and publish so that a bad interface definition surfaces as caught edges rather than wrong customer-facing recommendations.