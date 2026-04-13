# ADR-033: Library Incompatibility Discovery and Heartbeat Revert

## Context

The SNAP radio bridge uses multicast RPC primitives from the radio library to discover and heartbeat wireless modules. Two related primitives exist: `mcast_rpc`, which broadcasts to all modules on a given channel and network ID with responses collected within a response window; and `dmcast_rpc`, a "directed multicast" that broadcasts to a specific subset of modules and appeared to support per-module response routing via callbacks.

The radio library documentation describes `dmcast_rpc` as the preferred approach for targeted module communication, but testing against real hardware showed it to be unreliable when combined with callback routing. The library vendor created a separate primitive (`dmCallout`) specifically because the `dmcast_rpc + callback()` combination doesn't work. The incompatibility was discovered through testing against real hardware, not documentation review.

## Decision

Revert the heartbeat to `mcast_rpc`, group modules by channel and network ID tuple, and use a 400ms response window per group.

The heartbeat iterates through the known module set, groups by channel and network, and fires one `mcast_rpc` per group. All modules on that group respond within the 400ms window, then the next group runs. For typical deployments of 6-15 modules across a small number of networks, this completes well under a second per full heartbeat cycle.

The scaling ceiling is lower than the directed multicast approach would theoretically provide: `mcast_rpc` starts having collision problems past ~25 modules per group per 400ms window due to 802.15.4 CSMA/CA contention. For current deployments this is fine. For scaling past that ceiling, a tiered unicast approach is already designed and ready to activate -- see [ADR-034](034-tiered-module-polling-queue-for-rf-scaling.md).

The radio library documentation describes `dmcast_rpc` as the preferred approach, but testing against real hardware showed it to be unreliable. The heartbeat uses `mcast_rpc` (broadcast) instead.

## Alternatives Considered

- **Fix `dmcast_rpc` with callback routing.** Not fixable at the application layer -- it's a library-level constraint. The fix would require modifying the radio library itself, which is not viable.

- **Use `dmCallout` instead.** The vendor-recommended replacement for the incompatible combination. Rejected because module firmware version compatibility is uncertain across the hardware in the field, and validating it against all deployed hardware versions represents significant test effort. `mcast_rpc` is proven and consistent.

- **Roll a custom multicast implementation.** Implement the low-level 802.15.4 primitives directly. Months of work, high risk. Not viable.

- **Accept the scaling ceiling.** Current module counts are well below the ceiling. When scaling becomes a real concern, the tier-based polling queue from `module_queue.py` is the right path -- not a different multicast primitive.

## Consequences

Heartbeats work reliably for current scale -- all modules respond every cycle. The fix shipped in one commit. Reverting to the previous known-good primitive is the lowest-risk path when a library incompatibility is discovered through testing.

The failed experiment also inadvertently validated the tiered polling queue as the right long-term answer for scaling -- even if the directed multicast had worked, it would have been the wrong abstraction for scaling past ~25 modules because the constraint is broadcast contention in a shared RF channel, not routing efficiency.

Costs: two weeks of unreliable heartbeats during the experiment, with operators seeing module flickering without explanation. The scaling ceiling at ~25 modules means the current approach has a bounded future. And `mcast_rpc` is technically less efficient -- the whole network sees every broadcast even if only some modules are targeted.