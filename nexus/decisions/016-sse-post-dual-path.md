# ADR-016: SSE + POST Dual-Path with Fallback Signal

## Context

Pricing operations in Nexus are long-running. An apply or revert across the full [product catalog](../case-studies/pricing-automation.md) takes minutes. Two interaction modes are valuable: real-time progress (the operator wants to see per-option status as the operation runs) and graceful degradation (if the real-time path fails, the operation should still complete without requiring a restart).

The original implementation had two independent paths -- an SSE endpoint that streamed events, and a POST endpoint that returned a final result. They shared the same underlying apply/revert logic but didn't share anything about failure recovery. When the SSE path died, the UI had no guidance on what to do next.

A March 2026 incident exposed the gap. The SSE apply stream hit connection pool exhaustion mid-operation. The UI saw the stream error, unlocked the button, and let the operator click again before the first operation had finished. The SSE path was failing because it holds a database connection open for the duration of the stream (generators outlive the Flask request context). The right answer wasn't "don't use SSE" -- it was "when SSE fails, switch to POST cleanly."

## Decision

Every long-running pricing operation exists in two forms, and the SSE form knows how to signal the client to switch paths.

The backend uses `get_standalone_connection()` instead of `get_db()`. Flask's request-teardown hook fires when the view function returns, but an SSE generator continues yielding after that. The generator can't rely on the request-scoped connection pool because Flask will close it out from under the generator. When the standalone acquire fails with `PoolError`, the generator yields a structured error event with `retry_post: True`. The frontend reads this as "switch to the POST version" and automatically fires the blocking POST to the same operation. The operator sees no interruption.

The frontend uses a module-level `Set` of in-flight operations keyed by product UUID (a second click on the same product is ignored), listens for `retry_post: True` in SSE error events, and unlocks the UI only once -- at the very end of the POST fallback, not when the SSE stream errors.

`DB_POOL_MAX` was bumped from 5 to 8 at the same time. With 2 Gunicorn workers that is 16 total connections, within PgBouncer's configured limit. The pool bump raises the threshold at which SSE paths start failing, but is not sufficient on its own for a busy system.

## Alternatives Considered

- **Single SSE path with no POST fallback.** SSE has real-world failure modes: proxies that buffer, browsers that drop the connection on tab switch, pool exhaustion, intermediate firewalls that time out long-lived HTTP connections. A system without a fallback path requires the SSE path to be perfect.

- **Single POST path with polling for progress.** Polling misses per-option granularity. A 5-minute operation polled once per second is 300 extra requests; SSE is one. The per-option visibility matters for operator confidence during bulk runs.

- **WebSockets.** Traffic is one-directional (server to client only). WebSockets would add a layer and require proxy configuration for no directional benefit over SSE. SSE is just a generator yielding strings in Flask.

- **Write the fallback logic on the client but keep the server unaware.** The client would have to guess when to retry. The `retry_post: True` signal is an explicit contract -- the server knows when its own SSE path cannot continue and tells the client directly.

## Consequences

**Good:**
- Pool exhaustion degrades cleanly. The SSE path errors, the frontend switches to POST, the POST completes, the operation succeeds. Operator experience: slight pause, then resume.
- The pattern is portable to any long-running operation that benefits from progress streaming. `sales.html` and `price-increase.html` use it. The firmware flashing page on the connector side uses the same pattern.
- The March 2026 incident cannot repeat. The only place the UI unlocks is at the end of the fallback POST. Combined with the per-product operation lock from ADR-008, a double-click is impossible on both client and server.

**Bad / costs:**
- Every operation that wants this pattern has to exist in two forms. `apply_and_verify_stream()` and `apply_and_verify_post()` share the same inner logic but wrap it in different delivery models. The two wrappers need to stay in sync.
- SSE generators using standalone connections are harder to reason about than request-scoped connections. The code includes an explicit docstring explaining why the standalone path exists.
- The `retry_post: True` signal is in-band. A frontend that does not know about the signal would see `event: error` and assume the whole operation failed. Extending the contract later needs forward-compatibility care.
