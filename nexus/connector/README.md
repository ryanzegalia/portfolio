# Nexus Connector -- Windows Desktop Application
> Part of the Nexus Connector subsystem

The customer-side companion app that ships as a signed Windows executable.

## What it is

The Nexus Connector is a **Windows desktop application** that runs on customer PCs and manages wireless modules over 802.15.4 radio. It bridges the gap between the Nexus cloud API (which lives on the production VPS) and the USB radio dongle (which must be plugged into the customer's PC). Without the connector, there's no way for operators in the field to manage modules remotely.

The connector is a **two-process application**: a Python 3 Flask web UI on port 9100 (the main app -- handles OAuth, BLE, system tray, dashboard rendering) paired with a Python 2.7 Tornado bridge subprocess on port 9101 (uses the radio library for 802.15.4 communication). The two processes communicate over localhost HTTP. The version split isn't a preference -- it's a hard constraint, because the radio library is Python 2.7 and has never been ported.

## Component docs in this folder

| Component | Covered by |
|---|---|
| Python 3 Flask UI layer | [flask-ui-layer.md](flask-ui-layer.md) |
| Python 2.7 SNAP Bridge | [ADR-022: Python 2.7 bridge isolation](../decisions/022-python-27-bridge-isolation-via-http-subprocess.md) |
| Bridge watchdog + auto-recovery | [ADR-032: Bridge watchdog and dual-layer auto-recovery](../decisions/032-bridge-watchdog-and-dual-layer-auto-recovery.md) |
| Tiered module polling queue | [ADR-034: Tiered module polling queue for RF scaling](../decisions/034-tiered-module-polling-queue-for-rf-scaling.md) |
| `dmcast_rpc` rejection / heartbeat primitive | [ADR-033: `dmcast_rpc` rejection](../decisions/033-dmcast-rpc-rejection-mcast-rpc-heartbeat.md) |
| BLE integration (the wireless line testing) | [ble-integration.md](ble-integration.md) |
| Code signing + distribution | [ADR-023: Azure Trusted Signing over OV/EV](../decisions/023-azure-trusted-signing-over-ov-ev-cert.md) |
| Outbox sync to Nexus API | [nexus-sync-outbox.md](nexus-sync-outbox.md) |
| Server-side API that receives connector traffic | [../components/connector-iot-server-side.md](../components/connector-iot-server-side.md) |

## At a glance

- **Two-process architecture**: Python 3 Flask 3.x on port 9100, Python 2.7 Tornado on port 9101. Communicate over localhost HTTP.
- **Python version split is a hard constraint**: the radio library is Python 2.7 only and has never been ported.
- **SQLite for local persistence**: `bridge_events.db` (bridge event log + session registry + module identity cache), `test_records.db` (the wireless line test sessions), local module DB with tier queue state.
- **BLE via `bleak`** on a dedicated asyncio background thread, isolated from the Flask WSGI request thread.
- **System tray** via `pystray + Pillow` for the Windows tray icon.
- **Distribution** via PyInstaller single-folder build, signed via Azure Trusted Signing so releases install without SmartScreen warnings. See [ADR-023](../decisions/023-azure-trusted-signing-over-ov-ev-cert.md).
- **Outbox sync** to the Nexus API every 30 seconds with exponential backoff and UUID-based dedup.
- **Dual-layer recovery** for bridge zombie states: Python watchdog + batch script restart loop.

## Version history highlights (v0.1.0 -- v0.3.11)

- **v0.1.0** -- foundation. CustomTkinter desktop UI, Python 2.7 bridge, the radio library integration, OTA firmware upload, Portal OAuth.
- **v0.3.0** -- UI platform rewrite. CustomTkinter replaced with Flask 3.x + vanilla Web Components + SSE streaming. the primary brand / the wireless line / Hazmat tabs as custom elements.
- **v0.3.1-v0.3.2** -- RF scan optimization. Two-phase discovery + enrichment scan; eliminated the "discovery storm" of colliding responses.
- **v0.3.6** -- heartbeat correctness fix. Reverted from broken `dmcast_rpc + callback()` to `mcast_rpc`. See [ADR-033](../decisions/033-dmcast-rpc-rejection-mcast-rpc-heartbeat.md).
- **v0.3.8** -- module identity resolution + re-enrichment flooding fix. `enrichment_attempted` flag at-start (not at-completion) broke a 44-cycles-per-5-minutes feedback loop under RF congestion.
- **v0.3.9** -- persistent module database with 7-table schema + `ModuleQueue` state machine + outbox sync service.
- **v0.3.10** -- operational resilience. `BridgeWatchdog`, session lifecycle tracking, defense-in-depth recovery.
- **v0.3.11** -- RF reliability tuning. `module_identity_cache` with 24-hour TTL, heartbeat fill queries for firmware CRC retry.

The individual component docs and ADRs linked above cover every subsystem in detail.
