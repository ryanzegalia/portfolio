# Case Study: Equipment Testing & QC Tracking

## Problem

The company tests **10,000+ wireless units per year** across multiple product lines. A previous developer had built a standalone Android app for the warehouse team to use during testing, but when that developer left the company, the app was never updated. It eventually stopped working and the team went back to manual testing with paper records.

Without structured tracking, managers couldn't see throughput trends, couldn't assign targeted work, and couldn't intervene when a specific tester or product line was falling behind. When a customer reported a failed unit in the field, tracing it back to the specific test session and tester was effectively impossible.

## Approach

The solution has two parts:

**Wireless BLE Tester (Connector)** -- the hardware-facing application that runs on warehouse PCs. It communicates with wireless units over BLE, runs configurable test sequences, and records pass/fail results. This is the hands-on tool the warehouse team uses daily. Results sync back to the Nexus API.

**QC Tracking Service (Nexus)** -- `qc_service.py` -- the server-side system that manages the full lifecycle: serial-number-tracked equipment intake, test session management with configurable per-SKU test definitions, pass/fail/skip result storage with a running inventory ledger, triage queue for failed units, and manager-assigned work targets with auto-completion. It also provides the forecasting dashboard that shows what needs testing based on incoming inventory, current stock levels, and historical throughput.

All database access goes through the service class -- no raw SQL in route handlers. The **11 interrelated tables** have evolved multiple times (columns added, indexes added, new relationship tables introduced), and not a single route file has changed to accommodate schema changes.

The tested inventory ledger is maintained incrementally, not recomputed. Every pass result increments `qc_sku_counts` via `ON CONFLICT DO UPDATE`. Every fail creates a triage entry automatically. The ledger is live -- no batch job rebuilds it.

Session management handles the "operator forgot to close the session" case. `start_session()` resumes an existing open session if it's less than 24 hours old and belongs to the same user. Sessions older than 24 hours are auto-abandoned with `overall_result='ABANDONED'` before a new one is created, preventing ghost sessions from contaminating throughput stats.

Manager work assignments auto-complete. When a pass test fires for a SKU that has an active assignment for the same tester, `completed_count` increments automatically and the assignment status flips to 'completed' when the target is reached. No scheduled job checks assignments -- they update themselves as testing happens.

Every session completion writes to `sync_changelog` with `entity_type='qc_event'`, so QC throughput surfaces in the same activity feed as order events, pricing changes, and shipment updates.

## Technical Highlights

- **Two-layer architecture** -- BLE hardware tester (Connector) for hands-on testing, server-side service (Nexus) for tracking, forecasting, and assignment
- **11 QC-specific tables** handling the full equipment lifecycle from intake through triage
- **Service-layer-only database access** -- schema evolution doesn't touch route code
- **24-hour session resume with auto-abandon** -- prevents ghost sessions from contaminating stats
- **Incremental inventory ledger** -- `ON CONFLICT DO UPDATE` on every pass; triage insert on every fail; never a batch rebuild
- **Assignment auto-completion** -- work targets update themselves as tests fire, no scheduled job required
- **Forecasting dashboard** -- tracks incoming inventory, current tested stock, and historical throughput to help warehouse managers prioritize testing
- **Cross-cutting activity feed integration** -- every session completion appears in the same `sync_changelog` feed as pricing, orders, shipments, and heartbeats

## Outcome

**10,000+ units** tracked per year through the full lifecycle. **500+ hours per year saved** (3 minutes saved per unit across 10,000+ units). Before the system, each unit involved manual data entry -- serial number, test result, notes, disposition -- on paper. After, the operator connects via BLE, runs the test sequence, and taps pass/fail; the system handles the rest.

The failed unit triage queue is now actionable. Every failed unit has a disposition (retest, repair, scrap) tracked in the database, assigned to a specific person, with a status lifecycle. Manager assignment targets update themselves as testing happens -- managers see progress in real time instead of asking at end of day. The tested inventory ledger is live, so the warehouse team can see tested-and-ready unit counts per SKU without running a report.

See also: [ADR-019: Idempotent schema migrations](../decisions/019-idempotent-schema-migrations.md), [ADR-020: sync_changelog as cross-cutting activity feed](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md).
