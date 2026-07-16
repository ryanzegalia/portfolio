# Data Pipeline: Game-Metadata Enrichment

Notes on a game-metadata enrichment pipeline running on a home Linux server. It stores records in SQLite in WAL mode so the churn process can keep writing while readers and the live curation pass run concurrently without lock contention, schedules that churn through systemd for automatic restart and timer-driven runs, and routes LLM enrichment through a shared local GPU backbone it can yield under contention. Enrichment is organized as a phased "gene" model: ownership enrichment, catalog sweep, guides, series/franchise, aliases, verification, a canary stage, and ratings.

## Scale, stated honestly

Tracked records peaked near 44,000 (44,351 exported 2026-07-09). A same-day curation pass then pruned 12,298 non-English placeholder rows, bringing the live set to about 32,000 records. That prune ran against the live pipeline using chunked commits, with no lock errors and no downtime, so the count reflects records worth keeping rather than a headline number inflated by placeholders.

## Verification: generate with the model, decide with code

The verification layer follows one rule: the LLM generates, deterministic code decides. A 4-rule deterministic verifier graded 3,528 LLM-generated series assignments. About 98% were confirmed high-confidence, and 67 were quarantined rather than deleted, so a questionable assignment is held for review instead of silently dropped. The verifier caught real hallucinations, including a title assigned to the wrong franchise, which is the failure mode a purely generative pass would have shipped.

## Fail-closed canary exports

Exports are gated by a canary stage that computes error, parse, and abstention rates over a trailing window. On a breach it writes a breach marker, and the exporter refuses to ship past that marker, so the consuming device keeps its last-known-good data instead of receiving a bad batch. An explicit override environment variable is the escape hatch when a human decides to ship anyway. The first live reading over 20,000 rows recorded 0% errors, 100% parse success, and 7.9% abstention.

## Resumable sidecar backfills

New metadata genes are added as sidecar tables, each with a standalone, resumable backfill script. That design let about 14,750 already-processed records gain a new gene without re-running the expensive LLM pass over the whole set. A backfill that stops partway can pick up where it left off rather than starting over, which matters when a single full pass is the costly part.

## Operations

A nightly WAL-safe hot backup feeds the records into an offsite chain, and a weekly audit timer runs automatically. Both were newly instituted in July 2026. The pipeline registers as the lowest-priority caller on the shared GPU scheduler, and it was throttled and paused under contention exactly as designed, yielding the GPU to higher-priority work rather than competing for it.

The pattern across the pipeline is the same: let the model produce candidates, then let deterministic checks and fail-closed gates decide what actually reaches the device.