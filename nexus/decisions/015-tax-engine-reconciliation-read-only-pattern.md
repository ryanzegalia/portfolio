# ADR-015: the tax engine Reconciliation as a Read-Only Consumer

## Context

the tax engine is the company'ss tax processor. It calculates sales tax on every order, files returns with state tax authorities, and maintains the authoritative tax ledger. Nexus needs tax data for reconciliation: matching what the ERP charged customers against what the tax engine calculated and remitted. Discrepancies between these two numbers are the whole point of the reconciliation system.

The accounting team lead's monthly process involved manually exporting four reports (the ERP Orders, the ERP Returns, the tax engine Transactions, Stripe Payments), cleaning columns, pasting into a state-by-state Excel template, and comparing the ERP (what was charged) vs the tax engine (what was remitted). The goal was to eliminate the manual export step.

The key discovery during planning: the tax engine API provides free unlimited reads.

## Decision

**Nexus reads from the tax engine. Nexus never writes to the tax engine.** the tax engine remains the authoritative source of truth for tax data; Nexus is a reconciliation consumer.

Concretely:
- `tax_engine_heartbeat.py` polls `GET /transactions` every 5 minutes via checkpoint delta, fetching only new transactions since the last successful sync.
- `avalara_sync_service.py` provides higher-level sync operations (import historical transactions, backfill date ranges).
- When a new tax engine transaction arrives, the heartbeat creates the ERP stub record locally and enriches it via the ERP REST API. This gives reconciliation both sides (the tax engine + the ERP) without consuming the ERP license seat.
- The reconciliation view is built entirely at read time -- no pre-computed join or denormalized mirror.

The reconciliation requires two separate sources: the ERP is the source of truth for what was charged to customers. the tax engine is the source of truth for what tax was calculated and remitted. Discrepancies between these two are what the system is looking for.

If Nexus wrote back to the tax engine, it would be "correcting" one side of the comparison against the other -- hiding the discrepancies instead of surfacing them. The entire value proposition would break.

## Alternatives Considered

- **Write back to the tax engine when discrepancies are found.** Rejected because discrepancies are the signal, not the bug. Correcting them silently would mean Nexus is deciding which system is right, which it is not qualified to do. Discrepancies go to the accounting team lead for human review.

- **Mirror the tax engine's data into Nexus as the new authoritative ledger.** Rejected because the tax engine IS the authoritative ledger for tax filing. Mirroring would create two sources of truth. Nexus's job is to reconcile, not to replace.

- **Use the tax engine's CSV export endpoint instead of the REST API.** Rejected because the REST API is free unlimited reads and returns cleaner data than the CSV (no pre-header metadata rows, no column drift). The four-tier column resolver handles the Stripe and the ERP CSVs, but the tax engine goes through the API.

- **Poll less often.** The 5-minute cadence is arbitrary. At "free unlimited reads," there is no reason to make it longer -- the heartbeat pattern requires an interval anyway.

## Consequences

**Good:**
- The accounting team lead's month-end process dropped from approximately one week to approximately one day. Four manual CSV exports replaced by two automated sources.
- Zero risk of Nexus accidentally corrupting the tax engine's tax ledger. There is no write path to corrupt.
- The free-reads economics mean there is no reason to cache or coalesce -- poll as often as the heartbeat pattern requires.
- The reconciliation view is always live. Reading from `tax_recon_records` gives the current state of both sides of every transaction.

**Bad / costs:**
- Nexus cannot fix the tax engine discrepancies automatically. Every discrepancy requires a human to decide which side is right. In practice there are relatively few discrepancies per month across the full transaction history, so this is not a burden.
- The "free unlimited reads" assumption is vendor-controlled. If the tax engine ever starts metering reads, the 5-minute cadence becomes expensive.
- The reconciliation logic (matching the tax engine transactions to the ERP orders, handling refunds and cancellations) lives entirely in `tax_recon_service.py`. All of that complexity is Nexus's responsibility because the tax engine does not help with the comparison.

Current implementation: `api/services/tax_engine_heartbeat.py` polls `GET /transactions` only; no POST/PUT/DELETE calls exist anywhere in the codebase. Reconciliation UI surfaces discrepancies for human review with no auto-correction path.
