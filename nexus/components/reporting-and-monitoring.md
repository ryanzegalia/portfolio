# Reporting and Monitoring
> Part of the Nexus production automation platform

Turns raw sync events into human-readable activity feeds and system health reports.

Three services turn raw sync events into human-readable activity feeds and system health reports.

## What it is

The observability layer -- not infrastructure monitoring (that is handled by external tools and the dashboard system.html page), but the business-event reporting that shows operators what happened across all 18 heartbeats, all ~975 routes, and every long-running operation.

## Files

| File | Lines | Role |
|---|---|---|
| `api/services/activity_summary.py` | **1,436** | Pure-logic NLG engine. Transforms raw heartbeat results into human-readable one-liners and structured detail JSON for the Activity Feed. |
| `api/services/sync_report_service.py` | 504 | Transforms raw `sync_changelog` entries into business-meaningful events with severity classification, NLG summaries, and attention items. |
| `api/routes/v1/sync_log.py` | 945 | Sync monitoring + changelog viewer route handlers. Filter by service, date range, entity type. |
| `api/routes/v1/system.py` | 1,214 | System dashboard -- backup history, storage analytics, deployment history, config status, 90-day heatmap for service health trends. Admin-only or API-key auth. |
| `api/routes/v1/analytics.py` | 441 | Dashboard usage analytics (pageviews, top pages, API traffic). |

## Scale

- **`activity_summary.py` is 1,436 lines of NLG** -- turning structured data into natural sentences like Order #12345: 3 items (a standard connector product x1, Case x2) -- 1 backordered
- **4 severity tiers** in `sync_report_service`: CRITICAL, NOTABLE, ROUTINE, SILENT
- **90-day heatmap** on the system health page for service trend visualization
- **Alerting is narrow by design** -- a morning digest reports every service's overnight outcome, and a page goes out only on conditions where a person has to act. A second machine watches the platform from outside and emails if it goes quiet, and the platform pages if that outside watcher dies. There is no general pager integration beyond that.

## Key Decisions

- **NLG in pure Python, not templates.** `activity_summary.py` is deliberately imperative -- it reads the raw data, inspects it, and constructs a sentence based on what it sees. Template-based NLG (Jinja, string formatting) was tried and found too rigid. Pure code lets the summarizer handle edge cases (missing fields, unexpected values, aggregation of multiple events) without forcing every summary to fit a template.
- **Severity tiering in the reporter, not in the heartbeat.** Heartbeats write raw facts to `sync_changelog`. The reporter reads those facts and assigns severity based on content -- a deal change to a critical field is CRITICAL, a price change within expected bounds is ROUTINE, a successful sync that found zero changes is SILENT (logged but not displayed). Separating facts from severity lets the severity rules evolve without re-ingesting data.
- **Parallel to sync_changelog.** `api_health_log` captures operational events (service X ran, took Y seconds, touched Z records). `sync_changelog` captures business events (this specific field changed from A to B). The reporter correlates them. See [ADR-020](../decisions/020-sync-changelog-as-cross-cutting-activity-feed.md).
- **System dashboard is admin-only.** `system.html` shows internal metrics that regular users do not need -- backup history, deployment timeline, Gunicorn worker status. The route handler checks for admin role before returning data.

## Integration Points

**Reads from:**
- `sync_changelog`, `api_health_log` (the two audit tables)
- `user_activity` (for analytics)
- `backup_history`, `deployment_history` (for system dashboard)

**Writes to:** Nothing (pure read-and-render layer).

**Outputs:**
- Activity Feed (main dashboard landing)
- Sync Log page (filtered changelog viewer)
- System Health page (admin-only)
- Analytics page (admin-only)
- Morning digest email (severity-graded overnight outcomes, delivered daily)
