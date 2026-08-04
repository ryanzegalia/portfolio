# Production Write Safety
> Part of the Nexus production automation platform

The write path between every tool on the platform and any record it changes in a live business system.

## What it is

The ERP keeps no audit log of what changed it and offers no undo, and its staging environment points at the same live data as production, so there is no copy of the business to practise on. Every write any tool makes lands on the real records on the first attempt. This layer is the discipline that makes that survivable: preview-then-confirm on every mutating tool, read-back verification as the only success signal, one attempt with no automatic retry, and "unknown" as a first-class outcome.

The same contract governs writes regardless of who is driving -- an operator clicking a dashboard action or an AI agent calling an MCP tool.

## The contract

- **Two-call writes.** A mutating tool called without a confirmation token returns a preview of the exact change and a token; nothing moves until a second call comes back carrying that token. The confirmation is a separate, deliberate act, and the token is bound to the previewed target so it cannot be replayed against a different record. See [ADR-044](../decisions/044-preview-confirm-write-tools.md).
- **Read-back decides success.** Whether a write worked is decided by reading the record back out of the system of record and comparing it against what was intended. The HTTP response is a hint, not an answer -- the platform has caught the ERP returning success on writes it silently rejected.
- **One attempt, no automatic retry.** A lost response and a rejected write look identical from the caller's side, so re-sending on that ambiguity can execute the same money change twice. A write gets exactly one attempt; anything unresolved goes to a person.
- **Assert the invariant, not the literal.** Some fields the ERP advances on its own within minutes of a write -- an order's status among them -- so asserting the exact value just written would report a good write as drift. The read-back asserts the invariant the change was meant to produce; for a void, that the order is out of the shipping states.
- **Unknown is an outcome.** Worked, failed, and unknown are three different results. When the read-back cannot settle the question, the tool says so and stops, and a person checks by hand.

## Where it applies

- **The AI-agent tool layer.** Every mutating MCP tool follows the two-call contract, and the read side runs behind a dual-layer read-only SQL guard so a generated query cannot mutate data at all. See [ai-data-access.md](ai-data-access.md), the [MCP agent layer case study](../case-studies/mcp-agent-layer.md), and [ADR-043](../decisions/043-dual-layer-readonly-sql.md).
- **Pricing.** The three-state queue (queued, applied, verified) is this contract applied to bulk price changes -- "applied" is not "done", only "verified" is. See the [pricing automation case study](../case-studies/pricing-automation.md).
- **Write classification.** Not every write carries the same ceremony: [ADR-025](../decisions/025-non-critical-write-classification.md) separates the writes that demand it from the low-stakes ones that tolerate retry.
- **After the write lands.** The order desk extends the same idea in time -- recorded intent is re-diffed against the ERP on every later re-ingest, so a write that landed and then drifted is caught too. See [order-desk.md](order-desk.md).

## Integration Points

**Sits between:**
- Every dashboard action and MCP tool that mutates a business record
- The ERP's REST API and office backend, the payment rails, and the platform's own Relations Zone tables

**Produces:**
- Preview payloads and confirmation tokens (the two-call handshake)
- Read-back verdicts (worked / failed / unknown) surfaced to the caller
- Local BEFORE/AFTER records for the writes that support them, so a bad change can be reconstructed
