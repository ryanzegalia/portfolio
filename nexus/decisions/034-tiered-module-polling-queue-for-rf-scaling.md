# ADR-034: Tiered Module Polling Queue (HOT/WARM/COLD) for RF Scaling

## Context

The current heartbeat uses `mcast_rpc` broadcast (see [ADR-033](033-dmcast-rpc-rejection-mcast-rpc-heartbeat.md)), which works reliably for up to ~25 modules per channel and network group per 400ms response window. Past that, 802.15.4 CSMA/CA collision avoidance fails -- too many modules try to respond at the same time, responses collide, and channel utilization collapses.

Most customers today run 6-15 active modules. A few run 20-25. Growth is real -- large industrial wireless shows run 50-100 modules. The current heartbeat isn't ready for that scale, and redesigning it during a show would be the worst time to discover the limit. The solution has to be designed now, validated with smaller module counts, and ready to activate when needed.

Early testing revealed that without lifecycle-aware polling, modules could be re-enriched dozens of times per cycle under RF congestion.

## Decision

Build a tiered module polling queue in `connector/app/module_queue.py` (258 lines) that tracks every module's lifecycle stage, classifies it into a polling tier, and schedules polls at tier-appropriate cadences.

Every module progresses through a defined stage state machine:

```
DISCOVERED -> DATA_CAPTURE -> SCORED -> UPGRADE_QUEUE -> UPGRADING -> VERIFIED -> COMPLETE
```

Any stage can reset to DISCOVERED (the universal reset). Transitions are validated -- you can't skip from DISCOVERED to COMPLETE without going through the intermediate stages.

Each stage maps to a polling tier:

| Tier | Stages | Poll frequency |
|---|---|---|
| **HOT** | DISCOVERED, DATA_CAPTURE, UPGRADING | Every cycle |
| **WARM** | SCORED, UPGRADE_QUEUE | Every 3rd cycle |
| **COLD** | VERIFIED, COMPLETE | Every 10th cycle |

Modules actively needing data capture or firmware updates are polled frequently. Modules that have completed their work drop to COLD tier and consume almost no RF airtime.

When module counts exceed the `mcast_rpc` ceiling, the tier system activates unicast batches for HOT-tier modules: individual `rpc` calls in batches of 3, with 300ms between batches. Deterministic, zero collisions, scales to 100+ modules. The unicast primitive has been validated against real hardware in isolation. The switchover from broadcast to unicast is a cadence and primitive change, not a redesign.

The re-enrichment flooding bug was fixed by replacing the callback-based marker with an `enrichment_attempted` flag set at the start of enrichment (not at completion). Under RF congestion, dropped callbacks stop retriggering enrichment. Re-enrichment cycles dropped from 44 to 6 per 5-minute window.

## Alternatives Considered

- **Flat polling (no tiers).** What the original heartbeat did. Works at low scale; breaks at scale because all modules compete for airtime regardless of what they're doing.

- **Configurable per-module cadence.** Lets operators manually choose how frequently to poll each module. Rejected because the lifecycle stage is a better proxy for what actually matters -- modules that are actively being enriched need frequent polls; modules at rest don't, regardless of operator preference.

- **Event-driven updates (modules push state to the bridge).** 802.15.4 modules in the current firmware don't have that capability. Would require firmware changes, which are out of scope.

- **Single HOT tier, no WARM/COLD.** Simpler but wastes airtime on modules that don't need it. The tier structure is worth the complexity -- especially when airtime is the binding constraint.

## Consequences

The current heartbeat works unchanged at today's scale. The tier system is additive infrastructure, not a rewrite of what's already working. Switchover to unicast for HOT-tier is a single-release change when needed. Time-series telemetry comes as a side effect -- the tier queue syncs module state every 30 seconds from the bridge, making battery drain trends, signal strength over time, and upgrade progress all plottable.

The costs: 258 lines of state machine logic that doesn't actively matter until scale increases -- the unicast path is tested but not continuously exercised in production, so a latent bug could exist until activation. The tier mapping is static; modules can't dynamically adjust their own tier based on observed behavior. Seven SQLite tables support the queue state machine, all of them on the customer PC, and the schema evolves -- which means migrations have to happen on customer machines without breaking in-flight data. This is handled via the same `IF NOT EXISTS` migration pattern used in the main API.