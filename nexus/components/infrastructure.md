# Infrastructure Services
> Part of the Nexus production automation platform

Six small services that are the platform plumbing for everything else.


## What it is

The foundational layer -- cache, Redis, S3, Cloudflare, startup recovery, service flags, API health logging. These services don't do anything visible to an operator on their own, but every other service depends on them.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/services/api_health_service.py` | 280 | Operation-level logging for external API calls. Tracks timing, outcome, trigger source, record counts for every heartbeat run. The canonical operational timeline. |
| `api/services/cache_service.py` | 142 | Application-level in-memory caching with TTL. Per-worker, not cross-worker. |
| `api/services/cloudflare_service.py` | 138 | Purges specific URLs from CF edge cache after data changes. Pre-mapped feed URLs for events, catalog, connector_update. Silent no-op if credentials missing. |
| `api/services/redis_service.py` | 159 | Shared Redis client for rate limiting and the ERP session sharing. Singleton pattern, graceful fallback when unavailable. |
| `api/services/s3_service.py` | 461 | Presigned PUT URLs for CS video uploads and sale image uploads. Brand -> bucket mapping hidden from client. PIL for image processing (WebP conversion). |
| `api/services/startup_recovery.py` | 100 | On server restart, checks `api_health_log` for recently failed services and triggers `force_run()` in dependency order. Daemon thread, runs 20s after startup. |
| `api/services/service_flags.py` | 46 | File-based cross-worker enable/disable flags. Visible across all gunicorn workers immediately. Used by the circuit breaker pattern. |

## Scale and verified numbers

- **Startup recovery window**: 2 hours (replays services that failed within the last 2 hours)
- **Startup recovery dependency order**: `product_stamp -> inventory_heartbeat -> vendor_sync`
- **Startup delay**: 20 seconds after server boot (lets Flask finish bootstrapping)
- **Redis fallback**: all Redis operations gracefully degrade to in-memory when Redis is unavailable
- **Cache TTLs from `config.py`**: catalog 5min, product 1min, options 1hr, public 10s (CF edge does real caching), warm 1hr, cold 24hr

## Key architectural decisions

- **[ADR-005: Circuit breakers on every external API call](../decisions/005-circuit-breakers-on-external-apis.md)** -- `service_flags.py` is the storage backend for circuit breaker state. File-based so it survives process restart and is visible to all workers atomically.
- **[ADR-007: Startup recovery for background services](../decisions/007-startup-recovery-for-background-services.md)** -- `startup_recovery.py` is the daemon that runs this logic.
- **[ADR-014: Redis for cross-worker shared state](../decisions/014-redis-for-cross-worker-shared-state.md)** -- `redis_service.py` is the singleton wrapper.
- **[ADR-020: sync_changelog as cross-cutting activity feed](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md)** -- `api_health_service.py` is the parallel operations log that pairs with sync_changelog.
- **Graceful degradation is the universal pattern.** Redis down? Fall back to in-memory. Cloudflare credentials missing? Silent no-op. S3 unreachable? Return a clear error but don't crash. Every infrastructure service is designed to fail soft.

## Inputs and outputs

Infrastructure services don't have meaningful "inputs and outputs" in the same sense as business services -- they're called from everywhere. The shape is:

**Called by:** Every heartbeat, every route, every background task.

**Depends on:** External services (Redis, Cloudflare, S3, file system), Python stdlib, `loguru`.

**Exposes:** `get_redis()`, `get_cache()`, `log_api_health()`, `purge_urls()`, `get_presigned_url()`, `is_service_disabled()`, `disable_service()`, `force_run()`.
