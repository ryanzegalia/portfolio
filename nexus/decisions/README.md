# Engineering Decisions

Architectural decisions documenting the context, choice, alternatives evaluated, and consequences for each. Organized by domain.

## Data Pipeline & Sync
- [003 Nightly Full-Refresh](003-nightly-full-refresh-alongside-delta-sync.md): safety net for silent ERP corrections
- [004 Smart Column Resolver](004-four-tier-smart-column-resolver.md): fuzzy matching for unstable CSV exports
- [006 Checkpoint Sync](006-checkpoint-based-incremental-sync.md): resume from where you left off
- [013 Heartbeat Cadences](013-heartbeat-cadence-selection.md): 5-min to nightly, why each interval
- [020 Activity Feed](020-sync-changelog-as-cross-cutting-activity-feed.md): single audit table across all services

## Pricing & Operations
- [001 Build vs Buy](001-custom-python-over-workflow-tools.md): when custom code beats workflow tools
- [008 Operation Locks](008-per-product-operation-locks.md): bounded LRU concurrency
- [010 Deal Drift](010-deal-drift-scrape-over-rest-api.md): scraping when REST falls short
- [011 Price Queue](011-three-state-price-queue.md): queued/applied/verified write-back
- [016 SSE + POST](016-sse-post-dual-path.md): real-time streaming with POST fallback
- [017 Race Conditions](017-sale-revert-race-conditions-and-dedup.md): six-layer defense
- [025 Non-Critical Writes](025-non-critical-write-classification.md): fire-and-forget for analytics

## Shipping & Tracking
- [009 Shipping API Fallback](009-carrier-api-fallback-for-mid-access-control.md): deadline-driven carrier migration
- [018 Tiered Polling](018-tiered-polling-for-multi-carrier-shipment-tracking.md): urgent/active/dormant cadences

## Tax & Compliance
- [015 the tax engine Read-Only](015-tax-engine-reconciliation-read-only-pattern.md): free reads, no write-back
- [024 CSV Injection](024-csv-export-injection-prevention.md): formula sanitization

## Infrastructure & Migration
- [002 PostgreSQL Migration](002-postgresql-migration-with-sqlite3-compat-shim.md): zero-rewrite migration via compat shim
- [005 Circuit Breakers](005-circuit-breakers-on-external-apis.md): 10-error threshold across all integrations
- [007 Startup Recovery](007-startup-recovery-for-background-services.md): dependency-ordered replay
- [014 Redis Shared State](014-redis-for-cross-worker-shared-state.md): cross-worker rate limits + sessions
- [019 Schema Migrations](019-idempotent-schema-migrations.md): inline ADD COLUMN IF NOT EXISTS
- [026 VPS Sizing](026-vps-sizing-for-sale-day-traffic-spikes.md): swap + gthread workers after sale-day incident
- [027 Backup Gap](027-postgresql-backup-gap-during-migration.md): discovered and fixed post-migration

## Security & Quality
- [021 Pre-Deploy Audit](021-pre-deployment-security-audit-pattern.md): parallel agent review before every deploy
- [023 Code Signing](023-azure-trusted-signing-over-ov-ev-cert.md): Azure Trusted Signing over traditional certs

## Frontend
- [028 Vanilla JS](028-vanilla-js-es-modules-over-framework.md): 56 pages, no framework, no build step
- [029 Shell Component](029-custom-element-shell-for-consistent-chrome.md): native Web Component for shared chrome
- [030 Diagnostic Capture](030-passive-diagnostic-capture.md): 460-line client-side recorder
- [031 Design Tokens](031-css-custom-properties-single-design-token-source.md): CSS custom properties as single source

## Connector / IoT
- [022 Python 2.7 Bridge](022-python-27-bridge-isolation-via-http-subprocess.md): subprocess isolation for the radio library
- [032 Bridge Watchdog](032-bridge-watchdog-and-dual-layer-auto-recovery.md): dual-layer auto-recovery
- [033 Heartbeat Protocol](033-dmcast-rpc-rejection-mcast-rpc-heartbeat.md): heartbeat protocol selection
- [034 Module Queue](034-tiered-module-polling-queue-for-rf-scaling.md): HOT/WARM/COLD scaling
- [035 Version Chain](035-product-version-linked-list-for-erp-duplication.md): linked list for ERP duplication

## Development Tooling
- [012 Claude Code](012-claude-code-as-primary-dev-environment.md): agentic development as primary workflow