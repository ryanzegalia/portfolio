# Order-Status Denylist Over Allowlist for Demand Series

**Status:** Accepted | **Date:** 2026-06-20 | **Theme:** data-quality

## Context

Order-status semantics in the ERP are undocumented and were reverse-engineered from data fingerprints. A single status code reliably indicated a closed order; the remaining codes were ambiguous, and new pipeline statuses appeared over time as the ERP evolved.

## Decision

Demand counting uses a denylist of known-bad statuses instead of an allowlist of known-good ones. Any status not on the denylist is counted by default. The switch from allowlist to denylist recovered 9,484 units of real demand that the allowlist had silently dropped from recent months.

## Alternatives Considered

An allowlist of known-good statuses did not fit this context because it under-counts silently whenever the ERP grows a new status, and the ERP's status set is not stable over time. Each new pipeline status stays excluded until someone notices the gap, which is exactly how the 9,484 units went missing. A per-status manual audit cadence was kept as a complement rather than as the filter.

## Consequences

New unknown statuses now default to counted, which changes the failure mode from a silent under-count to a visible over-count. An over-count shows up in reconciliation, so the system fails loud instead of failing silent, and the discrepancy points directly at the unrecognized status. The trade-off is a standing maintenance task: the denylist needs review whenever the ERP adds cancellation-like statuses, since those are the cases where "count by default" is wrong. That review is the deliberate cost of preferring a visible error over an invisible one.
