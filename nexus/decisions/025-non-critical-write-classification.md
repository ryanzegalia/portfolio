# ADR-025: Non-Critical Write Classification
## Context

Every page view on the Nexus dashboard fires a `pageview` analytics write. Every interaction fires a `user_activity` row. Every feedback submission writes to `feedback` with attached diagnostic context. These writes are useful -- they drive the analytics dashboard, power the system health view, and provide debugging context. But they are not critical to the user-facing operation.

Under SQLite's single-writer model, non-essential writes (analytics, activity tracking) could block user-facing requests during long-running operations. The classification prevents low-priority writes from degrading user experience.

The principle survived the PostgreSQL migration because PostgreSQL's MVCC removed the specific lock-contention failure mode, but it still applies: some writes should not be allowed to degrade user experience under any circumstance.

## Decision

**Classify every write into one of three tiers based on criticality:**

| Tier | Behavior on failure | Examples |
|---|---|---|
| **Critical** | Request fails. User sees an error. Transaction rolls back. | Order creation, price changes, QC test results, tax reconciliation records |
| **Important** | Request succeeds but logs a warning. Write is retried out-of-band. | Sync changelog entries, deal snapshots |
| **Non-critical** | Request succeeds silently. Failure is logged but never retried. | Activity tracking, pageview analytics, dashboard health pings |

**Non-critical writes are wrapped in a dedicated `try/except/pass` with a 100ms timeout.** If the write takes longer than 100ms or fails for any reason, the exception is swallowed, a log line is written, and the request continues. The user never waits on a non-critical write.

The distinction is encoded at the write site, not via a global policy. Every developer writing a new logging or tracking call makes a conscious decision about the tier. There is no "default" tier because every tier has a different failure mode.

## Alternatives Considered

- **Queue non-critical writes to a background thread.** Was the initial instinct. Rejected because adding a queue introduces its own failure modes (queue drainage, queue persistence on restart) without eliminating the root problem (someone forgetting to use the queue). The inline `try/except/pass` pattern is simpler and harder to forget.

- **Use a separate database for non-critical writes.** Rejected as over-engineering. The PostgreSQL MVCC model means reads and writes never block each other, so non-critical writes no longer have the contention problem they had under SQLite. The classification still matters for timeout and retry semantics, but does not need physical separation.

- **Always block on every write.** This was the original implementation and is what caused the 30-second hangs during the SQLite era. Explicitly rejected.

- **Add a rate limit to non-critical writes.** Would reduce volume but does not address the fundamental issue -- the 1% of writes that are slow should not block the user regardless of how many there are.

## Consequences

**Good:**
- User requests do not wait on activity tracking. The 30-second-hang failure mode from the SQLite era is structurally prevented even if activity tracking gets slow again.
- New developers (or Claude Code sessions) have a clear mental model for "should this block the user?" -- three tiers, explicit at the write site.
- Failures in non-critical writes are still visible. They are logged, they show up in `api_health_log`, the operator can investigate if the failure rate spikes. Silent failure is not silent at the monitoring level.
- Activity analytics are honest about their failure rate. If 0.5% of pageviews fail to log, the dashboard shows 0.5% lower numbers rather than 0.5% of users seeing error pages.

**Bad / costs:**
- Activity analytics have a small blind spot. Failed writes are lost permanently -- no retry, no queue. For the use cases this classification applies to (dashboards, debugging context), the loss is acceptable.
- Developers have to remember the classification at every write site. Easy to get wrong by accident (defaulting to "critical" for a logging call that should be non-critical). Mitigated by code review and by explicit naming (non-critical helpers are named `log_*_async` or `track_*`, not `insert_*`).
- The 100ms timeout is a judgment call. Too short and transient slow writes get classified as failures; too long and slow writes still degrade user experience. 100ms has worked in practice but is not a principled number.
