# ADR-032: Bridge Watchdog and Dual-Layer Auto-Recovery

## Context

The Nexus Connector runs a Python 2.7 subprocess (the SNAP bridge) to communicate with wireless modules. The bridge has several failure modes that aren't immediately visible to the operator:

1. **Silent crash.** An unhandled exception inside the bridge terminates the subprocess. The Python 3 connector doesn't automatically notice.
2. **Zombie state.** The subprocess is alive but isn't responding to HTTP requests -- serial port disappeared, library is deadlocked, or a thread is stuck.
3. **Event writer thread death.** The bridge's background event writer can die while the rest of the bridge keeps running. No events are written, but the bridge looks healthy from outside.
4. **Serial disconnect.** The USB dongle is unplugged or fails. The bridge keeps running but all RF operations fail silently.

Without supervision, any of these failure modes leaves the operator looking at a dashboard that says "Starting..." or shows stale module state with no explanation.

## Decision

Two layers of recovery, both running simultaneously.

**Layer 1 -- Python watchdog (`snap_watchdog.py`, ~200 lines).** A background thread in the Python 3 connector process checks bridge health every 30 seconds and detects five zombie states: the bridge reports modules present but `GET /modules` returns an empty array; no heartbeat events in 2+ minutes with modules present; no scan events in 5+ minutes; event writer thread dead (reported via the bridge's `/health` endpoint); or no events at all in 5+ minutes.

On unhealthy detection, the watchdog attempts a bridge restart with exponential backoff: 10s, 20s, 40s, 80s, 160s, capping at 300s. After 5 consecutive failures, the watchdog disables itself and logs CRITICAL -- this avoids an infinite restart loop against a permanently broken bridge. A callback mechanism distinguishes intentional stops from crashes. When the bridge is stopped via the UI, the connector calls `watchdog.notify_intentional_stop()` before sending the shutdown signal, suppressing the restart trigger.

**Layer 2 -- Batch script restart loop (`start_bridge.bat`).** A Windows batch script wraps the bridge process. Exit code 0 = clean shutdown, no restart. Exit code 99 = explicit no-restart (intentional shutdown). Any other exit code = crash, restart immediately. This catches hard crashes where the Python watchdog itself might have been killed too (system OOM, Windows force-terminate).

The two layers catch different failure modes: the Python watchdog catches logic-level zombie states where the bridge is running but broken; the batch script catches process-level crashes where the bridge has terminated.

## Alternatives Considered

- **Single-layer recovery (Python watchdog only).** Rejected because a watchdog that crashes with the bridge can't restart it. Batch-level recovery is the fallback for that scenario.

- **Single-layer recovery (batch script only).** Rejected because hard crashes are rarer than zombie states. A zombie bridge exits with code 0 (it's still running, just not working), so the batch loop would not restart it.

- **Use Windows Services.** Would give supervised execution. Rejected because Services run with different privileges than the user's desktop session, which breaks device access that requires a user session context and GUI tray interaction.

- **Configurable thresholds via environment variables.** Adopted within the design -- `WATCHDOG_INTERVAL`, `WATCHDOG_NO_HEARTBEAT_THRESHOLD`, `WATCHDOG_MAX_RESTARTS` are configurable. Allows field tuning without code changes.

## Consequences

Bridge failures become self-healing. An operator who sees "Starting..." typically sees it resolve within 30 seconds to 3 minutes without intervention. The two layers together cover crash, zombie, event-writer-dead, and serial-disconnect -- single-layer would leave gaps. Intentional stops don't fight the watchdog. Recovery events are logged so the operator can see exactly what happened and when.

The costs: two layers is more complexity than one, and understanding the full recovery flow requires reading both `snap_watchdog.py` and `start_bridge.bat`. The 5-restart ceiling is a judgment call -- too low and a flaky environment burns through it quickly, too high and a broken bridge causes restart storms. The zombie detection heuristics can produce false positives during legitimate slow periods. The batch script layer also doesn't exist on macOS, so the macOS build loses the second layer of recovery.