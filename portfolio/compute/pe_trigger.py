"""Demo 5.3 — PE Trigger Window.

Queries acquisition entities and computes the 100-day integration window
countdown from acquisition_date. Fit scores decay exponentially as the
window closes, reflecting the diminishing likelihood of engagement.
"""
import math
from datetime import date
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query

PE_DECAY_LAMBDA = 0.008  # half-life ~87 days, gentle decay for PE windows


def _compute_fit(base_fit: int, days_since: int) -> int:
    """Compute decayed fit score.

    Base fit decays slowly over the 100-day window.
    At day 0: full score. At day 100: ~45% of base.
    """
    decay = math.exp(-PE_DECAY_LAMBDA * days_since)
    return max(0, int(base_fit * decay))


def build_pe_triggers(db: Session, pack) -> dict[str, Any]:
    """Query acquisitions and compute PE trigger windows with decay."""
    today = date.today()
    integration_window_days = 100

    acquisitions = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "acquisition")
        .all()
    )

    formatted = []
    for acq in acquisitions:
        f = acq.fields or {}

        # Compute days_since from acquisition_date
        acq_date_str = f.get("acquisition_date")
        if acq_date_str:
            try:
                acq_date = date.fromisoformat(acq_date_str)
                days_since = (today - acq_date).days
            except ValueError:
                days_since = f.get("days_since", 0)
        else:
            days_since = f.get("days_since", 0)

        # Compute window remaining
        window_remaining = max(0, integration_window_days - days_since)

        # Compute fit score with decay
        base_fit = f.get("base_fit_score", 80)
        fit_score = _compute_fit(base_fit, days_since)

        # Routing decision
        routing = "named_ae" if fit_score >= 70 else "bdr_queue"
        assigned_ae = f.get("assigned_ae") if routing == "named_ae" else None

        formatted.append({
            "pe_firm": f.get("pe_firm", ""),
            "deal_type": f.get("deal_type", ""),
            "target_company": f.get("target_company", ""),
            "sub_vertical": f.get("sub_vertical", ""),
            "acquisition_date": acq_date_str or "",
            "days_since": days_since,
            "window_remaining": window_remaining,
            "fit_score": fit_score,
            "revenue_band": f.get("revenue_band", ""),
            "geography": f.get("geography", ""),
            "routing": routing,
            "assigned_ae": assigned_ae,
            "context": f.get("context", ""),
        })

    # Sort by fit_score descending
    formatted.sort(key=lambda t: t["fit_score"], reverse=True)

    # Active = those with window still open
    active = [t for t in formatted if t["window_remaining"] > 0]

    return {
        "triggers": formatted,
        "active_pe_trigger_count": len(active),
        "scenario": None,
    }
