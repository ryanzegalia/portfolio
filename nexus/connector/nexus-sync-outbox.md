# Nexus Sync -- Outbox Pattern Push to the Central API
> Part of the Nexus Connector subsystem

**Background sync service** (`nexus_sync.py`, ~200 lines) that implements the outbox pattern: test sessions captured on the customer PC are stored locally first, then pushed to the Nexus API on a 30-second cadence with exponential backoff, UUID-based deduplication, and offline resilience.

## The problem

the wireless line test results captured at a customer site must reach the central Nexus dashboard for reporting, audit, and quality analytics. But the connector may be offline in the field (rural location, bad internet, intentional offline mode). The server may be temporarily unreachable. A synchronous push after every test would block the test workflow; a lost push would lose data permanently.

Neither outcome is acceptable for a QA system where every recorded result is load-bearing.

## The pattern

**Outbox pattern.** Every test session gets a UUID at creation time, is written to the local SQLite (`test_records.db`) immediately, and is flagged as `synced = False`. A background thread polls the local store every 30 seconds for unsynced records and pushes them to `POST /api/v1/testing/ingest` on the Nexus API. On success, `synced = True` with timestamp. On failure, the record stays `synced = False` and gets retried on the next cycle.

The UUID is generated **locally at session creation**, not assigned by the server. This is the critical design choice -- the dedup key is client-owned, so retries are safe. The server upserts by UUID; a duplicate push creates no duplicate session.

## Exponential backoff

On transient failures (network error, 5xx response), the backoff grows: 30s -> 60s -> 120s -> 240s -> 480s, capping at 600s. After 10 retries without success, the record is flagged as `sync_error` with the last error message. An operator can inspect these via a local debug view.

**Permanent failures** (HTTP 400, 422) stop retrying immediately. If the server says the data is malformed, the record will never succeed -- retrying forever would just fill the log with noise. The permanent-failure classification prevents infinite retry loops.

## Authentication

Every connector instance has its own API key. The connector sends it as an `X-API-Key` header. The server stores only the SHA256 hash of the key -- same pattern as the main Nexus API (see [ADR-014: Redis for cross-worker shared state](../decisions/014-redis-for-cross-worker-shared-state.md)). Raw keys travel only in-memory and over TLS; the server never has the cleartext.

## Deduplication

The server uses the UUID (`sync_id` column) as a unique constraint. `INSERT ... ON CONFLICT DO UPDATE` means a duplicate push updates the existing record (with any newer fields) rather than creating a second row. The connector can retry as aggressively as it wants without creating audit noise.

## Request format

```
POST /api/v1/testing/ingest
X-API-Key: <raw_key>
User-Agent: the primary brand-Nexus-Connector/<version>
Content-Type: application/json

{
  "sync_id": "550e8400-e29b-41d4-a716-446655440000",
  "module_ble_address": "...",
  "session_start": "...",
  "session_end": "...",
  "results": [
    { "channel": 1, "status": "pass", ... },
    ...
  ]
}
```

## Local query interface

`GET /sync/status` on the connector's own API returns:
- `enabled`: whether the sync service is currently running
- `running`: whether a sync cycle is in progress
- `unsynced_count`: records waiting to push
- `total_synced`: cumulative count of successfully pushed records
- `total_errors`: cumulative error count
- `last_sync_at`: timestamp of the last successful push attempt
- `next_sync_at`: when the next cycle will run

Used by the connector's own debug view and by remote operators investigating sync lag.

## Configuration

Per-instance config in `%APPDATA%\the primary brand Nexus\settings.json`:

- `SYNC_INTERVAL` -- default 30 seconds
- `SYNC_MAX_RETRIES` -- default 10
- `SYNC_MAX_BACKOFF` -- default 600 seconds
- `SYNC_API_URL` -- the Nexus API base URL
- `SYNC_API_KEY` -- the raw API key for this instance

## Key decisions

- **Outbox over synchronous push.** Synchronous push would block the test workflow on network I/O and fail on any transient issue. The outbox pattern decouples the workflow from the network.
- **UUID at creation, not server-assigned.** Enables safe retries and idempotent server-side handling. If the server assigned IDs, a retry after a lost response would create a duplicate row.
- **Permanent vs transient failure distinction.** HTTP 400/422 means the data is wrong and will never succeed. Retrying forever is a bug. The classification bounds the retry loop.
- **SHA256-hashed API keys on the server.** Same pattern as the main Nexus API. Raw keys travel only over TLS.
- **Configurable via settings.json.** Field tuning without code changes. A slow customer site can increase `SYNC_INTERVAL` to reduce battery drain on laptops.

## Related decisions

- [ADR-014: Redis for cross-worker shared state](../decisions/014-redis-for-cross-worker-shared-state.md) -- same SHA256 key pattern.
- [ADR-005: Circuit breakers on every external API call](../decisions/005-circuit-breakers-on-external-apis.md) -- same exponential backoff + permanent-failure classification pattern applied to a different direction.
- [../components/connector-iot-server-side.md](../components/connector-iot-server-side.md) -- the server-side route handler that receives this traffic.
