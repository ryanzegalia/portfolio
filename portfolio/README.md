# GTM Scenarios

| Stack | Verticals | Demos | Tests | Compute modules | Reconciler modules |
|-------|-----------|-------|-------|-----------------|--------------------|
| FastAPI + Postgres + Jinja | 5 | 15 | 66 | 12 | 4 |

A portfolio project by [Ryan Zegalia](https://www.linkedin.com/in/ryan-zegalia-6bbb90217/). Fifteen operator scenarios across five B2B verticals, each with a worked example running against seeded Postgres data. Each one starts from a specific operator problem, and the matching component is a real server-rendered UI over real SQL.

## The five verticals

Each vertical follows the same shape: the three scenarios, the research that grounds them, what's computed at request time, and the specific files to inspect.

### SaaS Revenue Operations · [`/saas`](https://ryanzegalia.com/saas)

**Scenarios.** Phantom Seats, Stale PQL, Forecast Variance.

**Research grounding.** Hightouch on reverse-ETL for SaaS GTM; Attio + Hightouch on product data in the CRM; HubSpot on seat billing mechanics; Stripe on metered billing and usage records; OpenView on Product-Qualified Lead workflows; dbt on warehouse-native incremental models.

**What's computed at request time.** Phantom Seats reconciles a HubSpot contact list against seeded product-activity data and estimates ARR drift in dollars. Stale PQL scores PQL events against AE-follow-up recency. Forecast Variance computes pipeline coverage, AE hygiene, and commission audit exceptions from seeded deal data.

**Code to inspect.** [`packs/saas/`](packs/saas/) (data + scenario YAML), [`compute/forecast_variance.py`](compute/forecast_variance.py), and the shared [`reconciler/`](reconciler/) engine.

### Home Care Operations · [`/home-care`](https://ryanzegalia.com/home-care)

**Scenarios.** The 6am Call-Off, The EVV Triple Mismatch, The Stale Care Plan.

**Research grounding.** CMS on FY 2025 Medicaid improper payments; AxisCare and Careswitch on agency scheduling; LifeWorx on LTC insurance assessment process; FLTCIP (Federal LTC Insurance Program) on carrier-side documentation rules; Ankota on state-by-state EVV mandated vendors; CMS on the Electronic Visit Verification requirement itself.

**What's computed at request time.** The 6am Call-Off ranks available caregivers for an unfilled shift by client history, proximity, certification, and fairness rotation. The EVV Triple Mismatch reconciles Sandata EVV against WellSky schedule and care plan and categorizes discrepancies by dollar impact. Stale Care Plan detects acuity drift from shift-note keyword frequency and surfaces drift patterns for a clinical liaison to act on.

**Code to inspect.** [`packs/home_care/`](packs/home_care/), [`compute/call_off.py`](compute/call_off.py), [`compute/evv_mismatch.py`](compute/evv_mismatch.py), [`compute/care_plan_drift.py`](compute/care_plan_drift.py).

### Vertical AI GTM · [`/vertical-ai`](https://ryanzegalia.com/vertical-ai)

**Scenarios.** Account Hierarchy Resolver, System-of-Record Detection, Per-Location ROI.

**Research grounding.** Becker's Dental reporting on 200+ DSO affiliations; Florida Division of Corporations (Sunbiz) for corporate-parent resolution; Heartland Dental practice locator; Henry Schein One (Dentrix) and Patterson Dental (Eaglesoft) as the two dominant dental practice-management systems; Practice Analytics on multi-PMS integrations.

**What's computed at request time.** The Account Hierarchy Resolver runs an enrichment waterfall to resolve dental practices to their parent DSO with a confidence score. System-of-Record Detection classifies each practice's PMS vendor from web signals (source-code scans, job postings, vendor case studies, patient-portal subdomain patterns). Per-Location ROI computes multi-location case-acceptance lift against pre-deployment baselines and generates a renewal brief.

**Code to inspect.** [`packs/vertical_ai/`](packs/vertical_ai/), [`compute/per_location_roi.py`](compute/per_location_roi.py), and [`reconciler/matcher.py`](reconciler/matcher.py) for the hierarchy-resolution logic.

### Software Supply Chain Compliance · [`/sca`](https://ryanzegalia.com/sca)

**Scenarios.** The Multi-Threaded Deal, The Compliance Event Trigger, The Repo Coverage Gap.

**Research grounding.** Snyk on Open Source Security / SCA product design; FOSSA on license compliance; the EU Cyber Resilience Act official text; the PCI DSS 4.0 Resource Hub; Gartner Magic Quadrant for Application Security Testing; CISA on Software Bill of Materials (SBOM) requirements.

**What's computed at request time.** The Multi-Threaded Deal detects where an eng/legal/security thread has stalled while another is moving, using stage-gap math against a shared deal record. The Compliance Event Trigger decays regulatory-deadline and M&A signal scores over time so urgent items float to the top. The Repo Coverage Gap reconciles repos scanned versus repos in scope and computes expansion ARR for the unscanned remainder.

**Code to inspect.** [`packs/sca/`](packs/sca/), [`compute/multi_thread_deal.py`](compute/multi_thread_deal.py), [`compute/compliance_trigger.py`](compute/compliance_trigger.py), [`compute/repo_coverage.py`](compute/repo_coverage.py).

### Wholesale Distribution · [`/distribution`](https://ryanzegalia.com/distribution)

**Scenarios.** The ERP Detection Problem, The Proof-of-Value Pipeline, The PE Trigger Window.

**Research grounding.** Proton.ai practitioner writing on sales-force demographics, software implementation as change management, and rep adoption gates in distribution; Epicor industry content on the distribution-ERP landscape; research on PE ownership signals that open 90-day buying windows.

**What's computed at request time.** ERP Detection classifies each prospect's ERP vendor from transactional and behavioral signals with a confidence score, so reps qualify the right demo track. The POV Pipeline tracks active proof-of-value trials with live metrics and flags ones that have gone cold. The PE Trigger Window applies exponential decay to acquisition-driven buying signals so outreach fires inside the window instead of after it closes.

**Code to inspect.** [`packs/distribution/`](packs/distribution/), [`compute/erp_detection.py`](compute/erp_detection.py), [`compute/pov_pipeline.py`](compute/pov_pipeline.py), [`compute/pe_trigger.py`](compute/pe_trigger.py).

## What's mocked, what's real

Short answer: the data is generated from YAML seed files at startup, everything downstream of the data is real SQL against real Postgres.

A note on framing: each scenario is a sketch of how a sensible operator would start building if they joined a team working on the problem, not a claim about how the industry already works. Where scenarios touch regulated workflows, the system surfaces evidence for a human in the right role to act on. The home care Stale Care Plan scenario is explicit about this: the shift-note synthesizer flags drift patterns for an agency's clinical liaison, it does not draft the LTC reauth itself (LTC carriers send their own nurse to do that assessment).

## Architecture

One Python codebase, five "packs" loaded at startup from `packs/{saas,home_care,vertical_ai,sca,distribution}/`. Each pack is a directory of YAML (entities, sources, seed data, scenario definitions) plus the same scrollytelling landing template parameterized by `pack.landing.sections`. Route handlers and context loaders are pack-agnostic, scenario-specific content lives in YAML. Adding a sixth vertical is a new directory, not a new code path.

See [`packs/loader.py`](packs/loader.py) for the pack dataclass and validation rules.

## Liveness

`GET /api/health` returns the real startup state, not just "HTTP server is up":

```json
{"status":"ok","packs":["distribution","home-care","saas","sca","vertical-ai"],"seeder_ok":true,"scheduler_ok":true}
```

Returns 200 when both the seeder and the background stuck-detector are running. Returns 503 when either is degraded, so external monitors get a machine-readable signal instead of "the TCP socket answered."

## Source files

| File | What it shows |
|------|---------------|
| [app.py](app.py) | FastAPI entry, startup sequence, seeder + scheduler wiring |
| [packs/loader.py](packs/loader.py) | YAML-driven pack system with entity/source/seed/scenario validation |
| [reconciler/matcher.py](reconciler/matcher.py) | Entity resolution: natural-key fast path with rapidfuzz fallback |
| [reconciler/drift.py](reconciler/drift.py) | Pairwise field-level drift detection, idempotent drift events |
| [compute/](compute/) | 12 request-time computation modules (one per scenario demo) |
| [tests/](tests/) | 66 tests covering compute math, reconciler round-trips, pack loading, route smoke |

## Tests

```bash
pip install -r requirements-dev.txt
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB} pytest -q
```

66 tests covering compute math, reconciler round-trips, pack loading, and route smoke. The full suite requires Postgres (reconciler round-trips use SAVEPOINT-based fixtures). Compute and pack tests run without a database if you only want a quick sanity check.
