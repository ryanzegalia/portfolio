# Nexus: Verified Metrics

> This is the canonical home for every Nexus number. Case studies carry their own headline number once; everywhere else links here. Values were verified against code, git history, or the running system. The live snapshot is dated 2026-07-09. Size metrics were re-measured 2026-07-09 using the April 2026 methodology. April 2026 rows that a July number supersedes are marked. Approximations are used except where the exact count is the verified headline. Business-scale counts (customers, contacts, orders, fulfillments, persons) are deliberately rounded in public documentation; exact figures are available on request in an interview setting.

## Platform scale (as of 2026-07-09)

| Metric | Value | As-of / verification |
|---|---|---|
| Customers in the governed mirror | **43,000+** | live DB count, 2026-07-09 |
| Contacts in the governed mirror | **117,000+** | live DB count, 2026-07-09 |
| Orders ingested from the hosted ERP | **109,000+** | live DB count, 2026-07-09 |
| Fulfillments ingested | **719,000+** | live DB count, 2026-07-09 |
| ERP SKUs tracked | **760** | live DB count, 2026-07-09 |
| Production PostgreSQL tables | **268** | schema introspection, 2026-07-09 (supersedes April's 145) |
| MCP tools exposed to AI agents | **117** | grep-verified, 2026-07-09 |
| External HTTP integrations | **15** | enumerated in [TECH_STACK.md](architecture/TECH_STACK.md) |

## Code size (re-measured 2026-07-09, April 2026 methodology)

Size appears only on this page. It is supporting detail; the capability numbers above are the headline.

| Metric | July 2026 | April 2026 | Verification |
|---|---|---|---|
| Python lines (API tier) | **~150,000** | 79,388 | `find api -name '*.py' \| xargs wc -l` |
| Service modules in `api/services/` | **~160** | 58 | `ls api/services/*.py` (excluding `__init__.py`) |
| Flask route decorators | **~850** | 596 | grep `@bp.(route\|get\|post\|put\|delete\|patch)` across `api/routes/` |

The growth from April to July (79,388 to ~150,000 Python lines, 58 to ~160 service modules, 596 to ~850 routes) reflects the four-layer build out: the customer data foundation, the intelligence layer, and the MCP agent layer were all added after the April snapshot.

## Customer data foundation (identity and dedupe)

| Metric | Value | As-of / verification |
|---|---|---|
| Duplicate groups identified | **16,705** | dedupe metric computed 2026-06-15 |
| Address-flag corrections applied | **~31,650** | correction project completed 2026-06-08 |
| Persons resolved (current spine) | **~29,500** | live spine build, 2026-07-09 |
| Household clusters (current spine) | **~8,200** | live spine build, 2026-07-09 |

### Identity spine certification (2026-06-22 build)

The spine uses Splink probabilistic record linkage because customer records arrive from the ERP, the support desk, and email marketing with inconsistent names, emails, and addresses, so deterministic key matching under-merges; probabilistic linkage against a labeled evaluation set is what lets the false-merge rate be measured and held to a threshold. These metrics are from the certified 2026-06-22 build, held to a labeled evaluation set:

| Metric | Value |
|---|---|
| Persons resolved (certified build) | ~27,900 |
| Measured false-merge rate | 0.48% |
| Records definitively known | 88.8% |
| Held-out recall | 86.8% |

## Intelligence layer

| Metric | Value | As-of / verification |
|---|---|---|
| Sales-trends reporting | verified against ~72,000 rows of sales data inside a 1,893-test suite | deployed 2026-07-06 |
| Profitability reporting | 99.5% cost-data coverage on trailing-year revenue; suite grown to 2,182 tests at merge | deployed to production, 2026-07 |
| Demand forecasting shape accuracy | 0.97 seasonal-curve shape correlation on a high-volume SKU | built and backtested; not live (the velocity table held 0 rows on production, 2026-07-09) |
| Live presence capacity | ~1,000 concurrent visitors at 5-8% CPU | capacity analysis, 2026-07-09 |
| Storefront analytics console | 5 tabs over the telemetry store, session-to-order bridge matching inside sub-15-second windows | Phase 1 shipped and audited, 2026-07 |
| Order-tracking API for support automation | verified against 11,000+ live shipment rows, 100% sales-channel coverage | live in production, 2026-07 |
| Product knowledge: spec definitions | 61 | as of 2026-07-09 |
| Product knowledge: provenance-tracked values | 145 | as of 2026-07-09 |
| Product knowledge: compatibility coverage | 57% to 99.6% across product lines | as of 2026-07-09 |

## Business metrics (from running systems)

These come from live databases and operational dashboards. An interviewer who asks for a specific number can be given a read-only query. Values are the April 2026 snapshot unless a newer figure appears above.

| Metric | Value | Source |
|---|---|---|
| Avalara tax transactions reconciled | 37,847 | live count in the reconciliation ledger, April 2026 |
| Units processed through QC tracking (annual) | 10,000+ | live count across the QC tracking tables |
| Product options managed by pricing automation | 800+ | live count in the product options table |
| Products in the e-commerce catalog (active) | 330+ | live count in the products table |
| Major campaign launches coordinated per year | 12-13 | Monday.com marketing board history |
| Annual labor savings from QC tracking | 500+ hours | derivation: 3 min saved per unit times 10,000+ units, divided by 60 |
| Annual labor savings from tax reconciliation | ~1 week per month | stakeholder-reported from the accounting team, not independently verified |

## Git activity (April 2026 snapshot)

Not re-measured in July. Preserved as the April snapshot.

| Metric | Value | Verification |
|---|---|---|
| First commit | 2025-12-23 | `git log --reverse --format=%ad --date=short \| head -1` |
| Total commits (as of 2026-03-30) | 758 | `git rev-list --count HEAD` |
| Commits in the 60 days before the snapshot | 629 (83% of total) | `git log --since='60 days ago' --oneline \| wc -l` |
| PostgreSQL migration | 2026-03-01 | migration commit, see [ADR-002](decisions/002-postgresql-migration-with-sqlite3-compat-shim.md) |

## Resilience patterns (present in code)

| Pattern | Where | Threshold |
|---|---|---|
| Circuit breaker on external APIs | every heartbeat service | 10 consecutive errors, then disable the service |
| Checkpoint-based incremental sync | product, order, and inventory heartbeats | resume from the last successful stamp |
| Nightly full-refresh safety net | `nightly_sync.py` | scheduled overnight, multi-step pipeline |
| Startup recovery | `startup_recovery.py` | replays failed services within 2 hours of restart |
| Per-entity operation locks | `pricing_service._operation_locks` | 500-entry LRU, non-blocking acquire |
| Thundering-herd stagger | all heartbeats | randomized offset on the first tick |

## Superseded and corrected numbers

July 2026 re-measurement, with the April 2026 value each one replaces:

- PostgreSQL tables: **268** (2026-07-09), supersedes 145 (April 2026)
- Service modules: **~160** (2026-07-09), supersedes 58 (April 2026)
- Flask route decorators: **~850** (2026-07-09), supersedes 596 (April 2026)
- Python lines (API tier): **~150,000** (2026-07-09), supersedes 79,388 (April 2026)

Numbers that appear in older documentation and are incorrect: "60+ services", "10+ heartbeats", "60+ tables", "200+ routes", and "SQLite" (migrated to PostgreSQL with PgBouncer on 2026-03-01, see [ADR-002](decisions/002-postgresql-migration-with-sqlite3-compat-shim.md)). Older docs predated the 2026-03-01 database migration and the later four-layer build out. They are preserved as historical artifacts and should not be cited as current.