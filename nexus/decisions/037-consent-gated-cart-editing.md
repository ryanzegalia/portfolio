# Consent-Gated, Browser-Executed Cart Editing

**Status:** Accepted | **Date:** 2026-06-14 | **Theme:** security

## Context

Support reps sometimes need to modify a shopper's active cart on the shopper's behalf. Doing so raises the question of whose credentials execute the change, and handling customer session tokens on the server would put a trust and privilege boundary inside a support tool that should not own it. The design goal is to let a rep help without the platform ever acting as the customer.

## Decision

Reps stage cart actions server-side, and the shopper's own browser polls for the staged change, previews it, and executes it through the storefront's native cart mechanism only after a one-tap approval. The platform does not hold or replay customer session tokens; the customer's authenticated session performs the write.

## Alternatives Considered

Server-side session injection would let the platform hold and replay the customer's session token to apply the change directly. It did not fit this context because it would place customer session tokens in the platform's custody, widening exactly the privilege-escalation and trust surface the design set out to keep out of scope.

A browser extension or embedded remote-control agent would let a rep apply changes directly in the shopper's session. It did not fit because it adds install friction for the shopper before any help can happen, and it enlarges the attack surface relative to a single consent-gated action.

## Consequences

Rep-initiated changes are not instant; they surface on the next poll and then wait on approval, which is the accepted cost of keeping the customer in the loop. A consent modal is a mandatory step in the flow rather than an optional confirmation, so the UX carries one required tap. In exchange, the security boundary is explicit and auditable: every change is executed by the customer's own session after visible approval, and the platform holds no replayable credential. The pattern was reviewed across five security dimensions and cleared that gate before rollout.