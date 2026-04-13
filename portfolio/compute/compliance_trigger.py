"""Demo 4.2 — The Compliance Event Trigger.

Queries compliance event entities and computes time-decay scores from
detected_at timestamps. M&A and job signals use exponential decay;
deadline events (CRA, PCI) use linear urgency that INCREASES as the
deadline approaches.
"""
import math
from datetime import datetime, timezone, timedelta
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query

SIGNAL_DECAY_LAMBDA = 0.015   # half-life ~46 days for M&A/job signals
RECENCY_WEIGHT = 60           # composite = recency * RECENCY_WEIGHT + fit * FIT_WEIGHT
FIT_WEIGHT = 40


def _compute_decay(event_type: str, days_since: int, months_to_deadline: int | None = None) -> float:
    """Compute a 0-1 decay/urgency score based on event type and age.

    - M&A / job_signal / ai_code_adoption: exponential decay (signal loses
      relevance over time). Half-life ~46 days.
    - Deadline events (cra_deadline, pci_dss): linear urgency that increases
      as the deadline approaches. A deadline 5 months out scores ~0.58;
      a deadline 1 month out scores ~0.93.
    """
    if event_type in ("cra_deadline", "pci_dss") and months_to_deadline:
        # Urgency increases as deadline approaches (invert the timeline)
        # At 12 months: 0.33, at 6 months: 0.50, at 3 months: 0.75, at 1 month: 0.92
        deadline_days = months_to_deadline * 30
        urgency = max(0.0, 1.0 - (deadline_days / (12 * 30)))
        # Blend with a minimum floor so even distant deadlines register
        return max(0.25, min(1.0, urgency + 0.25))
    else:
        return math.exp(-SIGNAL_DECAY_LAMBDA * days_since)


def _compute_composite(decay_score: float, base_fit: float) -> int:
    """Composite score: weighted blend of recency signal and account fit."""
    return int(decay_score * RECENCY_WEIGHT + base_fit * FIT_WEIGHT)


def build_compliance_triggers(db: Session, pack) -> dict[str, Any]:
    """Query compliance events and compute time-decay scores."""
    now = datetime.now(timezone.utc)

    events = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "compliance_event")
        .all()
    )

    formatted_triggers = []
    for evt in events:
        f = evt.fields or {}

        # Compute days_since from detected_at
        detected_str = f.get("detected_at")
        if detected_str:
            try:
                detected = datetime.fromisoformat(detected_str)
                days_since = (now - detected).days
            except (ValueError, TypeError):
                days_since = f.get("days_since", 0)
        else:
            days_since = f.get("days_since", 0)

        months_to_deadline = f.get("months_to_deadline")
        event_type = f.get("event_type", "m_and_a")

        # Compute scores
        decay_score = _compute_decay(event_type, days_since, months_to_deadline)
        base_fit = f.get("base_fit_score", 0.85)
        composite = _compute_composite(decay_score, base_fit)

        # Routing decision
        routing = "named_ae" if composite >= 80 else "bdr_queue"
        assigned_ae = f.get("assigned_ae") if routing == "named_ae" else None

        formatted_triggers.append({
            "company": f.get("company", evt.canonical_name),
            "event_type": event_type,
            "event_label": f.get("event_label", ""),
            "event_detail": f.get("event_detail", ""),
            "days_since": days_since,
            "months_to_deadline": months_to_deadline,
            "decay_score": round(decay_score, 2),
            "composite_score": composite,
            "routing": routing,
            "assigned_ae": assigned_ae,
        })

    # Sort by composite score descending
    formatted_triggers.sort(key=lambda t: t["composite_score"], reverse=True)

    # Active triggers: those with meaningful decay (> 0.25)
    active = [t for t in formatted_triggers if t["decay_score"] > 0.25]

    return {
        "triggers": formatted_triggers,
        "active_trigger_count": len(active),
        "scenario": None,
    }
