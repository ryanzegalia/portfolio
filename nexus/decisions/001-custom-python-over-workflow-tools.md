# ADR-001: Build vs. Buy for Workflow Automation
## Context

Every time a new internal automation need came up -- sync the ERP to Nexus, reconcile tax data, scrape PO pages, push pricing updates, monitor deal drift -- the question was whether to use a low-code tool or write it in code.

Workflow tools exist for this category of work but weren't evaluated formally. The decision was driven by control and ownership, not a feature comparison. Years of working with the ERP taught the cost of being dependent on another company's pricing, token limits, and feature gaps. Owning the code was preferred over paying for a platform that might not do what was needed when the requirements got specific.

## Decision

Nexus automations are custom Python code. `erp_rest_client.py` talks to the ERP directly via `requests.Session`. `pricing_service.py` implements its own concurrency control. `tax_recon_service.py` has its own four-tier column resolver. `deal_heartbeat.py` scrapes HTML with BeautifulSoup. The 9 heartbeat services are `threading.Thread` loops that can be modified without waiting on a vendor.

This is the foundational decision the other ADRs in this set build on. Circuit breakers, checkpoint sync, SSE + POST dual paths, per-entity operation locks, idempotent schema migrations -- these are patterns that emerged from building in an environment where arbitrary code could be written.

## Alternatives That Exist

Tools like Clay, n8n, Zapier, Make, and Pipedream exist for this category of work. The requirements included continuous background polling, multi-step state machines, per-entity concurrency locks, and fuzzy column resolution -- complexity that favored custom code over visual workflow builders.

Contracting out the work to an agency was also considered. This was rejected because handing over a workflow playbook means locking in that vendor as the maintenance channel. Any future change goes through the same contractor, and over time the system's evolution becomes constrained by the contractor's availability and priorities.

## Consequences

**Good:**
- Full control over every primitive. When the system needed circuit breakers, they were written. When it needed a 4-tier column resolver, it was written. No vendor limits what's possible.
- Cost scales with usage, not per-credit. The [tax reconciliation pipeline](../case-studies/tax-reconciliation.md) costs whatever the tax engine charges for API calls (zero for reads). On a per-credit platform, the same run would consume thousands of credits.
- The codebase is legible. A Python service is a single self-contained file. Python scales as a medium for complex logic in a way that visual workflows don't.

**Bad / costs:**
- Every automation takes longer to build initially. The first version of "poll this API every 5 minutes" is a dozen lines in a workflow tool and a hundred lines in Python. If the operation stays simple forever, a workflow tool wins on initial speed.
- Every line is owned. No SLA, no vendor support. When something breaks, it gets fixed in-house. More control in exchange for more responsibility.
- Non-engineers cannot modify the automations. A workflow tool is editable by an analyst with a couple hours of training. A Python service isn't. Mitigated because the operations team has a dashboard UI for day-to-day work, but handoff to non-engineering staff would be costly.
