# ADR-014: Redis for Cross-Worker Shared State (Not Flask Sessions)

## Context

Nexus runs multiple Gunicorn workers. State that needs to be shared across workers -- rate limit counters, the ERP license seat session, cache entries that should be consistent across requests -- cannot live in per-worker memory. Two workers would drift and the dashboard would show inconsistent state depending on which worker handled the request.

The standard Flask answer is "use Redis for sessions, use Flask-Session." But Flask sessions in Nexus are cookie-backed, stored server-side in the `auth_sessions` Postgres table. Redis is not used for authentication.

What Redis IS used for:

1. **Rate limit counters** (Flask-Limiter uses Redis as its storage backend). 596 routes with various rate limits -- the counters have to be consistent across workers or a user could burst past the limit by hitting different workers.
2. **The ERP license seat session sharing.** The auth service maintains a single authenticated session against the ERP's office backend (RSA-encrypted login, cookie-based). Each the ERP login consumes a license seat. Having every worker log in independently would consume all available seats. Redis holds the current valid session cookies so every worker can reuse them.
3. **Occasional small cache entries** for cross-worker consistency.

## Decision

**Use Redis only for cross-worker shared state. Do not use it for sessions. Graceful fallback when Redis is unavailable.**

`redis_service.py` wraps all Redis operations in try/except and degrades silently if Redis is not running. Rate limiting falls back to in-memory per-worker counters (less accurate but functional). The ERP session sharing falls back to per-worker login (consumes more seats but works).

Redis is optional -- the system boots and runs without it. Degraded mode is documented, tested, and monitored.

## Alternatives Considered

- **Flask-Session with Redis.** Would add Redis to the session path. Rejected because Postgres-backed sessions (via `auth_sessions` table) are simpler, give stronger durability (sessions survive Redis outages), and do not add a Redis dependency to the authentication path. Redis can be down and users stay logged in.

- **Memcached instead of Redis.** Memcached does not support the data structures Flask-Limiter uses for sliding window counters. Redis does. Not a meaningful choice at this scale.

- **Database-backed rate limiting.** Would work without Redis. Rejected as too slow for hot-path request counting -- every rate-limit check becomes a DB query. Redis is approximately 100x faster for this specific workload.

- **Per-worker rate limits** (no cross-worker consistency). Tried as the initial implementation. Gave a user 2x their rate limit because they could hit both workers. Acceptable for coarse limits, not acceptable for tight ones.

## Consequences

**Good:**
- Rate limits are cross-worker consistent. A user hitting a rate-limited endpoint cannot burst past the limit by ping-ponging between workers.
- the ERP license seats are preserved. Instead of 2 workers burning 2 seats independently, one seat is shared via Redis.
- Redis is optional. The system boots without it, runs in degraded mode, and the operator sees a warning in the system health page. No crash, no 500s.
- Keeping Redis's scope narrow (3 use cases, all documented) means Redis never becomes a critical path. The auth path does not touch it. The database path does not touch it.

**Bad / costs:**
- A Redis outage reduces rate limit accuracy. In degraded mode, a user hitting the limit on worker A and then worker B gets 2x the intended rate. Acceptable for a short outage; not acceptable long-term.
- Redis is another moving piece. More to monitor, more to back up, more to fail. Keeping its scope narrow minimizes this cost.
- the ERP session sharing via Redis has a race condition window: if two workers both see "session is expired" at the same moment, both will re-login and consume a seat each. Mitigated with a lock around the re-login path but the window is not zero.
