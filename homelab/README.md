# Home Production Environment

A self-managed production environment that runs personal media, home tooling, and a local AI stack on commodity hardware, with real monitoring, offsite backups, and single sign-on across every app.

## Architecture

The environment spans five hosts, four active and one retired and decommissioned, running roughly 40 Docker services as of July 2026. Services are grouped into seven functional areas: media, downloads, monitoring, home tools, identity, infrastructure, and GPU and AI workloads.

A reverse proxy at the edge handles TLS and routing. It pairs wildcard DNS with automatic certificate issuance, so a newly added service gets HTTPS with no per-service configuration to write. Network-wide DNS filtering runs at the same layer. A single-sign-on identity provider fronts the applications with OAuth login and per-application provisioning, so access is granted in one place rather than per service.

Storage is a pooled union filesystem of roughly 48TB spanning mixed drives, presented to services as a single namespace so capacity can grow by adding disks without reshaping paths.

Download services run inside a VPN network namespace that is fail-closed by design: if the tunnel drops, traffic stops rather than leaking to the open network.

## Reliability

Backups run nightly to offsite object storage, using restic against B2-class storage. A morning canary job verifies the previous night's chain rather than assuming it completed.

A backup audit surfaced a disaster-recovery circular dependency: the decryption credentials for the backup lived in a credential vault that was itself inside the backup scope. A cold restore would have needed the very backup it could not open without those credentials. The fix moved the recovery credentials out of band, so a full restore no longer depends on the system being restored.

Three incidents shaped the current storage design:

- Repeated storage-pool collapses were root-caused to a flaky USB-SATA bridge and a systemd mount-dependency teardown ordering, then designed around rather than papered over.
- An ephemeral-container storage bug was silently discarding user uploads. Once root-caused, the affected paths were converted to host bind-mounts and added to the nightly backup set in the same incident.
- A newly added service was found sitting outside backup coverage. Coverage was closed the same day with a write-ahead-log-safe hot database backup, so the snapshot stays consistent without stopping the service.

## Operations

Uptime monitoring covers more than 25 service monitors and posts alerts to a chat channel. Per-drive SMART monitoring watches disk health, and an hourly watchdog tracks free disk space.

One hardening pass removed four independent sources of false-positive alerts at once. All four traced back to a single dead proxy that the checks depended on, so the fix corrected the real trigger instead of loosening thresholds, which would only have hidden real failures alongside the noise.

Selected source excerpts live in the subfolders.