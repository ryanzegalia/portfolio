"""Pack-aware demo routes — /{pack}, /{pack}/revenue, etc.

Architecture note
-----------------
Every demo has a pure **context loader** (e.g. `saas_phantom_seats_ctx`) that
takes `(db, pack)` and returns the full template context dict for that demo.
Loaders are mount-point agnostic:

  * The standalone sub-page handlers call the loader and spread its result
    into the template context via `**ctx`, keeping per-page template inputs
    byte-identical with the pre-refactor behavior.
  * The scrollytelling landing template will call each loader via the
    `SECTION_CONTEXT_LOADERS` registry and render the demo body partial
    inline, passing the loader's output as a single `ctx` dict inside a
    Jinja `{% with ctx = section.ctx %}{% include section.partial %}{% endwith %}`
    block. See `packs/*/pack.yaml` for the per-pack `landing.sections` config.

Registering a new demo section:
  1. Write the context loader below.
  2. Add it to `SECTION_CONTEXT_LOADERS` with the pack-scoped key the pack
     YAML will reference (e.g. `"saas.phantom_seats"`).
  3. Add a `landing.sections` entry in the pack's `pack.yaml` pointing at
     that loader key and the partial template path.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from config import TEMPLATES_DIR, PLAUSIBLE_DOMAIN
from db import Entity, DriftEvent, get_db
from packs import PACK_REGISTRY, pack_query
from gtm import (
    build_pql_inspector,
    build_enrichment_waterfall,
    build_account_brief,
)
from ai import get_rollup
from filters import attach_filters

log = logging.getLogger(__name__)

router = APIRouter()
templates = Jinja2Templates(directory=TEMPLATES_DIR)
attach_filters(templates)


# ============================================================================
# Canonical scenario ids per pack
# ----------------------------------------------------------------------------
# Cross-checked at startup by packs.loader.validate_pack_registry() — if any
# scenarios.yaml loses one of these ids the container fails to start with a
# clear error, so a content regression can't silently orphan a scenario card.
# Keep in sync with the hardcoded ids in the context loaders below.
# ============================================================================
REQUIRED_SCENARIO_IDS = {
    "saas": ["phantom_seats", "stale_pql", "forecast_variance"],
    "home-care": ["shift_coverage_critical", "evv_triple_mismatch", "care_plan_drift"],
    "vertical-ai": ["account_hierarchy_resolver", "sor_detection", "per_location_roi"],
    "sca": ["multi_thread_deal", "compliance_trigger", "repo_coverage"],
    "distribution": ["erp_detection", "pov_pipeline", "pe_trigger"],
}


# ============================================================================
# Shared helpers
# ============================================================================
def _ctx(request: Request, pack, **extra) -> dict:
    return {
        "request": request,
        "pack": pack,
        "active_pack": pack,
        "plausible_domain": PLAUSIBLE_DOMAIN,
        **extra,
    }


def _get_pack_or_404(pack_id: str):
    pack = PACK_REGISTRY.get(pack_id)
    if pack is None:
        raise HTTPException(status_code=404, detail=f"Unknown pack: {pack_id}")
    return pack


def _find_scenario(pack, scenario_id: str):
    """Locate a scenario dict by id across the tolerated shapes of scenarios.yaml.

    Logs a warning when the lookup misses so a content regression (scenarios.yaml
    typo or removed id) surfaces in container logs instead of silently rendering
    a scenario card without context. The structural check in
    `packs.loader.validate_pack_registry()` runs at startup and is the harder
    failure mode for canonical ids — this log is the runtime backstop.
    """
    scenarios = pack.scenarios
    if isinstance(scenarios, dict):
        # Loader wraps top-level YAML lists as {"_raw": [...]}
        scenarios = scenarios.get("scenarios") or scenarios.get("_raw") or []
    if not isinstance(scenarios, list):
        log.warning(
            "pack %s: scenarios.yaml has unexpected shape (not list), got %s",
            pack.id, type(scenarios).__name__,
        )
        return None
    for s in scenarios:
        if isinstance(s, dict) and s.get("id") == scenario_id:
            return s
    log.warning(
        "pack %s: scenario '%s' not found in scenarios.yaml",
        pack.id, scenario_id,
    )
    return None


# ============================================================================
# Section context loaders
# ----------------------------------------------------------------------------
# Each loader returns the full template context for its demo body. The dict
# is spreadable at the handler level (`**ctx`) for standalone sub-pages and
# passable as a single `ctx` object to the landing page partial includes.
# Do NOT add request-scoped or pack-independent fields here — those belong in
# the handler wrapper via `_ctx()`.
# ============================================================================

# ---- SaaS ------------------------------------------------------------------
def saas_phantom_seats_ctx(db: Session, pack) -> dict:
    """Demo 1.1 — Phantom Seats (HubSpot ↔ BigQuery seat drift with dollar impact)."""
    drift_rows = (
        pack_query(db, DriftEvent, pack)
        .filter(DriftEvent.field_name == "seat_count")
        .filter(DriftEvent.resolved_at.is_(None))
        .order_by(DriftEvent.dollar_impact.desc().nullslast())
        .limit(20)
        .all()
    )

    rows = []
    for d in drift_rows:
        ent = db.get(Entity, d.entity_id) if d.entity_id else None
        rows.append({
            "id": d.id,
            "entity_id": d.entity_id,
            "name": ent.canonical_name if ent else "(unknown)",
            "value_a": d.value_a,
            "value_b": d.value_b,
            "dollar_impact": d.dollar_impact,
        })

    return {
        "rows": rows,
        "aggregate": sum(r["dollar_impact"] or 0 for r in rows),
        "aggregate_account_count": len(rows),
        "scenario": _find_scenario(pack, "phantom_seats"),
    }


def saas_stale_pql_ctx(db: Session, pack) -> dict:
    """Demo 1.2 — Stale PQL (decayed PQLs without AE follow-up)."""
    return {
        "data": build_pql_inspector(db, pack),
        "scenario": _find_scenario(pack, "stale_pql"),
    }


def saas_forecast_variance_ctx(db: Session, pack) -> dict:
    """Demo 1.3 — Forecast Variance (pipeline coverage, AE hygiene, commission audit)."""
    from compute.forecast_variance import build_forecast_variance
    return {
        "data": build_forecast_variance(db, pack),
        "scenario": _find_scenario(pack, "forecast_variance"),
    }


# ---- Home Care -------------------------------------------------------------
def home_care_call_off_ctx(db: Session, pack) -> dict:
    """Demo 2.1 — The 6am Call-Off (ranked caregiver fan-out for unfilled shifts)."""
    from compute.call_off import build_call_off
    result = build_call_off(db, pack)
    result["scenario"] = _find_scenario(pack, "shift_coverage_critical")
    return result


def home_care_evv_mismatch_ctx(db: Session, pack) -> dict:
    """Demo 2.2 — EVV Triple Mismatch (Sandata ↔ WellSky schedule ↔ care plan)."""
    from compute.evv_mismatch import build_evv_mismatch
    result = build_evv_mismatch(db, pack)
    result["scenario"] = _find_scenario(pack, "evv_triple_mismatch")
    return result


def home_care_stale_care_plan_ctx(db: Session, pack) -> dict:
    """Demo 2.3 — Stale Care Plan (acuity drift detected from shift notes)."""
    from compute.care_plan_drift import build_care_plan_drift
    result = build_care_plan_drift(db, pack)
    result["scenario"] = _find_scenario(pack, "care_plan_drift")
    return result


# ---- Vertical AI -----------------------------------------------------------
def vertical_ai_hierarchy_ctx(db: Session, pack) -> dict:
    """Demo 3.1 — Account Hierarchy Resolver (enrichment waterfall + DSO reclassification)."""
    return {
        "data": build_enrichment_waterfall(db, pack),
        "scenario": _find_scenario(pack, "account_hierarchy_resolver"),
    }


def vertical_ai_sor_detection_ctx(db: Session, pack) -> dict:
    """Demo 3.2 — System-of-Record Detection (detect PMS vendor per practice)."""
    return {
        "data": build_enrichment_waterfall(db, pack),
        "scenario": _find_scenario(pack, "sor_detection"),
    }


def vertical_ai_per_location_roi_ctx(db: Session, pack) -> dict:
    """Demo 3.3 — Per-Location ROI (multi-location lift vs baseline + renewal brief)."""
    from compute.per_location_roi import build_per_location_roi
    result = build_per_location_roi(db, pack)
    result["scenario"] = _find_scenario(pack, "per_location_roi")
    return result


# ---- SCA -------------------------------------------------------------------
def sca_multi_thread_deal_ctx(db: Session, pack) -> dict:
    """Demo 4.1 — The Multi-Threaded Deal (eng/legal/security thread-gap per deal)."""
    from compute.multi_thread_deal import build_multi_thread_deals
    result = build_multi_thread_deals(db, pack)
    result["scenario"] = _find_scenario(pack, "multi_thread_deal")
    return result


def sca_compliance_trigger_ctx(db: Session, pack) -> dict:
    """Demo 4.2 — The Compliance Event Trigger (time-decaying regulatory/M&A signals)."""
    from compute.compliance_trigger import build_compliance_triggers
    result = build_compliance_triggers(db, pack)
    result["scenario"] = _find_scenario(pack, "compliance_trigger")
    return result


def sca_repo_coverage_ctx(db: Session, pack) -> dict:
    """Demo 4.3 — The Repo Coverage Gap (repos scanned vs total, expansion ARR)."""
    from compute.repo_coverage import build_repo_coverage
    result = build_repo_coverage(db, pack)
    result["scenario"] = _find_scenario(pack, "repo_coverage")
    return result


# ---- Distribution ----------------------------------------------------------
def distribution_erp_detection_ctx(db: Session, pack) -> dict:
    """Demo 5.1 — ERP Detection (enrich prospects with ERP signals for demo routing)."""
    from compute.erp_detection import build_erp_detection
    result = build_erp_detection(db, pack)
    result["scenario"] = _find_scenario(pack, "erp_detection")
    return result


def distribution_pov_pipeline_ctx(db: Session, pack) -> dict:
    """Demo 5.2 — POV Pipeline (active proof-of-value trials with live metrics)."""
    from compute.pov_pipeline import build_pov_pipeline
    result = build_pov_pipeline(db, pack)
    result["scenario"] = _find_scenario(pack, "pov_pipeline")
    return result


def distribution_pe_trigger_ctx(db: Session, pack) -> dict:
    """Demo 5.3 — PE Trigger Window (acquisition-driven buying windows with decay)."""
    from compute.pe_trigger import build_pe_triggers
    result = build_pe_triggers(db, pack)
    result["scenario"] = _find_scenario(pack, "pe_trigger")
    return result


# ============================================================================
# Section loader registry
# ----------------------------------------------------------------------------
# Keys are referenced from `packs/{pack}/pack.yaml` under `landing.sections[].loader`.
# The landing handler uses this registry to gather each section's demo context
# and pass it to the scrollytelling template as `section.ctx`.
# ============================================================================
SECTION_CONTEXT_LOADERS = {
    "saas.phantom_seats":           saas_phantom_seats_ctx,
    "saas.stale_pql":               saas_stale_pql_ctx,
    "saas.forecast_variance":       saas_forecast_variance_ctx,
    "home_care.call_off":           home_care_call_off_ctx,
    "home_care.evv_mismatch":       home_care_evv_mismatch_ctx,
    "home_care.stale_care_plan":    home_care_stale_care_plan_ctx,
    "vertical_ai.hierarchy":        vertical_ai_hierarchy_ctx,
    "vertical_ai.sor_detection":    vertical_ai_sor_detection_ctx,
    "vertical_ai.per_location_roi": vertical_ai_per_location_roi_ctx,
    "sca.multi_thread_deal":        sca_multi_thread_deal_ctx,
    "sca.compliance_trigger":       sca_compliance_trigger_ctx,
    "sca.repo_coverage":            sca_repo_coverage_ctx,
    "distribution.erp_detection":   distribution_erp_detection_ctx,
    "distribution.pov_pipeline":    distribution_pov_pipeline_ctx,
    "distribution.pe_trigger":      distribution_pe_trigger_ctx,
}


# ============================================================================
# Routes
# ============================================================================

# ----------------------------------------------------------------- /{pack}
@router.get("/{pack_id}", response_class=HTMLResponse)
def pack_operations(pack_id: str, request: Request, db: Session = Depends(get_db)):
    """Scrollytelling landing page for a vertical pack.

    Reads `pack.landing` from pack.yaml, runs each section's loader from
    SECTION_CONTEXT_LOADERS, and renders vertical_landing.html with the full
    section list.
    """
    pack = _get_pack_or_404(pack_id)

    if not pack.landing:
        raise HTTPException(
            status_code=500,
            detail=f"pack '{pack.id}' has no landing config",
        )

    # Scrollytelling path — iterate sections, hydrate each one's demo context.
    sections = []
    for section_cfg in pack.landing.get("sections", []):
        loader_key = section_cfg.get("loader")
        loader = SECTION_CONTEXT_LOADERS.get(loader_key)
        if loader is None:
            # Loud failure — a misconfigured pack.yaml should crash the landing,
            # not silently skip the broken section.
            raise HTTPException(
                status_code=500,
                detail=f"pack '{pack.id}' references unknown section loader '{loader_key}'",
            )
        sections.append({
            "id": section_cfg.get("id"),
            "partial": section_cfg.get("partial"),
            "narrative": section_cfg.get("narrative") or {},
            "cta": section_cfg.get("cta") or {},
            "ctx": loader(db, pack),
        })

    return templates.TemplateResponse(
        "vertical_landing.html",
        _ctx(
            request, pack,
            hero=pack.landing.get("hero") or {},
            sections=sections,
        ),
    )


# ----------------------------------------------------------------- SaaS demo routes
@router.get("/saas/revenue", response_class=HTMLResponse)
def saas_revenue(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("saas")
    return templates.TemplateResponse(
        "revenue_at_risk.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "revenue"),
            compact=False,
            ctx=saas_phantom_seats_ctx(db, pack),
        ),
    )


@router.get("/saas/pql", response_class=HTMLResponse)
def saas_pql(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("saas")
    return templates.TemplateResponse(
        "pql_inspector.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "pql"),
            compact=False,
            ctx=saas_stale_pql_ctx(db, pack),
        ),
    )


@router.get("/saas/forecast", response_class=HTMLResponse)
def saas_forecast(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("saas")
    return templates.TemplateResponse(
        "forecast_health.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "forecast"),
            compact=False,
            ctx=saas_forecast_variance_ctx(db, pack),
        ),
    )


# ----------------------------------------------------------------- Home Care demo routes
@router.get("/home-care/shifts/critical", response_class=HTMLResponse)
def home_care_shifts(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("home-care")
    return templates.TemplateResponse(
        "shift_coverage.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "shifts_critical"),
            compact=False,
            ctx=home_care_call_off_ctx(db, pack),
        ),
    )


@router.get("/home-care/reconciliation/evv", response_class=HTMLResponse)
def home_care_evv(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("home-care")
    return templates.TemplateResponse(
        "evv_reconciliation.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "reconciliation_evv"),
            compact=False,
            ctx=home_care_evv_mismatch_ctx(db, pack),
        ),
    )


@router.get("/home-care/care-plans/drift", response_class=HTMLResponse)
def home_care_care_plans(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("home-care")
    return templates.TemplateResponse(
        "care_plan_drift.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "care_plans_drift"),
            compact=False,
            ctx=home_care_stale_care_plan_ctx(db, pack),
        ),
    )


# ----------------------------------------------------------------- Vertical AI demo routes
@router.get("/vertical-ai/enrichment", response_class=HTMLResponse)
def vertical_ai_enrichment(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("vertical-ai")
    return templates.TemplateResponse(
        "enrichment_waterfall.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "operations"),
            compact=False,
            ctx=vertical_ai_hierarchy_ctx(db, pack),
        ),
    )


@router.get("/vertical-ai/enrichment/sor-detection", response_class=HTMLResponse)
def vertical_ai_sor_detection(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("vertical-ai")
    return templates.TemplateResponse(
        "sor_detection.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "operations"),
            compact=False,
            ctx=vertical_ai_sor_detection_ctx(db, pack),
        ),
    )


@router.get("/vertical-ai/customers", response_class=HTMLResponse)
def vertical_ai_customers(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("vertical-ai")
    return templates.TemplateResponse(
        "per_location_roi.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "operations"),
            compact=False,
            ctx=vertical_ai_per_location_roi_ctx(db, pack),
        ),
    )


# ----------------------------------------------------------------- SCA demo routes
@router.get("/sca/deals", response_class=HTMLResponse)
def sca_deals(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("sca")
    return templates.TemplateResponse(
        "sca_deals.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "deals"),
            compact=False,
            ctx=sca_multi_thread_deal_ctx(db, pack),
        ),
    )


@router.get("/sca/triggers", response_class=HTMLResponse)
def sca_triggers(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("sca")
    return templates.TemplateResponse(
        "sca_triggers.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "triggers"),
            compact=False,
            ctx=sca_compliance_trigger_ctx(db, pack),
        ),
    )


@router.get("/sca/coverage", response_class=HTMLResponse)
def sca_coverage(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("sca")
    return templates.TemplateResponse(
        "sca_coverage.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "coverage"),
            compact=False,
            ctx=sca_repo_coverage_ctx(db, pack),
        ),
    )


# ----------------------------------------------------------------- Distribution demo routes
@router.get("/distribution/erp-detection", response_class=HTMLResponse)
def distribution_erp(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("distribution")
    return templates.TemplateResponse(
        "distribution_erp.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "erp_detection"),
            compact=False,
            ctx=distribution_erp_detection_ctx(db, pack),
        ),
    )


@router.get("/distribution/pov", response_class=HTMLResponse)
def distribution_pov(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("distribution")
    return templates.TemplateResponse(
        "distribution_pov.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "pov"),
            compact=False,
            ctx=distribution_pov_pipeline_ctx(db, pack),
        ),
    )


@router.get("/distribution/pe-triggers", response_class=HTMLResponse)
def distribution_pe_triggers(request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404("distribution")
    return templates.TemplateResponse(
        "distribution_pe.html",
        _ctx(
            request, pack,
            rollup_markdown=get_rollup(pack, "pe_triggers"),
            compact=False,
            ctx=distribution_pe_trigger_ctx(db, pack),
        ),
    )


# ----------------------------------------------------------------- Universal pack pages
# Removed 2026-04-10 refinement pass: /{pack}/agents and /{pack}/ask.
# Their templates (agents.html, ask.html) were deleted — the chrome they
# were part of (top nav, Agents tab) is gone. If you're looking for the old
# handlers, see git history pre-2026-04-10.


@router.get("/{pack_id}/accounts/{entity_id}", response_class=HTMLResponse)
@router.get("/{pack_id}/clients/{entity_id}", response_class=HTMLResponse)
@router.get("/{pack_id}/practices/{entity_id}", response_class=HTMLResponse)
@router.get("/{pack_id}/customers/{entity_id}", response_class=HTMLResponse)
def entity_detail(pack_id: str, entity_id: str, request: Request, db: Session = Depends(get_db)):
    pack = _get_pack_or_404(pack_id)
    data = build_account_brief(db, pack, entity_id)
    if data["entity"] is None:
        raise HTTPException(status_code=404, detail="Entity not found")
    return templates.TemplateResponse(
        "entity_detail.html",
        _ctx(
            request, pack,
            entity=data["entity"],
            source_cards=data["source_cards"],
        ),
    )
