# Testing & Correctness

Nexus has no traditional test suite -- no pytest, no Jest, no CI pipeline running unit tests on every commit. This is a deliberate trade-off, not an oversight.

## Why

The system's primary risk is not logic bugs in isolated functions. It is silent failures in external APIs: the ERP accepting a price write but not persisting it, the tax engine renaming a CSV column between exports, a PM tool webhook arriving out of order, an HTTP session expiring mid-scrape. These failures are invisible to unit tests because a mock of the external system, by definition, doesn't reproduce the external system's bugs.

The correctness mechanisms are designed around the actual failure modes of a solo-developer integration platform: runtime verification at the boundaries, automatic halting when things go wrong, and audit trails that make failures visible after the fact.

## What Exists Instead

### 1. Verify-on-write

Every price change pushed to the ERP is immediately read back and compared within $0.01. The three-state queue (queued, applied, verified) means "applied" is not "done" -- only "verified" means the price actually persisted. Mismatches are flagged for operator review, not silently logged. The pattern has caught the ERP silently rejecting edits that returned HTTP 200.

See: [Pricing case study](case-studies/pricing-automation.md), [Verify-on-write demo](examples/verify_on_write.py)

### 2. Pre-deployment security audits

Every production deploy runs five parallel review agents covering API security, data path integrity, frontend XSS, secrets hygiene, and accessibility. Findings are triaged by severity -- CRITICAL blocks the deploy, HIGH must be fixed or explicitly excepted, MEDIUM is logged for follow-up. Every deploy produces an archived audit report.

See: [ADR-021](decisions/021-pre-deployment-security-audit-pattern.md)

### 3. Circuit breakers

Every background heartbeat maintains a consecutive-error counter. After 10 failures, the service disables itself via a file-backed flag visible across all workers. The flag survives process restarts. A misbehaving service stops hammering a broken external API automatically, and stays stopped until explicitly re-enabled.

See: [ADR-005](decisions/005-circuit-breakers-on-external-apis.md)

### 4. Idempotent schema migrations

Every service runs its own inline DDL at startup, guarded by `IF NOT EXISTS`. Re-running a migration is a no-op. There is no separate migration tool -- every service manages its own schema evolution, version-controlled by the code that uses those tables. A PostgreSQL advisory lock ensures only one Gunicorn worker runs the DDL batch.

See: [ADR-019](decisions/019-idempotent-schema-migrations.md)

### 5. Cross-cutting audit trail

`sync_changelog` captures every field-level change from every service -- pricing, orders, inventory, QC, email, heartbeats. One `SELECT` can reconstruct a chronological event timeline across the entire system. Post-hoc verification (did the nightly refresh actually update those 47 products?) is a query, not a test run.

See: [ADR-020](decisions/020-sync-changelog-as-cross-cutting-activity-feed.md)

## The Trade-off

A test suite would catch regressions in internal logic. The mechanisms above catch failures at system boundaries where the actual risk lives. Both approaches have blind spots. Given the constraint of a solo developer maintaining roughly 260 service modules against 15 external integrations, the investment went into runtime correctness rather than offline test coverage.
