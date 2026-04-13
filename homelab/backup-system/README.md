# Nightly Disaster Recovery Backup System

A PowerShell-based backup system that runs nightly at 3:00 AM, backing up 9 categories of data across Windows services, Docker containers, and system state. Produces a structured manifest, HTML report, and Discord notification on every run.

## What Gets Backed Up

| Category | Method | Examples |
|----------|--------|----------|
| Service databases | API-triggered backup with polling | Media management services (trigger backup command, poll for completion, fall back to latest snapshot) |
| Directory databases | Incremental robocopy | Media server data, monitoring databases |
| PostgreSQL dumps | `pg_dump` (host) or `docker exec pg_dump` | Analytics databases, application databases |
| Docker volumes | `docker cp` through WSL UNC paths | Dashboard configs, application data |
| Docker compose files | Direct file copy via `\\wsl$\` paths | All service definitions |
| Application configs | Incremental robocopy with exclusions | Reverse proxy, automation scripts, app configs |
| Service manager configs | Registry export + structured JSON | NSSM service definitions (paths, args, env vars, restart policies) |
| Scheduled tasks | XML export | Watchdog timers, backup schedule, maintenance tasks |
| System state | Multi-source collection | Firewall rules, installed software, network config, drive info |

## Key Patterns

### API-Triggered Backup with Polling + Fallback

Some services support triggering a backup through their API, which ensures WAL-consistent SQLite snapshots. The pattern:

1. POST a backup command to the service API
2. Poll the command status endpoint every 5 seconds (up to 60s timeout)
3. If the command completes, copy the fresh backup file
4. If polling times out, log a warning and copy the latest available backup anyway

This gives you a consistent backup when the service is responsive, with graceful degradation when it isn't.

### Docker Database Dumps with Health Check Polling

Before executing `pg_dump` inside a Docker container, the script:

1. Verifies the container is running (`docker inspect`)
2. Checks the container's health status
3. If status is "starting", polls every 5 seconds (up to 60s) until healthy
4. Executes the dump command only after health check passes

This matters after WSL cold boots -- containers with health checks need time to initialize their databases.

### WSL Cold-Boot Detection

WSL2 auto-suspends when idle. The backup script:

1. Sends a wake command (`wsl -d Ubuntu -e true`)
2. Waits 10 seconds for the VM to initialize
3. Retries up to 3 times with echo-based verification
4. If WSL was cold-booted, waits an additional 30 seconds for Docker containers to stabilize
5. If WSL never responds, skips all Docker backups (non-fatal)

### Tiered Retention

```text
daily/    -- kept for 7 days
weekly/   -- promoted on Sundays, kept for 28 days
monthly/  -- promoted on 1st of month, kept for 60 days
latest    -- NTFS junction pointing to today's backup
```

Cleanup is date-aware: before deleting a daily backup, it checks whether the backup qualifies as a weekly (Sunday) or monthly (1st) that hasn't expired yet. This prevents gaps in the retention chain.

### Analytics Dashboard

Each backup run appends to a `history.json` file with:

- Per-category size breakdowns and success counts
- Drive usage snapshots for capacity planning
- Growth rate calculation from recent history
- Estimated drive fill date projection

A static HTML dashboard (served via Caddy) renders these into charts showing backup size trends, drive capacity, and failure history.

## Error Handling

- **Pre-flight checks:** Verify backup drive is mounted and writable before starting. Abort with alert on failure.
- **Crash-safe alerting:** A global try/catch wraps the entire script. Even if the backup logic crashes, the Discord alert fires.
- **Per-item tracking:** Every backup item records success/failure, size, duration, and error message. All collected into a manifest.
- **Minimum size validation:** Each backup type has a minimum expected size. Undersized backups generate warnings (catches empty/corrupt dumps).

## Source

- [`src/nightly-backup.ps1`](src/nightly-backup.ps1) -- Sanitized excerpt showing the most architecturally interesting sections: API-triggered backups, Docker database dumps, retention logic, and pre-flight checks.
