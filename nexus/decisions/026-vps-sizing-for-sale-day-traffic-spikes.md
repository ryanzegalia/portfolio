# ADR-026: VPS Sizing and Swap for Sale-Day Traffic Spikes
## Context

Nexus runs on a small production VPS (2 vCPUs, 1.9GB RAM, no swap). For steady-state operation this is generous. Nexus is not a high-throughput service -- it is an internal operations platform with a few hundred operator requests per day, plus 9 background heartbeats making a handful of API calls per minute.

Sale-day traffic spikes revealed that the VPS configuration (single-threaded sync workers, no swap, default file descriptor limits) couldn't handle concurrent load when a long-running background task coincided with peak customer traffic.

## Decision

**Fix all four root causes in one hardening pass:**

1. **Add 2GB swap to the VPS.** A memory spike no longer causes an OOM kill -- the kernel swaps to disk, the process survives the spike, and the system degrades gracefully instead of failing. Swap is slow, but slow is better than dead.

2. **Switch Gunicorn from sync workers to `gthread` workers.** With sync workers, every incoming request occupies a full worker process until it completes. Two workers means two concurrent requests, and a 60-second slow request blocks one of them for 60 seconds. With `gthread` workers and 4 threads per worker, a slow request occupies one thread and the other three threads keep serving requests. Concurrency goes from 2 to 8 with no additional memory cost.

3. **Cap the tracking poll to process at most N shipments per cycle** rather than every active shipment in one burst. If the poll would take 60 seconds to process 200 shipments, it processes the first 100 in ~30 seconds, yields, and the next tick picks up where it left off. The slowest any one poll run can take is bounded.

4. **Raise nginx's `worker_rlimit_nofile` from 1024 to 4096.** The default file descriptor limit was too low for bursty traffic. A sale-day spike could exhaust descriptors and cause new connections to fail.

## Alternatives Considered

- **Scale up the VPS.** Going up a tier (4GB RAM, 3 vCPUs) would have made the specific failure mode less likely but would not have addressed the root causes. Memory spikes, file descriptor limits, and worker blocking would still exist -- just with more headroom. It would also cost 2x more for a system that does not need 2x the capacity at steady state. The hardening pass gets the same reliability improvement for ~$0/month additional cost.

- **Switch to async Flask.** Would fix the worker-blocking problem but requires rewriting every route and every service that uses a sync DB driver. Rejected as a months-long project to solve a problem the gthread workers handle cleanly.

- **Add auto-scaling.** The VPS provider does not offer built-in auto-scaling. Setting up a load balancer, multiple VPS instances, and shared session state would add significant operational complexity for a sale event that happens a few times a year.

- **Pre-warm the VPS before sale events.** Reboot Gunicorn, pre-fetch common queries into cache, manually scale up for the day. Doable but brittle -- every sale event becomes a manual operation, and the operator has to remember.

## Consequences

**Good:**
- The specific failure mode (slow poll + blocking workers + memory spike + FD limit) is structurally impossible under the new configuration. Every layer has more headroom.
- Swap is a cheap insurance policy. Memory spikes now degrade gracefully (swap I/O slowness) instead of catastrophically (OOM kill).
- `gthread` workers give 4x concurrency for free. The memory overhead is negligible (threads share process memory).
- The tracking poll cap means a single slow cycle cannot block the system indefinitely. The next cycle picks up the remaining work.

**Bad / costs:**
- `gthread` workers expose concurrency bugs that sync workers hide. Threaded execution means shared mutable state in the process can race. Nexus's services are mostly thread-safe (SQLAlchemy pool, Redis client, per-request DB connections), but any global state that was not thread-safe had to be audited.
- Swap I/O is slow. A system that is consistently swapping is a system that is slowly dying. Swap is insurance against spikes, not a normal operating state. Monitoring alerts when swap usage stays above a threshold for longer than an hour.
- Capping the tracking poll changes the latency characteristics of shipment updates. Some shipments may wait for the next cycle. Acceptable because the tiered polling design (ADR-018) already handles urgency -- urgent shipments are polled every 30 minutes regardless of the cap.
- The VPS is still a small box. Future scale increases may require actually resizing -- this hardening pass buys headroom, not indefinite headroom.
