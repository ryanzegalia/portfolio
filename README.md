## [GTM Scenarios](portfolio/) · [ryanzegalia.com](https://ryanzegalia.com)

Operator scenarios across five B2B verticals, each with a worked example running against seeded Postgres data. The scenarios are grounded in named industry research; the data is deterministic seed, the SQL and computation are real.

## [Nexus](nexus/)

Integration and automation platform for a B2B/B2C manufacturer. Connects ERP, tax, shipping, email, and project-management systems. Documentation only: architecture decisions, component breakdowns, and case studies. No source code published.

## [The Bethl'mite](bethlemite/)

Source excerpt from an event-management system I built for a monthly print postcard listing local concerts and events. Multi-role portals (crew, venue, distributor), drag-and-drop issue builder with print-run inventory tracking, and a content-locking lifecycle. Node.js/Express + React + SQLite.

## [Meeting Recorder](meeting-recorder/)

Source excerpt from a real-time audio capture and AI-processing pipeline I built for meetings and gaming sessions. Per-process audio isolation via WASAPI Process Loopback, local GPU transcription via WhisperX, and a multi-pass AI pipeline that turns long gaming sessions into structured campaign chronicles. Python desktop daemon + web dashboard.

## [JobRadar](jobradar/)

Source excerpt from a job-discovery and application-generation pipeline spanning two machines. Multi-source scraper, staged scoring pipeline (keyword gate + LLM gatekeeper), and a Claude-powered application generator with company-research caching. FastAPI + PostgreSQL + React.

## [Infrastructure (Homelab)](homelab/)

Self-hosted service stack on a single machine with self-healing monitoring, automated GPU transcoding, and nightly disaster-recovery backups. Docker (WSL2), NSSM services, PowerShell automation, FastAPI microservices, Caddy reverse proxy.

---

## Other Projects

Small tools and experiments, not documented in depth:

- **Phillies Hat Tracker** · Superstition tracking app syncing game results from the MLB API. FastAPI + React.
- **Boys Trip** · Airbnb listing price monitor with calendar sync, background checking, and OAuth. FastAPI + React + Docker.
- **Smart Strip** · TP-Link Kasa smart power strip controller with per-outlet monitoring. FastAPI + vanilla JS.
- **Gaming Rig Dashboard** · Real-time GPU/CPU monitoring pulling from LibreHardwareMonitor and Kasa APIs. FastAPI.

---

*MIT licensed, except `nexus/` which is proprietary and documentation-only.*
