# Preview-Then-Confirm Pattern with Read-Back Verification for Write Tools

**Status:** Accepted | **Date:** 2026-06-10 | **Theme:** reliability

## Context

Write-capable agent tools act on an ERP whose write path can silently reject an edit, returning a success response while the underlying value stays unchanged. That behavior was learned from the pricing system, where a response code alone proved to be an unreliable signal that a change had landed. Automated writes therefore need both a human consent step and independent confirmation that the value actually changed.

## Decision

Every write-capable tool follows one pattern. The first call returns a preview of the intended change plus a confirmation token; a second call carrying that token performs the write. Success is declared only when a post-write read-back returns exactly the intended value. Destructive operations are held to test accounts behind an explicit force gate.

## Alternatives Considered

Single-call writes that trust the response code did not fit this context because the ERP's write path can silently no-op, so a returned success does not confirm the change is durable. That is the precise failure the read-back exists to catch. Human-only writes with no automation did not fit either: the preview-then-confirm step already keeps a person in the loop by requiring an explicit token before anything executes, so removing automation would surrender throughput without adding control the pattern does not already provide.

## Consequences

Writes cost two calls plus the latency of a read-back query, which makes the write path slower than a fire-and-forget call. In exchange, every write leaves a verifiable trail through its preview, its token, and its confirming read-back, so an operator can reconstruct what a tool intended and what it verified. Destructive actions remain restricted to test accounts, with the force gate as the explicit authorization required before they execute, keeping high-risk operations out of production. The pattern is the standing blueprint for new write tools, so future tools inherit the same guarantees without redesign.