# ADR-006: Checkpoint-Based Incremental Sync

## Context

Nexus syncs from several external systems -- the legacy ERP, the tax engine, Microsoft Graph -- where the authoritative data lives outside Nexus's control. The naive sync strategy is "pull everything, every time." At Nexus's scale (thousands of products, tens of thousands of inventory records, transaction history measured in years), pulling everything every 5 minutes is wasteful -- most records didn't change, the API budget isn't infinite, and the database write volume would saturate Postgres for no value.

The smart strategy is to pull only records that changed since the last successful pull. That requires two things: the source system must expose a "what changed since timestamp X" query, and Nexus must remember the stamp of the last successful pull and resume from there on the next tick. the ERP exposes both -- every record has a `modification_stamp` field, and the REST API accepts a `movement_date` or `last_modified_since` parameter on most endpoints. the tax engine's REST API supports `$filter=modifiedDate ge X`. Microsoft Graph exposes ETag headers on files.

An early bug made the need for correct checkpoint semantics concrete: code that advanced the checkpoint in-memory before the final commit meant a crash between those two moments could lose data permanently. The fix -- advance the checkpoint inside the same transaction as the last row insert -- is now the standard pattern across all sync services.

## Decision

Every sync service owns a checkpoint and advances it only on successful completion.

Each heartbeat service has a `sync_state` row that stores the last successfully-processed stamp. On every tick:

1. Read the current checkpoint from the database.
2. Query the source for records modified since that checkpoint.
3. Process each record (upsert into local tables, compute diffs, write to `sync_changelog`).
4. Advance the checkpoint only after all records are successfully processed. If step 3 fails partway through, the checkpoint stays where it was and the next tick retries from the same point.

This is the "commit checkpoint last" idiom. A partial failure never loses data -- the next run will re-process the records that weren't finished, including ones already handled (which is why every write is idempotent).

## Alternatives Considered

- **Full-refresh every tick.** Wastes API budget and write volume. A nightly full-refresh still runs as a safety net, but the primary cadence is delta-driven.

- **Event-driven sync via webhooks.** the ERP doesn't offer webhooks for the tables Nexus needs, and the tax engine/MS Graph webhook support is limited. Not an option for the primary sync path.

- **Diff against local state on every tick.** Would work but requires reading everything every tick -- same cost as full-refresh. Diffing on the local side doesn't save API calls; it just moves the cost around.

- **Advance the checkpoint after each record instead of after the batch.** A 500-record batch would write 500 checkpoint updates. Advancing only on batch completion is one DB write per tick regardless of batch size.

- **Use UUIDs or last-inserted-row-id as checkpoints instead of timestamps.** the ERP records can be modified without re-assigning their ID. A timestamp-based checkpoint captures modifications; an ID-based checkpoint only captures insertions.

## Consequences

API read volume is minimized. A tick that has nothing new reads 0 records. A busy period reads only the records that changed. Steady-state API costs are near-zero.

Recovery from failure is automatic. A crashed heartbeat resumes from where it left off on the next tick -- no manual intervention, no data loss, no full re-run.

Checkpoint state is durable -- stored in the database, survives process restart, survives server reboot.

The pattern depends on the source exposing a reliable "modified since" query. If the source has silent updates (the ERP does, in some cases), delta sync misses them. The nightly full-refresh is the backstop for that gap.

Clock skew between Nexus and the ERP can cause records to be missed at the boundary. Mitigated by overlapping the delta window slightly (fetch records modified since `checkpoint - 60 seconds`) -- idempotent writes make the overlap harmless.