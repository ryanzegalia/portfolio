# Tax Reconciliation
> Part of the Nexus production automation platform

Three-way tax reconciliation engine across the tax engine, the ERP, and Stripe with smart column resolution and 50-state nexus exposure tracking.

One of the largest services in the Nexus codebase.

## What it is

A three-way tax reconciliation engine that ingests CSV exports from the tax engine (tax processor), the ERP (order management), and Stripe (payments), resolves column drift across sources using a four-tier smart matcher, persists every import as a change-tracked entity, enriches records against live the ERP and the tax engine APIs, and computes post-Wayfair economic nexus exposure across all 50 states.

Replaces a ~1 week per month manual spreadsheet reconciliation by the accounting team.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/tax_recon_service.py` | **3,906** | The reconciliation engine. Smart column resolver, import upsert with field-level diffs, enrichment, CC matching, nexus exposure queries. |
| `api/services/avalara_sync_service.py` | 656 | the tax engine REST API v2 client. HTTPBasicAuth; GET = free/unlimited. |
| `api/services/tax_engine_heartbeat.py` | 330 | Background poller. 5-minute cadence, checkpoint delta, creates the ERP stubs and auto-enriches. |
| `api/services/tax_cert_service.py` | 902 | Manages tax exemption certificates -- syncs from the tax engine ECM + the ERP, cross-checks for mismatches. |
| `api/routes/v1/tax_recon.py` | 804 | HTTP surface -- CSV upload, reconciliation views, Excel export, review workflow. |

## Scale

- **Tens of thousands of the tax engine transactions** reconciled
- **40+ canonical column names** with hundreds of alias variants in `COLUMN_ALIASES`
- **15 tracked fields** compared on every re-import (`TRACKED_FIELDS`)
- **24 Streamlined Sales Tax states** tracked separately
- **50 states + DC** with per-state post-Wayfair nexus thresholds (with state-specific logic flags like NY AND requirement)
- **13 idempotent schema migrations** inline in the service, each guarded by `ADD COLUMN IF NOT EXISTS`
- **~1 week/month of accounting labor** saved (stakeholder-reported)

## Key Decisions

- **[ADR-004: Four-tier smart column resolver](../decisions/004-four-tier-smart-column-resolver.md)** -- exact -> alias -> fuzzy -> content sniffing. The core innovation that makes the system robust to the ERP/the tax engine/Stripe column renames.
- **[ADR-015: Tax Engine Reconciliation Read-Only Pattern](../decisions/015-tax-engine-reconciliation-read-only-pattern.md)** -- Nexus reads from the tax engine but never writes back. the tax engine is the authoritative tax ledger.
- **[ADR-019: Idempotent schema migrations](../decisions/019-idempotent-schema-migrations.md)** -- tax_recon_service.py established the pattern with 13 inline migrations.
- **[ADR-006: Checkpoint-based incremental sync](../decisions/006-checkpoint-based-incremental-sync.md)** -- tax_engine_heartbeat uses the platform checkpoint pattern.

## Integration Points

**Reads from:**
- the tax engine REST API v2 (`GET /transactions`, `GET /certificates`)
- the ERP REST API (for order enrichment)
- the ERP office backend billing pages (scraped for tax line-item breakdown)
- Uploaded CSV files (the tax engine, the ERP, Stripe -- through the four-tier column resolver)

**Writes to:**
- `tax_recon_records` (entity-based with field-level change tracking)
- `tax_recon_imports` (batch metadata)
- `tax_recon_changes` (field-level diffs on every re-import)
- `tax_recon_reviews` (human review workflow)
- `tax_recon_settings` (configuration)
- `tax_entities` (customer/vendor master)
- `tax_certificates` (exemption certs)
- `sync_changelog` (cross-cutting activity feed)

## The featured story

See the [Tax Reconciliation case study](../case-studies/tax-reconciliation.md) for the narrative-voice version of this component -- the accounting team lead request for something that would just work, the column resolver design, and the 50-state nexus dashboard.
