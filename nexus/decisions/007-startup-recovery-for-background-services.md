# ADR-007: Startup Recovery for Background Services

## Context

Background heartbeats run on threading intervals. If a service is mid-run when the Gunicorn process restarts (deploy, crash, OS reboot), two things happen: the in-flight tick is lost, and the next scheduled tick doesn't fire until the normal interval rolls around -- which could be up to 24 hours later for nightly services.

For fast services (5-minute cadence), the freshness gap is tolerable. For slower ones (hourly vendor sync, nightly deal drift), a restart can create a multi-hour gap during which the system appears stale.

A secondary driver: two Gunicorn workers booting concurrently would fight over startup DDL execution, sometimes crashing with `pg_type_typname_nsp_index` errors. The startup recovery thread is the natural place to coordinate that dance -- one worker runs the maintenance and recovery batch, the other skips.

## Decision

A dedicated startup recovery daemon thread runs once on server boot. Twenty seconds after startup (giving Flask and the connection pool time to initialize), `startup_recovery.py` wakes, reads `api_health_log` for the last 2 hours, and identifies services that failed or stopped mid-run. For each, it calls `force_run()` in dependency order: `product_stamp -> inventory_heartbeat -> vendor_sync`. Products must sync before inventory (inventory references SKU IDs), inventory before vendor (vendor sync uses SKU IDs).

The recovery thread runs once at startup and exits. Regular heartbeats start their normal scheduled loops independently.

A PostgreSQL advisory lock (`pg_try_advisory_lock(43)`, non-blocking) is acquired at the top of the recovery flow. The first worker to boot gets the lock and runs the full recovery batch. The second worker tries the lock, can't get it, and skips recovery entirely. Both workers then proceed to serve requests and run heartbeats. No races.

## Alternatives Considered

- **Do nothing on startup.** The system would recover on its own within one heartbeat interval. Acceptable for 5-minute services, not acceptable for nightly services (24-hour gap) or for services that were mid-pipeline when interrupted.

- **Persist heartbeat state to disk and resume exactly where interrupted.** Over-engineering. The checkpoint-based delta sync already handles "resume from last successful record" at the data level -- the recovery thread just needs to trigger a run, not reconstruct half-finished operations.

- **Use a job queue (Celery, RQ).** Would support durable job state across restarts. Rejected as process-weight overkill -- Nexus's heartbeats are light enough that a threaded loop with startup recovery is sufficient.

- **Blocking advisory lock (`pg_advisory_lock(43)`).** Both workers would run the recovery batch sequentially instead of one skipping. Rejected because redundant DDL and recovery on every restart is wasted work -- the non-blocking skip pattern gets the second worker serving requests faster.

## Consequences

A Gunicorn restart creates no visible data gap for the operator. The dashboard shows the same "last ran at" timestamp as before the restart, and within 20 seconds of startup the services that were mid-run are resuming.

The advisory lock makes concurrent worker boot safe. Before the lock, the two workers would fight over DDL execution and sometimes crash. After the lock, they cooperate cleanly.

The per-service try/except inside the recovery flow means one service failing to recover doesn't block others. Recovery continues down the dependency list and logs the failure for investigation.

The 20-second startup delay is a magic number tuned to give Flask time to finish bootstrapping. If startup ever grows more complex, this may need adjustment.

The dependency order is hardcoded. There's no declarative graph -- if a new service gets added between existing ones, someone has to know where to insert it.

Circuit-broken services are NOT auto-recovered on startup. If a service tripped its circuit breaker, it stays disabled until an operator re-enables it. The recovery thread respects that state.