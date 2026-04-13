# ADR-020: `sync_changelog` as the Cross-Cutting Activity Feed
## Context

By early 2026, Nexus had 12+ services writing to the database concurrently -- heartbeats, user-triggered routes, scheduled pipelines, manual admin actions. Each service had its own idea of what an "event" was. Some logged to stdout, some logged to per-service tables, some did not log at all. The dashboard's activity feed was stale -- it had been built around nightly CSV imports and only showed data when someone manually ran `build_db.py`.

The operator needed one place to answer: "what is the system doing right now, across all domains?" Not twelve different places per domain.

## Decision

**One table.** Every service that changes a business entity writes a row to `sync_changelog`. The table captures: `entity_type` (the domain), `entity_id` (the specific entity), `field_name` (which attribute changed), `old_value` and `new_value` (before and after), `trigger_source` (which service caused the change), `sync_id` (linking multiple diffs from the same run), and `created_at`.

A second table, `api_health_log`, records parallel operational events -- which service ran, how long, with what outcome, how many records touched. The two correlate by timestamp but have different lifecycles: `sync_changelog` answers "what changed in the business?" and `api_health_log` answers "what did the system do operationally?"

Every service writes to both -- one row per operational run in `api_health_log`, one row per field-level change in `sync_changelog`. The Activity Feed on the dashboard reads from `api_health_log` for the top-level summary and drills into `sync_changelog` for specific field-level changes.

## Alternatives Considered

- **Per-domain audit tables.** Rejected because the cross-domain timeline is what the operator actually needs. Joining 12 audit tables by timestamp to reconstruct "what happened in the last hour" would be slow and require every new service to extend the join.

- **External event bus** (Redis Streams, Kafka, RabbitMQ). Rejected as over-engineering for a single-box deployment. A broker would add operational complexity, deployment surface, and latency -- for a feature that needs "append to audit table" semantics, not "fan out to N subscribers." If the system ever needs fan-out, the broker can be added on top of `sync_changelog` without replacing it.

- **Structured logging only** (loguru writing to stdout/files). Rejected because the dashboard needs to SQL-query the events -- filter by entity, drill into specific changes, correlate by timestamp. Files are write-oriented; `sync_changelog` is a proper read-queryable store.

- **Trigger-based audit** (Postgres triggers firing automatically on every update). Rejected because the application layer has more context than the trigger layer -- the application knows which operator ran the command, which trigger source (heartbeat vs. user vs. admin), and what the semantic change was. Triggers would capture less.

## Consequences

**Good:**
- One `SELECT` reconstructs a chronological event timeline across pricing, QC, logistics, tax, and email. No joins.
- New services cost zero integration effort -- they call the same `_record_sync_changelog()` helper, pass their `entity_type` and `trigger_source`, and show up in the activity feed automatically.
- The `trigger_source` field makes it possible to answer "what did the nightly sync do?" or "show me everything the pricing service touched today" without changing any code.
- The drift detection system writes to `sync_changelog` too, so critical-field deal changes appear in the same feed as product updates and order imports.
- The separation of `sync_changelog` (business events) from `api_health_log` (operational events) means two audiences get what they need without one table trying to serve both.

**Bad / costs:**
- `sync_changelog` grows unbounded without retention. A pruning step was added to the nightly sync pipeline -- 90-day retention, pruned nightly.
- The table can become noisy. Early heartbeats wrote one row per field, which meant a product with 20 fields changing logged 20 rows. Later refinements grouped related fields under one `sync_id` so the feed presents them as a single event.
- Some services wrote richer entries than others. The activity feed overhaul in early 2026 retrofitted weaker services to match a gold-standard pattern (e.g., "Order #12345: 3 items -- 1 backordered" instead of "312 updated"). Maintaining this quality bar is ongoing.
- Writing to both `sync_changelog` and `api_health_log` from every service is boilerplate. Extracted into helper functions (`log_sync_change`, `log_api_health`) but it is still two function calls every heartbeat makes.

`api/services/activity_summary.py` (1,436 lines) is the NLG layer that reads `api_health_log` and renders human-readable summaries for the dashboard. `api/services/sync_report_service.py` (504 lines) interprets `sync_changelog` field diffs into business events with CRITICAL/NOTABLE/ROUTINE/SILENT severity tiers. Every heartbeat in `api/services/*_heartbeat.py` imports from `api_health_service` and writes to `sync_changelog` at the end of each run.
