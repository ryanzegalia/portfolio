# Homelab: 27 Services on a Single Machine

A self-hosted media and application server running 27 services on a Windows 10 laptop. The system handles media streaming, transcoding, monitoring, backups, and a handful of custom web applications -- all managed through a mix of Docker containers (via WSL2), native Windows services, and PowerShell automation.

## Architecture

```text
                    Caddy (reverse proxy)
                          |
        +---------+-------+-------+---------+
        |         |       |       |         |
    Jellyfin   Homepage  Apps   APIs    Monitoring
    (stream)   (dashboard)              (3 layers)
        |
    Transcoder -----> FFmpeg (GPU transcode)
        |
    Media Library (Movies + TV)
```

### Service Management

Services run in two modes depending on their requirements:

- **Docker (WSL2):** PostgreSQL-backed apps, Homepage dashboard, custom microservices. Managed via `docker-compose` with health checks and restart policies.
- **NSSM (native Windows):** Services that need direct GPU access, Windows filesystem paths, or can't tolerate WSL networking quirks. NSSM wraps each process as a Windows service with auto-restart on failure.

A Caddy reverse proxy sits in front of everything, terminating TLS and routing `*.local` domains to the correct port.

### Monitoring (Three Layers)

1. **Memory Watchdog** -- PowerShell script on a 10-minute timer. Tracks working set of each monitored process against configurable thresholds. Cooldown logic prevents restart storms. Polymorphic restart handles both Windows services and standalone executables.

2. **Docker Watchdog** -- Checks WSL2 Docker daemon health every 5 minutes. Detects cold-boot scenarios where WSL auto-suspended, wakes the VM, waits for Docker to stabilize, then recovers any stopped containers.

3. **External Health Checks** -- Uptime Kuma monitors all service endpoints from inside the network. Healthchecks.io receives heartbeats from the server itself, providing an external dead-man's-switch that alerts if the entire machine goes offline.

**Alerting layer.** All three watchdogs and per-service health emitters route through a custom Discord dispatcher rather than direct webhooks. The dispatcher handles category-based channel routing across 16 channels, severity tiers (info/warn/critical with role mentions on critical), dedup keys to suppress alert storms, and interactive ack/silence/escalate buttons. Replaces the original fan-out of per-service webhooks with a single point of structured alerting.

### Backup System

Nightly disaster recovery backups cover 9 categories:

- API-triggered database backups (poll for completion, fall back to latest snapshot)
- Docker database dumps with container health check polling
- Incremental directory backups via robocopy
- WSL UNC path access for Docker volume backups
- System state exports (firewall rules, service configs, scheduled tasks, installed software)

Tiered retention: daily (7 days) -> weekly (28 days) -> monthly (60 days). An analytics dashboard tracks backup sizes, drive growth, and projects estimated fill dates.

### Custom Transcoding

Custom media transcoding system built after the open-source orchestrator was used for several months but became unsustainable at 19,000+ files. FastAPI server + Python FFmpeg worker with:

- Smart bitrate analysis with HDR detection and resolution-aware skip thresholds
- 4-tier retry cascade: hwaccel -> subtitle conversion -> subtitle drop -> software decode
- Stall watchdog that kills hung FFmpeg processes
- Atomic file replacement with creation-time preservation
- Drive health monitoring to prevent false delete detection on unmapped drives

## Tech Stack

| Layer | Tools |
|-------|-------|
| Streaming | Jellyfin |
| Reverse Proxy | Caddy (automatic TLS, wildcard local domains) |
| Containers | Docker on WSL2 Ubuntu |
| Native Services | NSSM (Non-Sucking Service Manager) |
| Transcoding | FFmpeg + NVENC (RTX 5090), custom Python orchestration |
| Databases | PostgreSQL 16, SQLite (per-app) |
| Migrations | Alembic |
| Monitoring | Uptime Kuma, Healthchecks.io, custom PowerShell watchdogs |
| Alerting | Discord webhooks |
| Backups | PowerShell + robocopy, tiered retention, HTML dashboard |
| Dashboard | Homepage (Docker), custom widgets |

## Subprojects

- [`transcoder/`](transcoder/) -- Custom transcoding system (scanner + worker)
- [`backup-system/`](backup-system/) -- Nightly disaster recovery with analytics
- [`monitoring/`](monitoring/) -- Process and container watchdogs

## Key Design Decisions

**Why Windows?** The server is a repurposed laptop. WSL2 gives Docker support while keeping direct access to NVENC for GPU transcoding and native NTFS for the media library.

**Why not Kubernetes?** Single machine, 27 services. Docker Compose and NSSM cover the orchestration needs without the operational overhead. The monitoring stack catches failures faster than a pod restart policy would.

**Why custom transcoding?** The open-source orchestrator was used initially but didn't hold up at 19,000+ files after extensive tuning. A purpose-built replacement gave direct control over retry logic, stall detection, and GPU scheduling.
