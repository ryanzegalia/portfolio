# Local AI Infrastructure

Three services that turn a workstation GPU into a metered, scheduled, observable substrate for AI workloads. Built around heavy daily Claude Code use — to bound API spend, attribute it where it actually goes, and stop concurrent local-LLM workloads from thrashing each other on a single 32 GB GPU.

## Why I Built It

The story is sequential, not designed-up-front:

1. **Claude API spend was unbounded.** Every Claude Code session was generating knowledge-graph observations via headless Claude calls — a workload that's batchy and tolerant of latency. I moved it onto a local Ollama model (qwen3.5:27b) to make those calls free.
2. **I had no idea if it was actually saving money.** Local inference isn't visible to any cost dashboard. I built TokenBurn to attribute every token across both lanes (Claude API and local GPU), normalize local cost to a Sonnet-equivalent USD figure, and unify it with the per-tool / per-MCP / per-project breakdown from Claude Code's OpenTelemetry export.
3. **One GPU, multiple callers, no coordination.** Once dictation polish, observation generation, JobRadar scoring, and overnight backfill all started competing for the same 32 GB, the GPU thrashed — models got evicted mid-call, latency spiked, alerts fired for things that weren't actually broken. I built a priority-aware Ollama proxy so live work always preempts batch work, with starvation protection so backfill jobs eventually finish.

## Architecture

```text
   Claude Code session ends
          │
          ▼
   Stop hook (lightweight POST, never blocks Claude)
          │
          ▼
   ┌──────────────────────┐
   │ ObsWorker (FastAPI)  │  queue + GPU gate +
   │  :8700               │  3-layer safety rails
   └──────────┬───────────┘
              │ batched when GPU is free
              ▼
   ┌────────────────────────┐    ┌─────────────────────┐
   │  GPU Scheduler          │◄──┤ Other callers       │
   │  (Ollama proxy :11435)  │   │ dictation polish,   │
   │  per-model heapq        │   │ JobRadar scorer,    │
   │  priority + starvation  │   │ summarizers, etc.   │
   └──────────┬─────────────┘    └─────────────────────┘
              │ priority dispatch (10=live → 1=backfill)
              ▼
   ┌──────────────────────┐
   │  Ollama :11434       │     gpu_usage table
   │  qwen3.5:27b + 3.2:3b │──►  (per-call, dedup'd)
   └──────────────────────┘            │
                                       ▼
                              TokenBurn :8600
                              Claude API + local GPU
                              unified dashboard
```

## ObsWorker

Replaced a blocking 30-120s headless-Claude call inside Claude Code's Stop hook with an async queue + batch pipeline. The hook now POSTs a transcript byte range and returns instantly; observations get generated later, in batches, when the GPU isn't busy with live work.

- **Stop-hook offset queue** with atomic offset writes (tmp + os.replace) — a crash mid-write can't corrupt the offset file.
- **Three-layer prompt-size safety**: the scheduler edge-rejects oversized prompts (HTTP 413), an in-flight stall watchdog with util-gated suppression catches non-size hangs without firing on legitimate slow generations, and an `oversized` terminal queue state keeps poison items out of the retry loop.
- **Crash recovery**: rows stuck in `processing` for >10 min are reset to `pending` on service start, and a 2-min zombie watchdog catches the same case while the service is running.
- **Retriable queue with exponential backoff**: Ollama transients become `mark_retriable` with `next_retry_at = now + min(60·2^retries, 3600)`; cap of 5 retries, then permanent fail. Backoff is enforced on read, not just write.
- **Parse-rate observability**: rolling last-50 metrics on `/api/health` flag Ollama output drift before it shows up as missing observations.

## TokenBurn

