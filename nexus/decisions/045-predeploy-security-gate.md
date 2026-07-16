# Three-Phase Pre-Deployment Security Gate

**Status:** Accepted | **Date:** 2026-04-28 | **Theme:** process

## Context

An internally built platform maintained by a single operator has no independent second reviewer to catch security and operational-risk issues before they reach production. Ahead of the platform's first production deployment, that gap needed a systematic answer rather than reliance on one person reading their own work. The goal was a repeatable review methodology with severity-graded findings and clear rules for what blocks a release.

## Decision

A three-phase gate runs before deployment: Phase 0 executes automated scans, Phase 1 performs a focused security audit, and Phase 2 conducts an operational-risk review. Findings are graded by severity, with defined consequences: CRITICAL findings block the deploy outright, HIGH findings require an explicit override, and MEDIUM or LOW findings are advisory.

## Alternatives Considered

Ad-hoc review, reading the diff informally before shipping, did not fit this context because a single-operator platform has no independent second set of eyes; the review has to be systematized precisely because it cannot be delegated to a colleague. External audit only, commissioning a periodic third-party assessment, did not fit either: its cadence and cost are mismatched to a platform that deploys continuously, where most changes would ship between audit windows with no coverage at all.

## Consequences

The first run of the gate surfaced five HIGH-severity findings spanning network gating, token storage, cross-worker locking, hardcoded webhook targets, and a fallback secret. All five were remediated, and a second-pass audit found no remaining critical or high-severity findings before the release went to production. The gate remains in place, re-confirmed in July 2026.

The trade-off is a review tax on every deploy: each release pays the cost of running three phases before it can ship. Findings are tracked to closure rather than noted and forgotten, and the block-versus-override semantics force any accepted risk to be explicit rather than absorbed silently. For a continuously-deployed internal platform with one maintainer, that standing cost buys a consistent floor on what reaches production.