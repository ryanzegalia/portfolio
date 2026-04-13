# ADR-011: Three-State Price Queue (queued -> applied -> verified)

## Context

the ERP is an external system. When Nexus changes a product's price, the change has to be pushed to the ERP's admin backend, and the result is only authoritative once the ERP confirms it. Three things can go wrong between "Nexus decided the new price" and "the ERP has the new price":

1. The push fails (network error, auth expired, the ERP returns 500).
2. The push appears to succeed but the change does not persist (known the ERP behavior -- silent rejection of some edits).
3. A concurrent write from another source overwrites the Nexus change between push and read-back.

Before this ADR, the pricing workflow had two separate audit trails: `price_changes` (granular, per-the ERP-push) and `price_history` (session summaries). They overlapped but did not cover the "did the push actually take" case cleanly.

The goal: wire all three pricing workflows (Price Adjustment, Price Increase Sessions, Sales) to the same apply+verify+audit path.

## Decision

**Model every price change as an entity in a three-state queue** with a session-level lifecycle wrapped around it.

Per-option states:
- `queued` -- Nexus has decided the new price. Not yet pushed to the ERP.
- `applied` -- Pushed to the ERP. Awaiting read-back verification.
- `verified` -- Read back from the ERP's live page and the value matches what Nexus pushed.

Session-level states:
- `draft` -- Planning phase. No options applied yet.
- `in_progress` -- At least one option has been applied/verified. Revert is allowed.
- `completed` -- All options across all products in the session are `verified`.
- `reverted` -- Operator explicitly rolled back the session.

The session status is computed, not stored independently -- `_sync_session_status()` reads the current states of every option in the session and derives the session state. Idempotent, can run after every option change, always consistent.

Every state transition writes to `sync_changelog`. Every push to the ERP writes to `price_history`. Every session state change is logged via `api_health_log`. The audit trail is complete at three granularities (per-option, per-push, per-session).

## Alternatives Considered

- **Two-state queue** (pending -> done). Rejected because it conflates "pushed" with "verified." A push that silently failed would look identical to a verified success -- exactly the failure mode the three-state model prevents.

- **Optimistic state -- assume push succeeded.** Rejected because Nexus has seen the ERP silent-rejection failure mode in production. Optimism here corrupts the local database's idea of what is live.

- **Store session state explicitly alongside computed option states.** Rejected because it introduces a consistency problem -- what if the stored session state disagrees with the computed state? Always computing from option states has exactly one source of truth.

- **More granular states** (queued, pushing, awaiting_verify, verified, retry, failed, reverted). Rejected as over-granular. Three states capture the meaningful transitions; more states add state-machine complexity without adding observability.

## Consequences

**Good:**
- The "did the push actually take" question has a clear answer at every moment. `applied` means "we tried, awaiting confirmation." `verified` means "confirmed live." The difference is visible in the UI.
- Session state is always derivable. If the derivation logic changes, old sessions automatically reflect the new derivation -- no migration needed.
- Revert semantics are clean. Reverting a session walks through every `verified` option and pushes the old price back. The option returns to `applied`, then `verified` as the revert is confirmed.
- The pattern works for three different user workflows: sale campaigns (bulk, session-scoped), price adjustments (single-product, ad hoc), and price increase sessions (bulk, structured). One pipeline, three entry points.

**Bad / costs:**
- Three states means more state transitions to handle in code. The `_sync_session_status()` helper hides most complexity but the transition logic is denser than a two-state model.
- Computing session status on every change is cheap for small sessions (10-50 options) but would scale linearly for very large sessions. Not a problem today; could become one.
- Reverts do not bring the session back to `draft` -- they go to `reverted`. "Start over" requires creating a new session rather than resetting an existing one.
