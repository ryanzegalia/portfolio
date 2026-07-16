# ADR-022: Python 2.7 Bridge Isolation via HTTP Subprocess
## Context

The Nexus Connector is a Windows desktop application that manages wireless modules via an 802.15.4 radio (the "USB radio dongle" USB dongle). Talking to the USB radio dongle requires the radio library from the radio vendor. The radio library is written for Python 2.7. It has never been ported to Python 3. There is no official successor library. Anyone who wants to talk to SNAP modules is stuck with Python 2.7 in some form.

This created a hard constraint. The rest of the connector needed modern Python 3 -- Flask 3.x for the web UI, `bleak` for Bluetooth, `pystray` for the system tray, f-strings, type hints, modern async. Forcing the whole connector onto Python 2.7 would have meant giving up all of that. Python 2.7 reached end-of-life on 2020-01-01. Building new features on it is a slow-motion disaster.

## Decision

**Run the SNAP radio layer as a Python 2.7 Tornado subprocess on localhost port 9101. Talk to it via HTTP from the Python 3 Flask UI on port 9100.**

The Python 3 connector (Flask 3.x on port 9100) is the main application. It handles OAuth, system tray, BLE for wireless modules, the web dashboard, the outbox sync to the main Nexus API, and everything else customers see. When it needs to talk to a SNAP radio module -- discover, heartbeat, poll telemetry, upload firmware -- it sends an HTTP request to the bridge on port 9101.

The bridge (`snap_bridge/bridge.py`, ~3,800 lines, Python 2.7) runs as a Tornado HTTP server exposing ~20 endpoints: `GET /scan`, `GET /modules`, `POST /upload`, `GET /events`, etc. Inside the bridge, it uses the radio library to drive the radio. Module state is kept in an in-process dict, persisted to `bridge_events.db` (SQLite) for durability across bridge restarts.

The two processes communicate entirely over localhost HTTP. No shared memory. No pickling. No version compatibility concerns. The bridge could be rewritten in any language tomorrow and as long as it served the same endpoint contract, the Python 3 connector would not care.

## Alternatives Considered

- **Single Python 2.7 process for everything.** Would work but gives up Flask 3, bleak, f-strings, type hints, and the asyncio primitives used by the BLE layer. Python 2.7 reached end-of-life on 2020-01-01. Building new features on an end-of-life runtime trades short-term convenience for long-term decay.

- **Port the radio library to Python 3.** The library handles RF collision avoidance, multicast dispatch, callback routing, and the specifics of the vendor's protocol stack. Porting would require understanding every behavior in detail and validating it against real hardware -- weeks of work for a library maintained by almost nobody. The fork would rot as the radio library versions diverged.

- **`subprocess.Popen` with pickled IPC between the two Pythons.** Rejected because pickling across Python 2 and Python 3 is unreliable -- bytes vs. strings, different class hierarchies, different exception types. Every IPC call would be a compatibility minefield.

- **A C extension that bridges the two versions.** Too much implementation cost for too little gain. The bridge would not just need to proxy calls -- it would need to manage the USB radio dongle connection, handle async callbacks, maintain state. Reimplementing in C means reimplementing the radio library.

- **Run the bridge on a separate machine.** Overkill. The bridge needs to be on the same machine as the USB radio dongle USB dongle, which means the customer's PC. A separate process on the same machine is the natural boundary.

## Consequences

**Good:**
- The Python 3 connector gets modern Python. Flask 3.x, bleak, pystray, f-strings, type hints, asyncio. Everything the rest of the ecosystem uses.
- The Python 2.7 code is constrained to one directory (`connector/snap_bridge/`) and one process. The rest of the codebase does not have to know Python 2.7 exists.
- The HTTP boundary is a clean contract. The bridge can be debugged independently by calling `http://localhost:9101/modules` directly. The connector's HTTP calls can be validated independently of what the bridge is doing. Two decoupled layers.
- The bridge can be replaced. If a Python 3 radio library appears, or the vendor releases a new RF library, the bridge can be rewritten without touching the connector -- as long as the HTTP contract is preserved.
- The bridge writes its own SQLite event store (`bridge_events.db`). The Python 3 connector reads from it when the bridge is down, so the dashboard can still show the last known module state even if the bridge is offline.

**Bad / costs:**
- Two processes to manage. The connector has to start the bridge as a subprocess, monitor it for zombie states, restart it if it dies, and distinguish intentional stops from crash signals. See ADR-032 for the recovery pattern.
- Every call to the bridge is an HTTP round-trip. Localhost is fast (sub-millisecond for small requests) but it is not zero. For high-frequency operations like module heartbeat polling, the HTTP overhead is visible.
- Python 2.7 is dead. No security updates, no stdlib improvements, no ecosystem support. The constraint is not going away unless the radio library is ported.
- The bridge code must follow Python 2.7 conventions, which are enforced by project-level linting rules.

The bridge heartbeat implementation went through several iterations. One attempt used `dmcast_rpc + callback()` -- the radio library directed multicast with a callback response -- and it broke in production. From the CHANGELOG (v0.3.6): "Root cause: `dmcast_rpc + callback()` fundamentally broken (vendor docs confirm). Reverted heartbeat to `mcast_rpc`. All modules responding." The lesson: the Python 2.7 library has behaviors that no modern IDE would catch. Isolating it to a Tornado subprocess limits the blast radius to one file in one directory, but it does not remove the need to test against real hardware.
