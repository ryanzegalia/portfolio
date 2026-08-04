# QC Tracking
> Part of the Nexus production automation platform

Complete lifecycle tracking for hardware quality control -- equipment registration, test session management, pass/fail/skip results, inventory ledger, and triage queue.

An internal quality control tracking system for equipment testing, built to replace manual testing after a previous developer's standalone testing app went unmaintained.

## What it is

A complete lifecycle tracking system for hardware QC: equipment registration by serial number, test session management, per-test PASS/FAIL/SKIP result storage, running inventory ledger of tested-and-passed units, triage queue for failed units, and manager-assigned work targets with auto-completion.

Built for the company's testing volume (warehouse-reported at 10,000+ units a year) with a bounded schema (11 tables) and zero external API dependencies -- fully self-contained. The path the warehouse runs daily today is the wireless module tester feeding `testing_service.py` from the Connector, ~7,900 modules across ~8,100 sessions from February through July 2026; the `qc_service.py` lifecycle (intake, ledger, triage, assignments) is live code on production, seeded with SKU definitions, and is not yet the warehouse's daily path.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/qc_service.py` | 1,885 | The service class -- all DB access for QC workflows, equipment registration, test sessions, triage. |
| `api/services/testing_service.py` | 833 | Parallel abstraction for wireless module testing (BLE-addressed modules from the Connector). |
| `api/routes/v1/qc.py` | 665 | HTTP surface -- equipment scan, session start/end, result submission. |

## Scale

- **~7,900 modules across ~8,100 test sessions** through the live module-tester path (live count, February through July 2026)
- **10,000+ units a year** is the warehouse-reported throughput the savings figure derives from
- **11 QC-specific database tables**: `qc_equipment`, `qc_test_definitions`, `qc_test_sessions`, `qc_test_results`, `qc_tested_inventory`, `qc_sku_counts`, `qc_triage`, `qc_assignments`, `qc_notes`, `qc_prep_counts`, `qc_tracked_skus`
- **17 indexes** created at schema init for serial, MAC, SKU, status, session, and date columns
- **11 SKU variants** across 2 product lines seeded at init time with their test definitions
- **500+ hours/year** labor savings (derived: 3 min saved per unit x the warehouse-reported 10,000+ units / 60)

## Key Decisions

- **Service-layer DB access only.** No raw SQL in route handlers. The module docstring is explicit: *"All DB access goes through here -- no raw SQL in routes."* Decouples route handlers from schema evolution; the 11-table schema can migrate without touching route files.
- **Session resume with 24-hour auto-abandon.** `start_session()` resumes an existing open session if it's less than 24 hours old and belongs to the same user. Sessions older than 24 hours are auto-abandoned with `overall_result = 'ABANDONED'` before a new one is created. Prevents ghost sessions from contaminating stats.
- **MAC/serial mismatch detection.** `register_equipment()` warns on MAC-to-serial reassignment in both directions (`'mac_changed'` and `'serial_changed'` warning codes) but allows the override, logging the change. Idempotent: same serial returns existing record.
- **Inventory ledger via `ON CONFLICT DO UPDATE`.** On every PASS result, `qc_sku_counts` is updated atomically. On FAIL, a triage entry is created automatically. The ledger is never recomputed from session history -- it's maintained incrementally.
- **Assignment auto-completion.** When a PASS test completes and an active assignment exists for that SKU and tester, `completed_count` is incremented and the assignment status flips to `'completed'` when the target is reached. Manager-assigned work tracks itself without a scheduled job.
- **Sync changelog on every session.** Every session completion writes to `sync_changelog` with `entity_type='qc_event'`, surfacing QC throughput alongside order and pricing events in the activity feed. See [ADR-020](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md).

## Integration Points

**Reads from:**
- `qc_equipment` (registered equipment)
- `qc_test_definitions` (what to test per SKU)
- `qc_tracked_skus` (SKU-level demand forecast)

**Writes to:**
- `qc_equipment`, `qc_test_sessions`, `qc_test_results` (lifecycle state)
- `qc_sku_counts` (tested inventory ledger)
- `qc_triage` (failed unit queue)
- `qc_assignments` (work targets)
- `sync_changelog` (activity feed)

**Triggers:**
- Operator scan from `qc-station.html` (the technician-facing page)
- Manager assignment from `qc-manager.html`
- API ingestion from the Nexus Connector (BLE module test results via `testing_service.py`)

## The featured story

See the [QC Tracking case study](../case-studies/qc-tracking.md) for the narrative-voice version.