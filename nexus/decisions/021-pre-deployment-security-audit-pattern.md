# ADR-021: Pre-Deployment Security Audit Pattern
## Context

Nexus ships to production weekly, sometimes more often. Each deploy may include 10-50 commits touching dozens of files across services, routes, frontend, and database schemas. Manually reviewing every change against a security checklist before every deploy does not scale -- and a review that does not scale is a review that gets skipped.

The risk profile is concrete. Nexus handles tax data, customer payment records (Stripe CSVs), order data, PII, and has ~600 API routes that accept user input. A single SQL injection, auth bypass, or CSV formula injection could leak customer data or corrupt production records.

One deploy had ~25,000+ lines changed across API services, frontend components, heartbeat workers, sync pipelines, event management, and database scripts.

## Decision

**Run an agentic security audit before every production deploy.** The audit is a parallel review across five dimensions, each handled by a dedicated agent:

1. **API security** -- SQL injection, parameterized queries, auth decorator coverage, rate limit placement, exception message leakage.
2. **Data path integrity** -- race conditions, transaction safety, idempotency, schema drift between inline DDL and reference files.
3. **Frontend XSS** -- escaping, innerHTML usage, template injection, content security.
4. **Secrets hygiene** -- hardcoded credentials, .env leakage, API keys in logs, Content-Disposition filename sanitization.
5. **Accessibility + UX blockers** -- ARIA attributes, focus management, keyboard nav (treated as part of the audit because accessibility regressions are a real cost even if they are not strictly "security").

Results are consolidated and triaged by severity:
- **S1/A1 -- CRITICAL.** Block the deploy. Fix before shipping.
- **S2/A2 -- HIGH.** Fix within this deploy or create an explicit exception.
- **S3/L3 -- MEDIUM.** Log as follow-up, ship if no S1/S2.
- **INFO -- LOW.** Noted in the audit report, not blocking.

False positives are explicitly called out and dismissed in the audit report.

## Alternatives Considered

- **Manual checklist review.** What the system originally relied on. Does not scale past ~20 commits per deploy. Gets skipped when time-pressured. Is only as good as the reviewer's mental model of every possible attack vector.

- **Automated SAST tools** (Bandit, Semgrep, Snyk). Used as a starting point but they generate a high rate of false positives for Nexus's code patterns (the `PgConnection` shim confuses static analyzers; inline `CREATE TABLE IF NOT EXISTS` looks like a migration smell to tools that expect Alembic). The agentic approach supplements static analysis by understanding the codebase's own conventions.

- **Block deploys without a clean audit report.** Considered but rejected as too rigid. Some S3 findings are genuinely low-priority and should not block a deploy that has business value. The triage step is important.

- **Skip audits for small deploys.** Every "small" deploy is someone's excuse to skip the process. Explicit rule: every production deploy runs the full audit, even single-commit hotfixes.

## Consequences

**Good:**
- Catches real issues before they reach production. Pre-deployment audits have flagged CSV formula injection risks (see ADR-024), overly verbose error responses, and missing rate limits -- exactly the class of problems the audit pattern is designed to catch.
- Parallel agent execution makes the audit fast. Five agents running concurrently across tens of thousands of lines of changes finishes in minutes instead of hours.
- Every audit produces a triaged report that goes into the plan archive. Every production deploy has an associated audit report showing exactly what was reviewed and what was deferred.

**Bad / costs:**
- Writing the audit prompts is real work. Each agent needs clear scope, known false-positive patterns, severity criteria, and a structured output format.
- The audits are AI-driven, which means they inherit whatever blind spots the underlying model has. A novel attack vector that the model has not seen is not caught. This is mitigated by pairing the agents with established static analysis tools, but the gap is not zero.
- Every deploy has pre-deploy friction. Shipping a hotfix is not just "git push" -- it is "run the audit, triage findings, ship." For genuine emergencies this is overhead, but the emergencies are rare enough that the friction is worth paying.

Every audit produces a plan file documenting: what changed since the last deploy (commit range), what was reviewed (file list by agent), findings by severity, fixes applied in-session, and follow-up items for the next sprint. The artifact can be read back months later to understand what was checked on a given deploy and what was deferred.
