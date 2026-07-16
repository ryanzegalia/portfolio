# Nexus: A Revenue-Operations Platform for a Multi-Brand Hardware Manufacturer

Nexus is the revenue-operations platform for a multi-brand B2B/B2C hardware manufacturer (~20-50 employees, international distribution) whose product line spans four brands. It started in late December 2025 and has run in production since February 2026. It was built by one person at the company, alongside non-engineering duties, using Claude Code as the primary development environment.

The platform is organized as four layers, each independently defensible:

1. **Ingestion and integration.** 15 external HTTP integrations sync the hosted ERP (orders, fulfillments, inventory, purchase orders, catalog), the support desk, Moosend email marketing, FedEx, USPS and Shippo shipping, Avalara tax, and Monday.com, plus a custom Windows desktop connector.
2. **Customer data foundation.** A governed PostgreSQL mirror of every customer and contact, with probabilistic identity resolution (Splink) and deduplication.
3. **Intelligence.** Customer-360 and order-360 views, a product knowledge system, demand forecasting (built and backtested, not yet activated in production), sales-trends and profitability reporting, live cart telemetry with visitor presence, and a storefront analytics console with session-to-order revenue attribution.
4. **AI-agent tool layer.** 117 MCP tools that expose every layer above to LLM agents, with read-only SQL enforced at two layers and writes gated behind explicit approval.

## By the numbers

All numbers are code-verified or live-DB-verified in [METRICS.md](METRICS.md), as of 2026-07-09:

- **43,000+ customers** and **117,000+ contacts** in the governed mirror
- **109,000+ orders** and **719,000+ fulfillments** ingested from the ERP
- **268 PostgreSQL tables** across the ingestion, foundation, and intelligence layers
- **117 MCP tools**, read-only SQL enforced at two layers
- An **identity spine** resolving contacts to **~29,500 persons** across **~8,200 household clusters**
- **15 external HTTP integrations** across ERP, shipping, tax, email, and project management

As supporting detail, the API tier is about **150,000 lines of Python** across roughly **160 service modules** and **~850 route decorators**, re-measured 2026-07-09. Each service is a distinct integration or operational domain: Nexus replaces 15 disconnected systems and the manual work that used to bridge them.

## Documentation map

- [ARCHITECTURE.md](architecture/ARCHITECTURE.md): architecture and data flow across the four layers.
- [SYSTEMS_OVERVIEW.md](architecture/SYSTEMS_OVERVIEW.md): domain map, heartbeat cadences, database zones, and the sales-trends and product knowledge systems.
- [TECH_STACK.md](architecture/TECH_STACK.md): every technology, with rationale.
- [METRICS.md](METRICS.md): canonical numbers with verification methods.
- [UI_ARCHITECTURE.md](architecture/UI_ARCHITECTURE.md): the vanilla-JavaScript operations dashboard.

## Some meaningful decisions

The [decisions/](decisions/) folder documents decisions that were meaningful enough to write down. A few:

- [ADR-002](decisions/002-postgresql-migration-with-sqlite3-compat-shim.md): move ~200 call sites from SQLite to PostgreSQL without a rewrite, via a sqlite3-compatible wrapper over psycopg2.
- [ADR-005](decisions/005-circuit-breakers-on-external-apis.md): a circuit breaker on every external call, so one broken dependency does not cascade.
- [ADR-008](decisions/008-per-product-operation-locks.md): per-product locks with a bounded LRU cache, so parallel operators do not corrupt the same product.
- [ADR-016](decisions/016-sse-post-dual-path.md): SSE progress streaming with a blocking-POST fallback on pool exhaustion.
- [ADR-022](decisions/022-python-27-bridge-isolation-via-http-subprocess.md): isolate a Python 2.7 radio library behind an HTTP subprocess.
- [ADR-012](decisions/012-claude-code-as-primary-dev-environment.md): Claude Code as the primary development environment.

## Case studies

Deep dives on the platform's most critical subsystems:

- [Pricing automation](case-studies/pricing-automation.md): manual pricing collapsed to a review-and-apply workflow with layered concurrency defense.
- [Tax reconciliation](case-studies/tax-reconciliation.md): monthly reconciliation across Avalara, the ERP, and payment records.
- [QC tracking](case-studies/qc-tracking.md): a quality-control system with a triage queue and live inventory ledger.
- [Customer and catalog dedupe](case-studies/customer-catalog-dedupe.md): grouping duplicate customers and catalog entries at mirror scale.
- [Identity resolution](case-studies/identity-resolution.md): the Splink-based spine that clusters contacts into persons and households.
- [Demand forecasting](case-studies/demand-forecasting.md): a seasonal-curve model built and backtested, staged ahead of activation.
- [Cart telemetry and consent editing](case-studies/cart-telemetry-consent-editing.md): live cart and visitor presence with consent-aware handling.
- [Storefront analytics and attribution](case-studies/storefront-analytics-attribution.md): the telemetry read surface, and matching anonymous sessions to orders without identity tracking.
- [The MCP agent layer](case-studies/mcp-agent-layer.md): the platform exposed to AI agents behind read-only SQL and gated writes.

## The connector

The [connector/](connector/) is a Windows desktop application that ships to customers as a signed executable. It pairs a Python 3 Flask UI with a Python 2.7 bridge for 802.15.4 radio communication with wireless hardware modules, syncs passively back to the main API, and recovers from bridge failures on its own. See [ADR-022](decisions/022-python-27-bridge-isolation-via-http-subprocess.md).

## How the work gets done

Claude Code is the primary development environment. Architecture, data models, and behavior are specified up front; Claude Code then writes code, runs tests, and iterates against that specification. The build process is documented in [METHODOLOGY.md](../METHODOLOGY.md). Every number here is verified against code or the running system, not against prior documentation, because documentation drifts and the code is canon.

## About

Ryan Zegalia is a Senior Creative Content & Web Manager at the company. Nexus is the engineering work built alongside that role, which also covers operational coordination, campaign launches, warehouse oversight, and marketing for four brands. A live architecture walkthrough is available on request.

## A note on the code

The code is the company's intellectual property and lives in a private repository. Everything in this folder is an authentic representation of a system that runs in production today, documented in enough detail to verify the work without the source.

*See [LICENSE.md](LICENSE.md) for usage terms.*
