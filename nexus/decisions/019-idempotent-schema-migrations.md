# ADR-019: Idempotent Schema Migrations With `ADD COLUMN IF NOT EXISTS`
## Context

At the time of this decision, Nexus had 145 tables across 58 services (the schema has roughly doubled since; see [METRICS.md](../METRICS.md)). Each service owns its own tables and runs its own inline `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS` at startup. No separate migration tool, no versioned migration files, no "run this command before deploying." The code that uses a table is also the code that creates and evolves it.

This worked until 2026-03-10, when two Gunicorn workers both ran `_run_startup_maintenance()` simultaneously and PostgreSQL threw a `pg_type_typname_nsp_index` duplicate key error because both workers were racing to create the same table. Root cause: PostgreSQL's `CREATE TABLE IF NOT EXISTS` is not fully concurrency-safe -- it can throw duplicate key errors when two connections race to create the same table. A second problem compounded it: migration failures were hard to diagnose because error handling was too coarse-grained.

## Decision

**Three layers, all in place today:**

1. **Idempotent DDL by construction.** Every `CREATE TABLE` uses `IF NOT EXISTS`. Every `ALTER TABLE` column addition uses `ADD COLUMN IF NOT EXISTS` guarded by a `try/except psycopg2.OperationalError` catch. Every index uses `CREATE INDEX IF NOT EXISTS`. The failure mode for re-running a migration that already applied is a no-op -- by design.

2. **PostgreSQL advisory lock** at the top of the startup maintenance routine. `pg_try_advisory_lock(43)` -- non-blocking. The first worker gets the lock and runs the full migration batch. The second worker sees the lock is taken, skips the batch entirely, and starts serving requests. No races, no duplicate work.

3. **Per-migration `try/except`** instead of one giant catch. A failure in `review_sessions` creation does not skip every subsequent migration. Each service's migration block is its own sub-function; failures are logged and the next block runs.

## Alternatives Considered

- **Introduce Alembic.** Rejected because every service owns its own tables and the codebase is designed around that ownership. Centralizing migrations in one tool would force tables that logically belong to `tax_recon_service.py` to live in a global migration directory, separating table ownership from service ownership. The cognitive cost outweighs the tool benefit.

- **One big startup migration file.** Was the original implementation. Was the thing that broke.

- **Run migrations as a separate deploy step** (`python manage.py migrate` before starting Gunicorn). Rejected because it introduces a deployment ordering constraint that is easy to forget. Running migrations inline at worker startup means "deploy = restart gunicorn" -- one command, no ordering to remember. The advisory lock makes this safe.

- **Blocking advisory lock** (`pg_advisory_lock` instead of `pg_try_advisory_lock`). The blocking version would make the second worker wait for the first to finish, then run the same migrations redundantly. Non-blocking plus skip is cheaper -- the second worker starts serving requests faster.

## Consequences

**Good:**
- Schema evolution is decentralized. A service owner adds a column, wraps it in the standard `try/except` pattern, and ships it. No coordination with a migration tool, no version bumps, no merge conflicts on a migrations directory.
- Deploy is idempotent by construction. Deploying the same version twice does nothing different from deploying it once.
- The advisory lock makes it safe to restart workers anywhere. If the DDL is new, the first worker to boot runs it. If it is already applied, `IF NOT EXISTS` turns the rerun into a no-op.
- Per-migration `try/except` means one service's bad migration does not block every other service's migration from running.
- New services cost zero integration effort. They inherit the pattern by convention.

**Bad / costs:**
- No version number on schema state. Rolling back to a prior schema version is not a one-command operation. In practice, forward fixes have always been cheaper than backward, but the option is not there.
- Schema reference files (`postgres_schema.sql`, `postgres_schema_full.sql`) are hand-maintained and can lag the actual inline DDL. The pre-deployment security audit catches this drift periodically, but the gap is a known cost.
- Errors in inline DDL fail silently under the `try/except`. A typo in a column definition could apply partially and go unnoticed until a query using the missing column runs. Mitigated by the dashboard health page logging DDL errors.
- The advisory lock uses a fixed integer (`43` in the current code). If a future service picks the same number for its own lock, they would conflict. Not an issue at current scale but worth knowing.
