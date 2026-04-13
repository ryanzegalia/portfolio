# ADR-002: PostgreSQL Migration with sqlite3-Compatible Shim

## Context

Nexus originally ran on SQLite with WAL mode enabled and `fcntl.flock` wrapped around writes for multi-worker safety. As the database grew past 130 tables and write concurrency climbed under Gunicorn, SQLite's single-writer model started causing observable harm -- 30-second request hangs, backfill jobs blocking every page load.

From the pre-migration investigation:

> "Root cause: SQLite only allows one writer at a time. The backfill holds an open write transaction for the entire run (minutes). Every page load triggers an activity tracking write which hits the lock and waits the full `busy_timeout=30000` (30 seconds) before failing. This is what the user feels -- 30-second hangs."

The system had ~200 `conn.execute(sql, params)` call sites scattered across 58 services. Rewriting every one of them -- for a migration that needed to be low-risk and reversible -- was not on the table.

## Decision

Migrate from SQLite (WAL + flock) to **PostgreSQL** behind a `ThreadedConnectionPool`, with an external **PgBouncer** layer for cross-worker pooling. Access through a custom **`PgConnection` wrapper class** (`api/utils/db.py`) that presents the exact same API surface as sqlite3 -- `execute()`, `executemany()`, `executescript()`, `cursor()`, `commit()`, `rollback()`, `close()` -- backed internally by `psycopg2.extras.RealDictCursor`.

The test configuration uses a PostgreSQL connection string pointing to the application database.

The wrapper's `close()` method is a returns the connection to the pool instead of actually closing it. That's why the migration touched only ~60 files of callsite cleanups (parameter marker `?` -> `%s`, `INSERT OR REPLACE` -> `INSERT ... ON CONFLICT`, `lastrowid` handling), not ~200.

From the migration plan:

> "Choice: psycopg2-binary with a sqlite3-compatible wrapper class. Rationale: The codebase uses `conn.execute(sql, params)` directly on the connection object (sqlite3 shorthand). psycopg2 requires `conn.cursor().execute()`. Rather than touching every call site, we implement a `PgConnection` wrapper that presents the same `.execute()` / `.executescript()` / `.commit()` / `.cursor()` / `.close()` API as sqlite3, while internally using a psycopg2 `RealDictCursor`. The `close()` method returns the connection to the pool rather than closing it."

## Alternatives Considered

- **SQLAlchemy or any ORM.** Rejected explicitly: raw SQL is idiomatic throughout this codebase, and adding an ORM layer mid-migration would have been more work than the migration itself. The codebase had two years of invested muscle memory in raw SQL.

- **Rewrite every callsite to use psycopg2-style `cursor().execute()`.** Rejected on risk. 200+ sites, each an opportunity for a subtle bug, all in a codebase shipped to production weekly. The shim localizes risk to one file (`api/utils/db.py`) that can be reasoned about as a unit.

- **Stay on SQLite and throw more pragmas at it.** The investigation explored batching writes through HTTP endpoints as a workaround. It would have worked for the immediate symptom but didn't address the structural ceiling -- SQLite's single-writer model was going to keep hurting as concurrency grew.

- **Managed Postgres (RDS, Supabase, Neon).** A VPS was already running; self-hosting Postgres on the same box kept latency low (unix socket), operational surface small, and cost at zero.

## Consequences

**Good:**
- 30-second hangs eliminated on day one. Backfills no longer block user requests.
- Connection pooling (app-level `ThreadedConnectionPool` + PgBouncer) gives cross-worker reuse that WAL-SQLite couldn't.
- PostgreSQL's MVCC means readers never block writers and vice versa -- the whole class of lock-contention incidents is gone.
- 132 tables migrated on day one. 67 files modified, 6,488 insertions. The shim held.
- The migration was reversible at any step: the SQLite files stayed on disk, the two paths could have run in parallel if anything broke.

**Bad / costs:**
- The shim adds one level of indirection on every DB call. Performance cost is negligible (psycopg2 is fast) but the code reads slightly less like "standard psycopg2" and more like "sqlite3 code that happens to work."
- The `PgConnection.close()` semantics are non-obvious: calling `close()` returns the connection to the pool instead of actually closing it. Anyone reading the code for the first time has to understand the wrapper. The docstring explicitly documents this.
- `executescript()` doesn't auto-commit the way SQLite's does. The shim implements it by splitting on semicolons and executing each statement -- a reasonable approximation but not byte-identical to the original semantics.
- The connector subsystem is NOT migrated: it still uses SQLite for local-to-device storage, which has different operational constraints. It stays as-is.
- Pre-existing backup scripts still pointed at the SQLite files for ~10 days after the migration, creating a backup gap. Caught during a separate post-migration audit -- see ADR-023.