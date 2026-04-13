# ADR-027: PostgreSQL Backup Gap Discovered Post-Migration
## Context

The PostgreSQL migration (ADR-002) revealed a gap in the backup pipeline: the nightly backup scripts were still targeting the old SQLite files. The migration plan focused on "get the application running on PostgreSQL" but did not explicitly verify that operational scripts (backups, monitoring, deploy procedures) were updated to point at the new database engine.

The gap was caught during a routine operational check and fixed the same day. No data was lost, but the incident exposed a broader pattern: **migrations have a blast radius beyond the code being migrated.** Operational scripts, cron jobs, and monitoring all touch the same resources and all need to be audited when the underlying system changes.

## Decision

**Add a "verify backup infrastructure after any database engine change" step as a first-class item on every future migration plan.** And fix the immediate gap with a `pg_dump`-based backup script.

The immediate fix:
- New `backup-pg.sh` using `pg_dump` with compression
- Runs nightly via cron, retaining 14 days of snapshots in a separate directory on the VPS
- Deploy snapshot script updated to capture a PostgreSQL snapshot at deploy time, so rolling back to "the state at deploy" remains possible

The process fix -- the actual ADR:
- Every migration plan from here forward includes a **"Verify operational infrastructure"** section explicitly listing: backup scripts, monitoring scripts, log rotation, deploy scripts, any cron job that touches the database. Each item gets checked against the new database engine, path, and credentials.
- Post-migration smoke test includes "run the backup script end-to-end and verify the output file contains real data."

Discovery led to same-day implementation of automated PostgreSQL backup infrastructure. The 14-day retention window was in place within hours of the gap being identified.

## Alternatives Considered

- **Just fix the backup script and move on.** Would fix the immediate problem but would not prevent the next one. Migrations do not happen often, but when they do they are high-risk -- the process change is worth more than the one-time fix.

- **Use a managed PostgreSQL with built-in backups** (RDS, Supabase, Neon, Render Managed Postgres). Would have made the gap impossible because backups would have been the vendor's responsibility. Rejected because self-hosted PostgreSQL on the same VPS as the app is simpler, cheaper, and has lower latency (Unix socket vs. TCP to an external host). The tradeoff is that operational responsibilities are self-owned.

- **Rely on VPS-level snapshots from Hetzner.** Hetzner offers snapshots, but they are not automated and they capture the whole VM state, not just the database. For disaster recovery they are useful, but for "I need to restore a single table to yesterday's state" they are the wrong tool.

## Consequences

**Good:**
- The immediate gap closed within the same day as discovery. 14-day retention on `pg_dump` snapshots.
- Every migration plan from this point forward has a process-level reminder to verify operational infrastructure. The same class of bug is much harder to repeat.
- The specific decision about "self-hosted vs managed" is revisited with full knowledge of the cost. Self-hosted is still the right call for Nexus's scale and constraints, but the cost of self-hosting (responsibility for backups, monitoring, OS patches) is now visible rather than implicit.

**Bad / costs:**
- No automated alert caught the gap when it existed. A better system would have had a "backups have not run against live data in N days" monitor that would have alerted on day 1.
- `pg_dump` is not a replacement for point-in-time recovery (PITR). If the VPS crashed between nightly snapshots, up to ~24 hours of data could be lost. Acceptable for current recovery point objectives, but worth naming as a known limitation.
- Adding "verify operational infrastructure" as a process step depends on the operator reading and following the process. On a small team, this is a discipline item -- there may not be a reviewer catching missed checklist items.

The broader lesson: migration plans should audit the full blast radius -- operational scripts, monitoring, and deploy procedures -- not just the application code.
