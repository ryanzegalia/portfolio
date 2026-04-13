"""Demo 5.1 — ERP Detection.

Queries prospect entities with their enrichment signals and computes
confidence scores as weighted sums of found signals. Routes prospects
to demo_track or manual_qualification based on confidence threshold.

Signal weights are defined HERE in the algorithm, not in the seed data.
Each source type has a fixed weight reflecting its reliability as an
ERP indicator:
  - job_posting (0.45): strongest — a company hiring for "Prophet 21 admin"
    is almost certainly running Prophet 21.
  - vendor_directory (0.30): published customer lists and partner stories.
  - trade_show (0.15): exhibitor/attendee at a vendor conference.
  - technographic (0.10): third-party intent data (6sense, etc.) — noisy.
"""
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query

# Signal weights by source type — the algorithm owns these, not the data.
SIGNAL_WEIGHTS: dict[str, float] = {
    "job_posting": 0.45,
    "vendor_directory": 0.30,
    "trade_show": 0.15,
    "technographic": 0.10,
}


def _compute_confidence(signals: list[dict]) -> float:
    """Weighted sum of found signals. Weights come from SIGNAL_WEIGHTS, not from the data."""
    total = 0.0
    for s in signals:
        if s.get("found"):
            source = s.get("source", "")
            total += SIGNAL_WEIGHTS.get(source, 0.0)
    return round(total, 2)


def _detect_erp(signals: list[dict]) -> str | None:
    """Infer the detected ERP from the highest-weight found signal's detail."""
    found_signals = [s for s in signals if s.get("found")]
    if not found_signals:
        return None

    # Sort by weight descending, take the top one
    top = max(found_signals, key=lambda s: s.get("weight", 0))
    detail = top.get("detail", "")

    # Extract ERP name from signal detail (common patterns)
    erp_keywords = {
        "Prophet 21": "Epicor Prophet 21",
        "Eclipse": "Epicor Eclipse",
        "NetSuite": "NetSuite",
        "Acumatica": "Acumatica",
        "SAP": "SAP B1",
        "Infor": "Infor CloudSuite",
    }
    for keyword, erp_name in erp_keywords.items():
        if keyword.lower() in detail.lower():
            return erp_name
    return None


def build_erp_detection(db: Session, pack) -> dict[str, Any]:
    """Query prospects and compute ERP confidence from enrichment signals."""
    prospects = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "prospect")
        .filter(Entity.fields["is_hero"].as_boolean() == True)
        .all()
    )

    formatted = []
    detected_count = 0

    for p in prospects:
        f = p.fields or {}
        signals = f.get("signals", [])

        # Compute confidence from signal weights
        confidence = _compute_confidence(signals)
        detected_erp = _detect_erp(signals) if confidence >= 0.50 else f.get("detected_erp")

        # Route based on confidence threshold
        route = "demo_track" if confidence >= 0.50 else "manual_qualification"

        if detected_erp:
            detected_count += 1

        # Annotate each signal with the algorithm-defined weight for display
        annotated_signals = []
        for s in signals:
            annotated_signals.append({
                **s,
                "weight": SIGNAL_WEIGHTS.get(s.get("source", ""), 0.0),
            })

        formatted.append({
            "company": f.get("company", p.canonical_name),
            "sub_vertical": f.get("sub_vertical", ""),
            "branch_count": f.get("branch_count", 0),
            "detected_erp": detected_erp,
            "confidence": confidence,
            "route": route,
            "signals": annotated_signals,
        })

    # Sort by confidence descending
    formatted.sort(key=lambda p: p["confidence"], reverse=True)

    return {
        "prospects": formatted,
        "detected_prospect_count": detected_count,
        "scenario": None,
    }
