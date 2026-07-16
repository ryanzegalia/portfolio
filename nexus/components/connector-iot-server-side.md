# Connector / IoT Management (Server-Side)
> Part of the Nexus production automation platform

The server-side counterpart to the Nexus Connector desktop app -- API routes that receive heartbeats, logs, telemetry, and firmware update requests from customer PCs.

When the company customer installs the Nexus Connector on their Windows PC, the connector talks to these Nexus API endpoints.

## What it is

The server-side code handles check-ins, log uploads, telemetry ingestion, firmware version checks, and connector auto-update package delivery.

This is separate from the [connector subsystem documentation](../connector/) which covers the customer-side Python application. This doc covers the Nexus API surface that the connector talks to.

## Primary files

| File | Lines | Role |
|---|---|---|
| `api/routes/v1/connectors.py` | 292 | Receives live heartbeats every 60s from the primary brand Nexus Connectors. Status classification: online (<180s), stale (180-600s), offline (>600s). Event retention: 7 days, 200 per connector. |
| `api/routes/v1/connector_update.py` | 924 | Version checking + package download for silent auto-update. Manifest-driven local mode vs. production proxy fallback to the production domain. Cloudflare CDN purge on publish. Dual auth: dashboard (session) + script (API key via `package_payload.ps1`). |
| `api/routes/v1/connector_logs.py` | 221 | Receives gzip-compressed logs (startup, shutdown, crash, scheduled, manual). Base64-encoded storage, decompression on read. 30-day retention, 200 logs per connector. |
| `api/routes/v1/firmware_releases.py` | 298 | Local firmware mirror serving `.spy` files. Mimics the company portal's `/hardware/firmware/versions` contract. |
| `api/services/module_telemetry_service.py` | 249 | Upgrade sessions, per-module records, battery telemetry. Tracks first_seen/last_seen per (address, connector_id) pair. Thread-safe singleton. |
| `api/services/netid_service.py` | 447 | Database abstraction for remote Net ID allocation pool management using 16-bit SNAP Network IDs. |

## Scale and verified numbers

- **Connector heartbeat cadence**: every 60 seconds (from connector to Nexus)
- **Online threshold**: < 180 seconds since last heartbeat
- **Stale threshold**: 180-600 seconds
- **Offline threshold**: > 600 seconds
- **Event retention**: 7 days, 200 events per connector
- **Log retention**: 30 days, 200 logs per connector
- **Net ID allocation**: 16-bit range (65,536 possible IDs), pool-managed to prevent collisions

## Key architectural decisions

- **Hash-based API key auth for connectors.** Every connector instance has its own API key. The server stores only the SHA256 hash. Same pattern as the main Nexus API. See [ADR-014](../decisions/014-redis-for-cross-worker-shared-state.md) for the shared-state pattern this enables.
- **CDN-backed auto-update with manifest fallback.** Connector update packages are served via Cloudflare CDN for speed. If the CDN is unavailable or the manifest is in "local mode" for testing, the proxy falls back to direct server-side delivery. `package_payload.ps1` script allows CI to publish new versions.
- **Gzip-compressed log uploads.** Connectors compress logs before upload to save bandwidth on customer internet connections. The server decompresses on read (never on write -- stored compressed to save disk).
- **Bounded retention (7 / 30 days).** Customer PCs generate noisy telemetry. Retention limits prevent the database from growing unbounded. Older data is archived (or dropped, depending on the operator's configuration).
- **Net ID allocation is pool-managed.** Two connectors in the same RF area must not assign the same Net ID to different modules (would cause RF collisions). The `netid_service.py` maintains an allocation pool; connectors request "give me an available ID" rather than picking their own.
- **Firmware mirror mimics Portal contract.** The Nexus API mirrors the company portal's `/hardware/firmware/versions` endpoint exactly, so connectors that were written against the Portal contract can talk to Nexus as a drop-in replacement without code changes.

## Inputs and outputs

**Receives from connectors:**
- Heartbeat check-ins (every 60s)
- Event logs (on significant events: startup, crash, upgrade)
- Module telemetry (battery readings, upgrade progress, signal strength)
- Net ID allocation requests

**Sends to connectors:**
- Auto-update package downloads (CDN-backed)
- Firmware `.spy` file downloads (local mirror of Portal contract)
- Net ID assignments (allocated from the pool)

**Writes to:**
- `connector_checkins`, `connector_events` (heartbeat and event history)
- `module_upgrades`, `module_battery_telemetry` (per-module lifecycle)
- `connector_modules`, `connector_sessions` (session tracking)
- `net_ids`, `net_id_config` (allocation pool)