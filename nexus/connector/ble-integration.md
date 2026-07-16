# BLE Integration
> Part of the Nexus Connector subsystem

**`bleak`-based asynchronous Bluetooth Low Energy layer** in the Python 3 connector. Used for wireless module configuration and pre-deployment self-testing, which happens over BLE (distinct from the SNAP/802.15.4 radio used for the main wireless modules).

## The problem

Wireless modules expose their configuration and test interface over BLE. Operators need to connect to a module, read its self-test and per-channel status, and record pass/fail results. Multiple modules should be testable in parallel -- waiting for one BLE operation to complete before starting the next is too slow for a real shop floor workflow.

BLE is inherently async. Flask is inherently sync (WSGI). Running `asyncio` directly inside a Flask request handler breaks in ways that are subtle and hard to debug. The solution has to isolate the async event loop from the synchronous request thread.

## The approach

**A dedicated asyncio background thread owns the BLE event loop.** All BLE operations -- scan, connect, read characteristics, subscribe to notifications, disconnect -- are dispatched as coroutines into this loop via thread-safe queues and callbacks. The Flask request thread never awaits anything BLE-related; it just submits a coroutine and gets a future back.

The `SlotManager` (separate module) holds **6 parallel test slots**. Each slot owns an independent `BleakClient` connection and runs its own `SlotState` machine: `IDLE -> CONNECTING -> CONNECTED -> TESTING -> COMPLETE -> DISCONNECTED`. Operators can connect 6 modules simultaneously, run tests across all of them in parallel, and submit results as they complete.

The wireless line tab in the connector UI reads slot state via `GET /ble/slots` and receives real-time updates via SSE from the `EventSource` connection. State transitions fire events that get pushed to the browser without polling.

## Technical highlights

- **Dedicated asyncio loop on a background thread.** Flask is WSGI; `bleak` requires asyncio. The threading bridge avoids running an async Flask server just for BLE.
- **6-slot parallel design.** Real-world testing workflows connect multiple modules at once; a single-connection design would force serial testing and significantly slow the shop floor.
- **Graceful degradation on import failure.** `bleak` isn't always available (e.g., on Windows machines without BLE hardware, or on the macOS build). The BLE manager catches the import error at module load time and sets `BLEAK_AVAILABLE = False`. The connector boots successfully; the wireless line tab simply shows a disabled state.
- **BLE service UUIDs are module-level constants.** Device info, channel, and script service identifiers are defined as Python UUID constants in `ble_manager.py`. Characteristic UUIDs follow the same pattern. No magic strings scattered through the code.
- **Test session history in SQLite.** `test_records.db` captures every test session with module identity, timestamp, operator, result, and raw per-channel data. Pushed to the Nexus API via the outbox sync service.
- **Bluetooth failure modes handled.** Connection timeouts, adapter disconnects, and invalid characteristics all have explicit handlers. A failing BLE operation doesn't crash the connector -- it fails the slot and leaves the other slots untouched.

## File structure

- `connector/app/ble_manager.py` -- ~400 lines. Async event loop, connection lifecycle, service/characteristic constants.
- `connector/app/slot_manager.py` -- manages the 6-slot test grid, handles slot state transitions.
- `connector/app/test_db.py` -- SQLite persistence for test sessions.
- `connector/app/routes/ble_routes.py` -- 40+ HTTP routes: `/ble/scan`, `/ble/slot/N/connect`, `/ble/slot/N/disconnect`, `/ble/slots`, `/ble/test/submit`, etc.

## Key decisions

- **Thread-isolated asyncio loop**, not async-Flask. Flask is deeply synchronous in its middleware, request teardown, and extension ecosystem. Adopting async-Flask would have required rewriting every other part of the connector. The threading bridge is the cheapest isolation.
- **6 slots, not N slots.** Empirical choice -- real shop-floor workflows test 4-6 modules at a time. Making the slot count dynamic would have added UI complexity for no benefit at the company's scale.
- **Graceful degradation when `bleak` is missing.** The connector has to run on customer machines that may not have BLE capability. Import guards + a disabled tab are the minimum-surprise behavior.
