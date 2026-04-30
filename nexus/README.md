# Nexus: Production Automation Platform

## At a Glance

| Metric | Value |
|---|---|
| Python (API layer) | ~79,000 lines |
| Services | 58 modular services |
| Database tables | 145 |
| Background heartbeats | 9 (5-min to nightly cadences) |
| External integrations | 15 (REST, GraphQL, HTML scraping, webhooks) |
| Flask routes | ~600 |
| Dashboard | 56 pages, 31 JS modules |

## Overview

Nexus is the integration layer for the company, a mid-size B2B/B2C electronics manufacturer. The company uses separate systems for ERP, e-commerce, email marketing, project management, and shipping. Nexus connects those systems, automates operational workflows that used to be manual, and provides team-specific tools through a browser-based dashboard.

## By Domain

### Data Pipelines
- [Checkpoint Sync](decisions/006-checkpoint-based-incremental-sync.md) -- resume from where you left off
- [Nightly Full-Refresh](decisions/003-nightly-full-refresh-alongside-delta-sync.md) -- safety net for silent ERP corrections
- [Smart Column Resolver](decisions/004-four-tier-smart-column-resolver.md) -- 4-tier fuzzy matching for CSV imports
- [Column Resolver Demo](examples/column_resolver.py) -- runnable Python implementation
- [Heartbeat Services](components/heartbeat-services.md) -- 9 background sync services

### Pricing Operations
- [Pricing Automation](case-studies/pricing-automation.md) -- **2+ days -> ~3 hours**
- [Operation Locks](decisions/008-per-product-operation-locks.md) -- bounded LRU concurrency
- [SSE + POST Dual-Path](decisions/016-sse-post-dual-path.md) -- real-time streaming with fallback
- [Lock Cache Demo](examples/resource_lock_cache.py) -- runnable Python implementation
- [Verify-on-Write Demo](examples/verify_on_write.py) -- runnable Python implementation

### Tax & Compliance
- [Tax Reconciliation](case-studies/tax-reconciliation.md) -- **37,847 transactions** reconciled across 3 systems
- [Tax Engine Read-Only Pattern](decisions/015-tax-engine-reconciliation-read-only-pattern.md) -- free reads, no write-back

### Shipping & Tracking
- [Tiered Polling](decisions/018-tiered-polling-for-multi-carrier-shipment-tracking.md) -- urgent/active/dormant cadences
- [Shipping API Fallback](decisions/009-carrier-api-fallback-for-mid-access-control.md) -- deadline-driven carrier migration
- [Checkpoint Sync Demo](examples/checkpoint_sync.py) -- runnable Python implementation

### QC & Equipment Testing
- [QC Tracking](case-studies/qc-tracking.md) -- **10,000+ units/year** lifecycle management

### IoT / Hardware
- [Connector Overview](connector/README.md) -- Windows desktop app for managing wireless modules
- [Python 2.7 Bridge](decisions/022-python-27-bridge-isolation-via-http-subprocess.md) -- subprocess isolation for the radio library

### Frontend
- [Vanilla JS Decision](decisions/028-vanilla-js-es-modules-over-framework.md) -- 56 pages, no framework, no build step
- [UI Architecture](architecture/UI_ARCHITECTURE.md) -- Web Components, design tokens, SSE

### Internal AI Access Layer
- [Conversational Data Access](components/ai-data-access.md) -- MCP server fronting customer / order / support / email / identity / operations data
- [Read-Only-by-Default Pattern](components/ai-data-access.md#safety) -- multi-layer enforcement separating queries from mutations

### Infrastructure
- [PostgreSQL Migration](decisions/002-postgresql-migration-with-sqlite3-compat-shim.md) -- zero-rewrite migration via compat shim
- [Circuit Breakers](decisions/005-circuit-breakers-on-external-apis.md) -- 10-error threshold across integrations
- [Startup Recovery](decisions/007-startup-recovery-for-background-services.md) -- dependency-ordered replay on restart

## Component Documentation

Detailed documentation for each subsystem:

| Domain | Component |
|--------|-----------|
| Authentication | [Auth & Users](components/auth-and-users.md) |
| ERP Integration | [ERP Integration](components/erp-integration.md) |
| Data Sync | [Microsoft Graph/Excel Sync](components/microsoft-graph-excel-sync.md) |
| Email Marketing | [Email Marketing](components/email-marketing.md) |
| Events | [Trade Show Platform](components/events-platform.md) |
| Compliance | [Hazmat Compliance](components/hazmat-compliance.md) |
| Infrastructure | [Infrastructure & Deployment](components/infrastructure.md) |
| Products | [Product Catalog](components/product-catalog.md) |
| Monitoring | [Reporting & Monitoring](components/reporting-and-monitoring.md) |
| Quality | [Review & Feedback](components/review-and-feedback.md) |
| IoT | [Connector/IoT Server-Side](components/connector-iot-server-side.md) |
| Resilience | [Heartbeat Services](components/heartbeat-services.md) |
| AI Access | [Conversational Data Access](components/ai-data-access.md) |

## Engineering Decisions

[35 decisions](decisions/) organized by domain -- migration, resilience, concurrency, integration, frontend, IoT, security, tooling.

## Code Examples

[4 runnable Python demos](examples/) implementing production patterns from the system. Each runs standalone with `python filename.py`, stdlib only.

## System Documentation

- [Architecture](architecture/ARCHITECTURE.md) -- system diagram, data flow, resilience layer
- [Tech Stack](architecture/TECH_STACK.md) -- technology choices with rationale
- [Systems Overview](architecture/SYSTEMS_OVERVIEW.md) -- heartbeat cadences, three-zone data model
- [Testing & Correctness](TESTING.md) -- why runtime verification, not unit tests
- [Methodology](../METHODOLOGY.md) -- how Claude Code is configured as a development platform: hooks, agents, memory, automated checks

---

Decision records are written when decisions are made, not reconstructed retroactively.

*This portfolio documents architectural decisions and engineering patterns from a proprietary production system. No source code is included. See [LICENSE.md](LICENSE.md) for usage terms.*