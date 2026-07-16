# AI Agent Tool Layer (MCP Server)

## Problem

Operating the platform through a chat agent means giving a language model real hands on production data: customer records, order history, pricing, shipments, campaigns, and live database queries. A model that can read broadly and also write freely is a data-loss incident waiting for a hallucinated argument or a misread instruction. The tool layer had to make wide read access safe by default while keeping every mutation behind a gate a confused model cannot walk through by accident.

## Approach

The Model Context Protocol (MCP) server exposes the platform to LLM agents as a catalog of discrete, typed tools: **117 registered tools as of 2026-07-09** (verified by two independent grep patterns against the server source, both returning 117), grown from 20 tools in mid-April 2026 as the platform expanded. The tools span customer-360 and order-360 lookups, identity resolution, product and SKU catalog, pricing history and corrections, shipment tracking and delivery digests, support and ticket history, sales and coupons, events, the warehouse queue, campaign scheduling and stats, email-marketing sync, live read-only SQL, secrets management, and storefront template read/write. The governing rule is uniform across every consumer: **read broad, write gated.** Reads stay open so an agent can answer support and diagnostic questions without ceremony. Writes follow one standard pattern with a confirmation step and a proof-of-effect check, so a mutation is not applied silently. Live SQL is held read-only at two independent layers so a failure in one does not expose write access.

## Technical Highlights

- **Dual-layer read-only SQL (defense in depth).** The client-side tool rejects mutation keywords and auto-applies a LIMIT before a query ever leaves the process. Independently, the Postgres session itself runs with `default_transaction_read_only=on`, in place since the first Postgres backend in April 2026, so even a bypassed client guard cannot write. Two unrelated mechanisms have to fail together for a write to reach the database. See [ADR-043](../decisions/043-dual-layer-readonly-sql.md).
- **Preview-then-confirm writes with read-back as the success condition.** Every write tool is a two-call sequence: a first call returns a preview and a confirmation token, and a second call carries that token to execute. Success is defined by re-reading the written value and comparing it, so a write that does not read back exactly is treated as a failure rather than a success. See [ADR-044](../decisions/044-preview-confirm-write-tools.md).
- **Destructive tools fenced to test accounts.** Operations that cannot be undone, such as order voiding, are restricted to test accounts behind an explicit force gate, so a live account is not reachable through an ordinary tool call.
- **Secrets the model never sees.** The secrets tooling targets an allowlist of servers. Secret values move from the vault to the destination server without being surfaced to the model, with a backup taken before any overwrite and a SHA-256 read-back to confirm the value landed intact.
- **A pre-deployment review gate that blocks on severity.** Deploys pass a three-phase gate: automated scans, then a focused security audit, then an operational-risk review. CRITICAL findings block the deploy and HIGH findings require an explicit override, so a deploy cannot proceed on an unreviewed finding.

## Outcome

The gate has a documented validation win. Before the first production deploy, the review surfaced five high-severity findings spanning network exposure, credential handling, and cross-worker locking. All five were remediated before release, and a second-pass audit then found no critical or high-severity findings before anything reached production (April 2026). The gate remains a standing requirement, re-confirmed on 2026-07-02. The read-broad, write-gated policy applies uniformly across every consumer use case: support lookups, catalog operations, campaign work, and diagnostics. No agent workflow gets a looser rule than another. See [ADR-045](../decisions/045-predeploy-security-gate.md).
