"""Demo 1.2 backend — PQL Inspector.

Reads from PQLEvent + Entity tables. Surfaces decayed PQLs without AE follow-up
plus the dollar-at-risk range computed from the historical conversion rate.
"""
from typing import Any
from sqlalchemy.orm import Session

from db import Entity, PQLEvent
from packs import pack_query


def build_pql_inspector(db: Session, pack) -> dict[str, Any]:
    """Returns the data the PQL inspector template needs."""
    pql_cfg = (pack.seed or {}).get("pql") or {}

    # I-1: bounded fetch. Sibling queries in routes/pack_demo.py use .limit(20);
    # this one caps at 50 because the PQL inspector template renders the full
    # list without pagination. Safe today (seed data is bounded), but makes the
    # query fail-closed if real data is plugged in later.
    decayed = (
        db.query(PQLEvent)
        .filter(PQLEvent.pack_id == pack.id)
        .filter(PQLEvent.decayed_at.is_not(None))
        .filter(PQLEvent.worked_at.is_(None))
        .order_by(PQLEvent.pql_score.desc())
        .limit(50)
        .all()
    )

    rows = []
    for pql in decayed:
        entity = db.get(Entity, pql.entity_id) if pql.entity_id else None
        rows.append({
            "id": pql.id,
            "account_name": entity.canonical_name if entity else "(unknown)",
            "pql_score": pql.pql_score,
            "routed_to": pql.routed_to,
            "routed_at": pql.routed_at,
            "decayed_at": pql.decayed_at,
            "dollar_at_risk_low": pql.dollar_at_risk_low,
            "dollar_at_risk_high": pql.dollar_at_risk_high,
            "score_breakdown": pql.score_breakdown or {},
        })

    return {
        "rows": rows,
        "decayed_count": len(rows),
        "dollar_at_risk_low": sum((r["dollar_at_risk_low"] or 0) for r in rows),
        "dollar_at_risk_high": sum((r["dollar_at_risk_high"] or 0) for r in rows),
        "conversion_rate_low": pql_cfg.get("conversion_rate_low", 0.32),
        "conversion_rate_high": pql_cfg.get("conversion_rate_high", 1.00),
        "decay_threshold_days": pql_cfg.get("decay_threshold_days", 30),
    }