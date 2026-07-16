# Local LLM Summarization Pipeline

A GPU-scheduled inference pipeline that runs a local language model on a single consumer GPU and arbitrates access between interactive and batch workloads under real, sustained load.

## Architecture

Serving centers on a 27B-parameter model, quantized so it fits within a single consumer GPU's VRAM, served by vLLM. A custom scheduling proxy sits in front and implements a single-GPU priority lease queue: foreground interactive callers rank above background batch callers, so an interactive request is not stuck behind a long batch job on shared hardware.

The lease model has two shapes. Exclusive leases are for raw-GPU jobs that need the whole card: they drain VRAM and stop the inference server for the duration. Advisory leases are for inference-dependent jobs that still want the model available: they keep the server warm and signal intent without evicting it. Matching the lease type to the job avoids paying a cold model reload when a job only needs coordination rather than the whole GPU.

## Scale

The pipeline backs automated summarization and semantic retrieval over a development-history knowledge base of more than 40,000 records (40,696 as of 2026-07-09), fed by a GPU-gated observation worker that runs a multi-job nightly sweep, deferring while interactive work holds the GPU. Throughput is measured rather than theoretical: a single background caller has pushed 18,000 to 22,000 inference calls per day through the shared backbone, alongside interactive traffic on the same GPU.

## Reliability

Arbitration held under load. When a low-priority batch caller saturated the queue, the scheduler de-prioritized and paused it in favor of foreground workers, which is the designed behavior (observed July 2026). A priority lease queue is worth building only if it actually yields the GPU to interactive work when the two collide, and it did.

Monitoring later caught a failure the dashboard was hiding. An embedding worker had been down for about a week while the dashboard reported it idle, and 3,899 records went unembedded in that window. After the backfill, the gap was closed with a self-healing watchdog that auto-restarts the worker when embedding lag passes 1,000 records, defers while the GPU is in active use so it does not fight a running job, and applies a cooldown between restarts. An alert backstop sits behind the watchdog as a belt-and-suspenders second line, so a silent-idle failure surfaces even when the auto-restart cannot resolve it on its own.

## Operations

The serving stack was migrated from Ollama to vLLM by blast radius rather than all at once. The lowest-risk caller moved first as a canary. The hottest caller was gated on 24 or more hours of clean traffic from the earlier movers before it was cut over. Ordering the migration by risk kept a bad cutover from taking down the callers that mattered most.

A post-migration tuning pass (July 2026) found the server running without CUDA graph capture: an alternative attention backend, added earlier for other reasons, was silently blocking it. Removing that backend restored graph capture and roughly doubled sustained decode throughput, to about 63 tokens per second on the same hardware and model. The lesson matches the rest of this page: the regression was invisible until throughput was measured against what the hardware should deliver, not against what it delivered yesterday.