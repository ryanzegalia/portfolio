"""Demo 1.3 — Forecast Variance.

Queries all SaaS account entities, groups by AE, computes pipeline coverage
ratio, detects stage skips and overdue deals, and identifies commission
audit mismatches where closed_by differs from credited_to.
"""
from collections import defaultdict
from datetime import datetime, timezone, timedelta, date
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query


def current_quarter_label(fiscal_year_start: str = "01-01") -> str:
    """Return 'Q{N} {YYYY} · {days_remaining} days remaining' from system clock."""
    today = datetime.now(timezone.utc).date()
    try:
        fy_month, fy_day = (int(x) for x in fiscal_year_start.split("-"))
    except ValueError:
        fy_month, fy_day = 1, 1

    fy_start_this_year = date(today.year, fy_month, fy_day)
    if today < fy_start_this_year:
        fy_year = today.year - 1
        fy_start = date(fy_year, fy_month, fy_day)
    else:
        fy_year = today.year
        fy_start = fy_start_this_year

    days_into_fy = (today - fy_start).days
    quarter_index = min(days_into_fy // 91, 3)
    q_num = quarter_index + 1

    q_start = fy_start
    for _ in range(quarter_index):
        q_start = date.fromordinal(q_start.toordinal() + 91)
    q_end = date.fromordinal(q_start.toordinal() + 91)
    days_remaining = max(0, (q_end - today).days)

    return f"Q{q_num} {fy_year} · {days_remaining} days remaining"


def _stale_sla_tooltip(pipelines: dict) -> str:
    """Build a tooltip string showing per-stage SLA thresholds."""
    sales = pipelines.get("sales_pipeline") or {}
    stages = sales.get("stages") or []
    parts = [f"{s['name']} {s['sla_days']}d" for s in stages if s.get("sla_days")]
    if not parts:
        return ""
    return "Stale = deal in current stage longer than per-stage SLA (" + ", ".join(parts) + ")"


def build_forecast_variance(db: Session, pack) -> dict[str, Any]:
    """Query SaaS accounts and compute pipeline health metrics."""
    pipelines = pack.pipelines or {}
    fiscal_year_start = pipelines.get("fiscal_year_start", "01-01")
    sales = pipelines.get("sales_pipeline") or {}
    stages = sales.get("stages") or []
    stage_order = {s["name"]: i for i, s in enumerate(stages)}
    stage_sla = {s["name"]: s.get("sla_days", 999) for s in stages}

    # Query all accounts
    accounts = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "account")
        .limit(200)
        .all()
    )

    # Group by AE
    ae_data = defaultdict(lambda: {
        "pipeline_dollars": 0,
        "quota": 0,
        "stage_skips": 0,
        "overdue_count": 0,
        "deals": [],
    })

    now = datetime.now(timezone.utc)
    total_committed = 0
    total_booked = 0
    commission_mismatches = []

    for acct in accounts:
        f = acct.fields or {}
        ae = f.get("hubspot_owner", "Unassigned")
        mrr = f.get("mrr", 0)
        stage = f.get("pipeline_stage", "")
        stage_age_str = f.get("stage_entered_at")

        # Pipeline dollars: open pipeline stages (not Closed-Won/Closed-Lost)
        if stage not in ("Closed-Won", "Closed-Lost"):
            ae_data[ae]["pipeline_dollars"] += mrr * 12  # annualize

        # Committed pipeline (Verbal + Closed-Won)
        if stage in ("Verbal", "Closed-Won"):
            total_committed += mrr * 12

        # Booked (Closed-Won only)
        if stage == "Closed-Won" and mrr > 0:
            total_booked += mrr * 12

        # Stage age for overdue detection
        if stage_age_str and stage in stage_sla:
            try:
                entered = datetime.fromisoformat(stage_age_str)
                age_days = (now - entered).days
                if age_days > stage_sla.get(stage, 999):
                    ae_data[ae]["overdue_count"] += 1
            except (ValueError, TypeError):
                pass

        # Stage skip detection: if a deal is in Negotiation but was never in Demo
        # (simplified: check if stage index > 2 but stage_age < 7 days, implying a skip)
        stage_idx = stage_order.get(stage, 0)
        if stage_idx >= 2 and stage_age_str:
            try:
                entered = datetime.fromisoformat(stage_age_str)
                if (now - entered).days < 7:
                    ae_data[ae]["stage_skips"] += 1
            except (ValueError, TypeError):
                pass

        # Commission audit: check for credited_to mismatch
        credited_to = f.get("commission_credited_to")
        if credited_to and credited_to != ae and stage == "Closed-Won" and mrr > 0:
            commission_mismatches.append({
                "deal_name": acct.canonical_name,
                "amount": mrr * 12,
                "closed_by": ae,
                "credited_to": credited_to,
            })

    # Compute coverage ratio
    forecast_cfg = (pack.seed or {}).get("forecast") or {}
    coverage_target = forecast_cfg.get("coverage_target", 3.0)
    quarterly_target = forecast_cfg.get("quarterly_target", total_committed + 2000000)
    total_pipeline = sum(d["pipeline_dollars"] for d in ae_data.values())
    remaining_to_close = max(1, quarterly_target - total_booked)
    coverage_ratio = round(total_pipeline / remaining_to_close, 1) if remaining_to_close > 0 else 0

    # Cap at reasonable bounds (0.1x–9.9x) without falling back to seed values
    coverage_ratio = max(0.1, min(9.9, coverage_ratio))

    # Build AE scorecard
    ae_scorecard = []
    for ae_name, data in sorted(ae_data.items()):
        if ae_name == "Unassigned":
            continue
        pipeline = data["pipeline_dollars"]
        ae_coverage = round(pipeline / (remaining_to_close / max(1, len(ae_data) - 1)), 1) if remaining_to_close > 0 else 0
        # Cap per-AE coverage at reasonable display bounds
        ae_coverage = max(0.1, min(9.9, ae_coverage))

        ae_scorecard.append({
            "ae_name": ae_name,
            "pipeline_dollars": pipeline,
            "coverage_ratio": ae_coverage,
            "stage_skips": data["stage_skips"],
            "overdue_in_stage": data["overdue_count"],
        })

    # Historical stats from pipelines.yaml (not DB — these are prior quarter)
    historical_committed = pipelines.get("historical_committed", 4400000)
    historical_booked = pipelines.get("historical_booked", 2900000)
    historical_variance_pct = pipelines.get("historical_variance_pct", -34)
    historical_close_rate = forecast_cfg.get("historical_close_rate", 0.66)

    return {
        "quarter_label": current_quarter_label(fiscal_year_start),
        "coverage_ratio": coverage_ratio,
        "coverage_target": coverage_target,
        "historical_committed": historical_committed,
        "historical_booked": historical_booked,
        "historical_close_rate": historical_close_rate,
        "historical_variance_pct": historical_variance_pct,
        "ae_scorecard": ae_scorecard,
        "commission_audit": commission_mismatches,
        "stale_sla_tooltip": _stale_sla_tooltip(pipelines),
    }
