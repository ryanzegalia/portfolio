# Pluggable Identity-Resolver Seam

**Status:** Accepted | **Date:** 2026-06-14 | **Theme:** architecture

## Context

Customer-facing account linking needs to unify records that belong to the same person across multiple sources. Pure fuzzy matching on email and phone is ambiguous in the common cases where a household shares one email or one phone number, so it cannot be trusted as the sole basis for merging customer-facing accounts. An authoritative source of identity, the customer portal, was designated to eventually own this decision, but it was not yet available when account linking became necessary.

## Decision

A resolver interface was introduced as a seam between identity resolution and every downstream consumer. A conservative provisional matcher sits behind that interface for now, and portal-authority can be swapped in later without downstream rework because consumers code against the seam rather than against the matcher itself.

## Alternatives Considered

- **Wait for the customer portal before doing any account linking.** This did not fit the context because it meant months of lost value while account unification stayed manual. The need for linked accounts was present well before the authoritative source was ready.
- **Hard-wire fuzzy matching directly into every downstream consumer.** This did not fit the context because it would force rework across all of those consumers once the authoritative source arrived, and it pushed the correctness risk of ambiguous matches into every call site at the same time, with no single place to tighten the rules.

## Consequences

Two-phase evolution becomes explicit and planned rather than accidental: a conservative interim matcher today, portal-authority later. Downstream consumers depend on a stable interface, so the matcher can be replaced or hardened without touching them. Interim matches are deliberately conservative, which means some true matches are deferred until the authoritative source lands, and callers see fewer speculative links in the meantime. The seam adds one layer of indirection to maintain, and it carries an assumption that portal-authority will in fact arrive; if that plan changed, the provisional matcher would need to grow into the permanent implementation behind the same interface. The related merge safety rules that govern what the matcher is allowed to join are covered in [ADR-040](040-conservative-merge-cannot-link.md).