Single dashboard reconciling Claude API spend (from Claude Code's OpenTelemetry export + JSONL session transcripts) with local Ollama spend (from the `gpu_usage` table). Same view, comparable numbers.

- **Dual ingest**: live OTel/HTTP sink writes per-signal JSONL; a backfill walker re-tokenizes 9k+ historical session JSONLs against a mirrored pricing table. Idempotent on `request_id` / `tool_call_id`.
- **Cost normalization**: local model calls are priced as their Claude-tier equivalent (`qwen3.5:27b → claude-sonnet-4-6`) so the "what would this have cost on Claude" number is a single multiplier away — change the mapping, no re-backfill needed.
- **Per-tool / per-MCP / per-project breakdown**: tool-call spans from OTel feed a horizontal-bar view of where tokens actually go (top tools, MCP server frequency, project cost).
- **Daily cost-regression alert**: cron job flags >50% jumps in $/1k output, single sessions over $15, single calls over $5, and tool-concentration thrash above 40% of daily calls — one consolidated Discord message, silent on quiet days.
- **Refresh hardening**: an earlier `wscript → cmd → node` chain spawned 200+ orphaned codeburn workers when scans exceeded Task Scheduler's `ExecutionTimeLimit`. Replaced with a PowerShell wrapper that self-polices (skip-if-running, hard timeout, kill-tree on timeout).

## GPU Scheduler

FastAPI proxy in front of Ollama, drop-in for any caller — they just point their Ollama base URL at `:11435` and tag themselves with an `X-GPU-Usage-Caller` header. The proxy serializes contention per model and arbitrates by priority.

- **Per-model `asyncio.Semaphore` with heapq dispatch**: different models run concurrently, same-model requests queue. Priority is enforced at *dispatch* time, not enqueue time — a late-arriving high-priority request can't get stuck behind a popped-but-not-dispatched lower-priority one.
- **Starvation guard**: pending entries older than 5 min get `priority += 1` per sweep — pri-1 backfill always finishes eventually, even under sustained pri-9 traffic.
- **Model-eviction monitoring**: a list of expected-resident models is checked against `/api/ps`; missing >60s fires a CRITICAL Discord alert with recovery INFO when the model returns.
- **Util-gated stall watchdog**: 5-min in-flight alerts only fire if the GPU has *also* been idle in a 30s window (sampled via `nvidia-smi` every 5s) — eliminates false positives during legitimate slow generations under VRAM pressure. Fail-open on a broken sampler.
- **Prometheus `/metrics`** + per-caller p50/p95/p99 in `/api/stats` (DB-backed, survives proxy restarts). 7-test pytest suite covering priority ordering, timeout, header overrides, inflight cap, queue shape, and metrics format.

## Tech Stack

| Layer | Tools |
|-------|-------|
| Services | FastAPI on Python, NSSM-wrapped as Windows services |
| Local LLM | Ollama (qwen3.5:27b primary, llama3.2:3b co-resident) |
| Telemetry | OpenTelemetry (HTTP/OTLP), local sink to JSONL |
| Tokenization | tiktoken `cl100k_base` (5% delta vs qwen ground truth) |
| Storage | SQLite (`gpu_usage`, `claude_usage`, `tool_usage`, `obs_queue`) |
| Metrics | Prometheus text-format `/metrics` for Grafana |
| Alerting | Discord webhooks via dispatcher, two-channel mirror to log |
| Tests | pytest + httpx MockTransport (no live GPU) |
| Dashboards | Vanilla JS, polled, cross-linked between three services |

## Key Decisions

- **Local GPU for displaceable work, not all work.** Latency-tolerant batch jobs (observation generation, summarization, scoring) move to local Ollama. Latency-sensitive work (Claude Code itself, dictation polish) stays where it should. The scheduler's priority table is the encoding of that decision.
- **A proxy, not direct Ollama calls.** Centralizing scheduling, observability, and cost attribution at one chokepoint means new callers cost ~10 minutes (point Ollama URL at `:11435`, set a header, register in the priority table). The pre-scheduler version had every caller writing its own gating and accounting — the rewrite cost less than the duplicated logic was already costing.
- **Per-model heapq, not global FIFO.** Mixed workloads (large-context model + small dictation model) shouldn't head-of-line-block each other. Different models dispatch concurrently; same-model requests serialize behind a priority queue.
- **Self-gates as sanity floors, not coordination.** Callers that try to coordinate via their own GPU-util threshold (e.g. "skip if util > 70%") defeat the priority system because the request never reaches the scheduler. Caller self-gates are now sized to catch "GPU truly wedged" (95% util, 500 MB free, 80°C), not normal contention. Coordination is the proxy's job.
- **Cost normalization stays in display, not storage.** `gpu_usage` rows store raw tokens + the equivalence model used at write time. Re-pricing is a query, not a backfill.
