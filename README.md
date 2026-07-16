# Engineering Portfolio

Systems built and run by Ryan Zegalia, a solo builder shipping production software alongside a non-engineering role at a 20-50 person manufacturer.

Production and homelab systems: a company automation platform, go-to-market operator tooling, custom embedded-Linux firmware, a game-metadata data pipeline, and a self-managed home production environment. Most projects are MIT-licensed with source; Nexus is documentation-only.

## [Nexus](nexus/)

Production automation and integration platform for a B2B/B2C manufacturer, connecting ERP, tax, shipping, email, and project-management systems. Started late December 2025, in production since February 2026. Architecture documentation and case studies only; no source code published.

The platform is organized as four layers:

- **Ingestion.** Checkpoint-based incremental sync with nightly full-refresh safety nets pulls from ERP, e-commerce, and shipping sources into a governed Postgres mirror.
- **Customer data foundation.** Probabilistic identity resolution and deduplication collapse fragmented accounts (households, shared emails, guest checkouts) into a person spine, with owner-scoped merge edges and non-overridable cannot-link invariants guarding against over-merge.
- **Intelligence.** Forecasting (built and backtested, not yet activated), sales-trend analysis, product knowledge, and live cart telemetry turn the mirror into operational signal for the teams that use it.
- **AI-agent tool layer.** A Model Context Protocol server exposes the platform to LLM agents as 117 typed tools under a read-broad, write-gated contract, with mutations held behind preview-then-confirm gates and SQL kept read-only at two independent layers.

Flagship case studies: [Identity Resolution](nexus/case-studies/identity-resolution.md), [AI Agent Tool Layer](nexus/case-studies/mcp-agent-layer.md), and [Pricing Automation](nexus/case-studies/pricing-automation.md). Full breakdown and engineering decisions: [nexus/README.md](nexus/README.md).

## [GTM Scenarios](portfolio/) · [ryanzegalia.com](https://ryanzegalia.com)

Operator scenarios across five B2B verticals, each with a worked example running against seeded Postgres data. The scenarios are grounded in named industry research; the data is deterministic seed, the SQL and computation are real.

## [Embedded Linux (dual-screen handheld firmware)](embedded-linux/)

Systems work on a custom dual-screen Linux handheld built around a Rockchip RK3568 SoC: OTA-surviving overlay packaging, a from-scratch end-to-end touch-latency measurement rig (kernel-timestamped tap injection plus a Wayland presentation-time hook), and kernel, GPU, and power findings grounded in direct device-tree reads. Shipped features include a bottom-screen keyboard/trackpad surface for DOS emulation, multi-user save profiles across a device save mesh with automatic save-format conversion, RTC-timed deep-sleep power management verified end-to-end, and 32-bit community game ports running on the 64-bit userland.

## [Game-metadata data pipeline](data-pipeline/)

A game-metadata enrichment pipeline on a home Linux server: SQLite in WAL mode with systemd-scheduled churn, a phased "gene" enrichment model, generate-with-the-model / decide-with-code verification, and fail-closed canary exports feeding an offsite backup chain. Peaked near 44,000 records, curated to roughly 32,000 worth keeping.

## [The Bethl'mite](bethlemite/)

Source excerpt from an event-management system built for a monthly print postcard listing local concerts and events. Multi-role portals (crew, venue, distributor), drag-and-drop issue builder with print-run inventory tracking, and a content-locking lifecycle. Node.js/Express + React + SQLite.

## [Meeting Recorder](meeting-recorder/)

Source excerpt from a real-time audio capture and AI-processing pipeline built for meetings and gaming sessions. Per-process audio isolation via WASAPI Process Loopback, local GPU transcription via WhisperX, and a multi-pass AI pipeline that turns long gaming sessions into structured campaign chronicles. Python desktop daemon + web dashboard.

## [JobRadar](jobradar/)

Source excerpt from a job-discovery and application-generation pipeline spanning two machines. Multi-source scraper, staged scoring pipeline (keyword gate + LLM gatekeeper), and a Claude-powered application generator with company-research caching. FastAPI + PostgreSQL + React.

## [Infrastructure (Homelab)](homelab/)

A 5-host, ~40-service self-managed production environment with self-healing monitoring, automated GPU transcoding, single sign-on across apps, and nightly disaster-recovery backups. Docker, systemd and NSSM services, PowerShell automation, FastAPI microservices, Caddy reverse proxy.

## [Local AI Infrastructure](ai-infra/)

A GPU-scheduled local LLM inference pipeline, 40K+ records processed: a priority-lease scheduling proxy in front of a vLLM-served 27B model, a GPU-gated observation worker for knowledge-graph generation, and a unified cost-attribution dashboard spanning local Ollama and Claude API. Built to bound API spend and keep interactive work ahead of batch jobs on shared hardware.

---

## Other Projects

Small tools and experiments, not documented in depth:

- **Sports superstition tracker** · Superstition-tracking app that syncs game results from a sports stats API. FastAPI + React.
- **Trip planning app** · Friend-group trip planner for coordinating a group getaway: shared itinerary, dates, and logistics. FastAPI + React + Docker.
- **Pokemon living-dex platform** · Self-hosted platform that watches save folders across devices via Syncthing, decodes save files with PKHeX.Core, and runs a full living-dex engine: collection tracking across games and generations, per-game progression verdicts, and a records shelf.
- **Power monitoring service** · Smart power-strip controller with per-outlet monitoring. FastAPI + vanilla JS.

---

## About

Portfolio of production and homelab systems by Ryan Zegalia. See [METHODOLOGY.md](METHODOLOGY.md) for how these were built: Claude Code configured as a development platform with hooks, agents, memory, and automated checks.

*MIT licensed, except `nexus/` which is proprietary and documentation-only.*
