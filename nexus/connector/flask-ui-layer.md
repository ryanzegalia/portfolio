# Connector Flask UI Layer
> Part of the Nexus Connector subsystem

**Python 3 Flask 3.x application** serving the operator dashboard on port 9100. The main app customers interact with -- everything except the Python 2.7 radio bridge lives here.

## Responsibilities

- Serve the HTML dashboard with three tabs: **the primary brand** (RF module management), **the wireless line** (BLE module testing), **Hazmat** (DOT compliance printing).
- Handle company portal OAuth via popup + `postMessage` flow. Only authenticated the company employees can use the connector; customer accounts are blocked.
- Manage the Python 2.7 SNAP bridge subprocess -- start it, supervise it, restart it on zombie state, distinguish intentional stops from crashes.
- Run the BLE asyncio event loop on a dedicated background thread for wireless module testing (see [ble-integration.md](ble-integration.md)).
- Drive the Windows system tray icon via `pystray` -- persistent presence, right-click menu, start/stop bridge, quit cleanly.
- Run the outbox sync service pushing test results to the Nexus API on a 30-second cadence (see [nexus-sync-outbox.md](nexus-sync-outbox.md)).
- Handle the auto-update path -- check for new connector versions, download and install silently on user consent.
- Expose a local HTTP API that the web UI calls via `fetch` for all interactive operations.

## Architecture highlights

### Port fallback with dynamic propagation
If port 9100 is already taken (by another application on the customer's PC), the connector assigns any available port automatically. The system tray icon, the UI adapter, and the browser window all read the dynamically assigned port rather than hardcoding 9100. The connector boots successfully even in environments where 9100 is blocked.

### ServerThread runs Flask in the background
Flask doesn't block the main thread. A `ServerThread` wrapper runs the Flask app as a background thread, leaving the main thread free to manage the tray icon, monitor the bridge, and handle OS-level events. On shutdown, the thread is signaled cleanly and the Flask app stops serving without leaving orphaned connections.

### MIME type fix for ES modules on Windows
Windows Python's stdlib HTTP server serves `.js` files as `text/plain`, which browsers reject for `type="module"` scripts. Flask's default handler also had quirks here. The connector explicitly overrides the MIME type map to serve `.js` as `application/javascript`, fixing a non-obvious bug that broke ES module imports on Windows-only.

### Settings persistence
Per-user settings (connector preferences, saved browser sessions, API key configuration) persist to `%APPDATA%\the primary brand Nexus\settings.json`. Written atomically to avoid corruption on concurrent writes. Read at every startup; defaults are applied for missing fields so old config files still work after updates.

### Web Components, no framework
Matches the main Nexus dashboard's approach (see [../architecture/UI_ARCHITECTURE.md](../architecture/UI_ARCHITECTURE.md)). Three tabs are independent custom elements loaded as ES modules. SSE streams deliver real-time module state changes to the browser without polling.

## Key decisions

- **Flask 3.x** (the main Nexus API uses Flask 2.3.3). Two independent applications, both on actively maintained Flask versions.
- **Subprocess supervision in the Flask app itself**, not via an external service manager. See [ADR-032: Bridge watchdog and dual-layer auto-recovery](../decisions/032-bridge-watchdog-and-dual-layer-auto-recovery.md).
- **No iframe, no webview wrapper, no Electron.** The connector is Flask + native Custom Elements running in the user's default browser, opened from the system tray. Lower memory footprint than Electron, simpler architecture, same UX.

## What this layer doesn't do

- **Doesn't talk to the radio directly.** All SNAP / 802.15.4 communication goes through the Python 2.7 bridge subprocess via localhost HTTP. Clean process boundary.
- **Doesn't store customer data.** Test results are captured locally in SQLite, then pushed to the Nexus API via the outbox sync service. The local store is a buffer, not a long-term store.
- **Doesn't authenticate directly against the company portal's identity store.** The Flask app validates JWTs issued by Portal's OAuth flow; Portal is the authoritative identity layer.
