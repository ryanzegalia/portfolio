# Service Monitoring

Two PowerShell watchdog scripts that monitor process health and Docker daemon availability. Both run on short timers via Task Scheduler and alert via Discord webhooks when they take action.

## Memory Watchdog

Runs every 10 minutes. Monitors a configurable list of processes for memory leaks, auto-restarts when thresholds are exceeded, and sends structured Discord alerts.

### Key Patterns

**Cooldown State Machine:** After restarting a process, the watchdog enters a cooldown period (default 30 minutes). State is persisted to a JSON file between invocations, so the cooldown survives across scheduled task runs. This prevents restart storms where a process that leaks quickly gets restarted every 10 minutes.

**Polymorphic Restart:** Each monitored process declares its restart method:
- `service` -- uses `Restart-Service` for Windows services managed by NSSM or the native service manager
- `process` -- kills the process by name and starts the executable directly, for standalone apps that aren't registered as services

**Alert-Only Mode:** Some processes (like a media server during active streaming) shouldn't be auto-restarted even when over threshold. Setting `AlertOnly = $true` sends the Discord notification without taking action, so an operator can decide when to restart.

**Threshold Tracking:** Processes approaching their threshold (>75% of limit) generate informational log entries for trend analysis, even when no action is taken.

### Discord Embeds

Alerts include structured fields: process name, action taken, current memory, threshold, memory after restart, and cooldown duration. Color-coded by alert type (orange for threshold restarts, blue for scheduled maintenance, yellow for alert-only warnings).

## Docker Watchdog

Runs every 5 minutes. Monitors the Docker daemon inside WSL2 and recovers from cold-boot scenarios.

### Recovery Flow

1. Check if WSL Ubuntu distribution is running
2. If not, start it with `wsl -d Ubuntu -e echo`
3. Check if `dockerd` process exists inside WSL (`pgrep -x dockerd`)
4. If Docker is down, start the service (`sudo service docker start`)
5. Wait 5 seconds for initialization
6. Verify Docker is responding
7. Find all stopped containers and restart them

This handles the common failure mode where the WSL2 VM auto-suspends after idle timeout, taking Docker and all containers offline. The watchdog detects this within 5 minutes and brings everything back up without manual intervention.

## Source Files

- [`src/memory-watchdog.ps1`](src/memory-watchdog.ps1) -- Process memory monitoring with cooldown state machine and polymorphic restart
- [`src/docker-watchdog.ps1`](src/docker-watchdog.ps1) -- Docker daemon health check and container recovery
