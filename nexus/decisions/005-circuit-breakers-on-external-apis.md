# ADR-005: Circuit Breakers on Every External API Call

## Context

An external API outage revealed that heartbeat services had no failure throttling. Without a circuit breaker, a service that encountered errors would keep hammering the endpoint at its regular cadence, accumulating hundreds of failed requests before anyone noticed.

## Decision

Every heartbeat service maintains a `_consecutive_errors` counter. After 10 consecutive errors, the heartbeat calls `service_flags.disable_service('<service_name>')`, which writes to a file-backed flag visible across all Gunicorn workers atomically. A log entry at WARNING level announces the trip. The disabled service stops running until explicitly re-enabled through the service flags admin page.

The check happens at the top of every heartbeat loop iteration:

```python
if is_service_disabled(self.name):
    time.sleep(self.interval)
    continue
```

A successful run resets the counter. Intermediate backoff starts at 3 consecutive errors -- the service doesn't immediately disable, it first slows its cadence: `min(consecutive_errors * 60, 600)` seconds.

The pattern was retrofitted across all 9 heartbeat services during February-March 2026.

## Alternatives Considered

- **Fixed retry count with exit on failure.** A heartbeat that exits after one broken run leaves a data freshness gap that takes an operator to notice and restart. The service needs to keep running (keep its counter, keep checking flags) even when tripped, so it can resume automatically if the flag is toggled back.

- **Exponential backoff without a kill switch.** Backoff alone handles transient errors but not sustained ones. After hours of broken state, the backoff interval gets long but never zero. A kill switch plus a visible WARNING is better -- the operator gets notified, not just the log file.

- **Health check before every call.** The regular call IS the health check; counting consecutive failures captures the same information for free. A separate pre-call health probe adds a round-trip for no additional signal.

- **Per-service hard-coded thresholds.** 10 is a default that every service shares. No service has ever needed to override it.

## Consequences

The 293-consecutive-error incident would trip at error 10 instead of error 293. API quota is protected, log noise is reduced, and the operator is alerted at a reasonable point rather than discovering it days later.

File-backed flags are cross-worker visible and restart-proof. A service that was tripped before a Gunicorn reload stays tripped after -- no accidentally re-enabling broken services on restart.

Circuit breaker trips are observable in `api_health_log` because the disable call writes a row there too. The dashboard renders a "disabled services" banner without any extra instrumentation.

The threshold of 10 is a judgment call. Too low and a spike of transient errors could trip a healthy service; too high and the bombardment continues longer than necessary.

Re-enabling a tripped service requires a human. No automatic recovery based on "wait 1 hour and try again." This is deliberate -- an operator should decide when the upstream is fixed, because the operator can tell the difference between "the API is back" and "the API is giving a different error now."