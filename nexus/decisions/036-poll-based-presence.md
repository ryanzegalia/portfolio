# Poll-Based Presence Over WebSockets

**Status:** Accepted | **Date:** 2026-06-14 | **Theme:** realtime

## Context

Presence tracking for a live dashboard needs to reflect who is currently viewing without adding real-time infrastructure that the workload does not justify. The consumers of the presence signal tolerate a few seconds of lag, so sub-second synchronization is not a requirement. The platform already runs a sync worker and a connection pool on a small VPS, and any new mechanism has to fit inside that existing footprint.

## Decision

Presence uses heartbeat polling on a 5 to 25 second interval rather than a persistent socket layer. At 1,000 concurrent visitors this is projected to produce roughly 40 to 80 requests per second at 5 to 8 percent CPU on the existing VPS, within headroom of the current sync worker and connection pool.

## Alternatives Considered

WebSockets would deliver lower latency but require a permanent async sidecar, Redis pub/sub for fan-out, and additional proxy configuration. That infrastructure cost did not fit a dashboard whose consumers already tolerate seconds of lag, so the marginal latency gain did not pay for the operational surface it would add. The trigger to revisit is explicit: concurrent load growing roughly tenfold, or sub-second sync becoming a real requirement.

Server-Sent Events would fit the read-mostly presence signal as a one-way channel, but each client still holds a worker connection open for the life of the stream. That does not sit well on a sync stack already managing a bounded connection pool, since the polling model releases the connection between beats instead of pinning one per viewer.

## Consequences

End-to-end update lag is bounded by the poll interval, on the order of 5 to 10 seconds, which the consuming views were designed to accept. Request traffic grows linearly with concurrency, a predictable curve consistent with the capacity estimate above. No new infrastructure is introduced, so there is no sidecar, message broker, or proxy path to operate or secure. A perceived-lag report on 2026-07-09 was investigated and root-caused to a page-lifecycle bug rather than the polling model, which kept the original sizing decision in place.
