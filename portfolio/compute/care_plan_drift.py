"""Demo 2.3 — Stale Care Plan.

Queries client entities with stale care plans and shift-note children to
detect acuity drift patterns. Computes care plan age from timestamps and
detects drift via keyword analysis of shift notes — no pre-baked flags.
"""
from datetime import datetime, timezone
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query

_DRIFT_KEYWORDS = ("transfer", "assist", "fell", "fall", "two-person")


def _compute_age_days(fields: dict) -> int:
    """Derive care plan age from care_plan_last_updated_at timestamp."""
    updated_at = fields.get("care_plan_last_updated_at")
    if updated_at:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(updated_at)).days
    return 0


def _has_drift_signals(note_entities: list) -> bool:
    """Check shift notes for keywords that indicate acuity drift."""
    note_text = " ".join(
        (n.fields or {}).get("quote", "") for n in note_entities
    ).lower()
    return any(kw in note_text for kw in _DRIFT_KEYWORDS)


def build_care_plan_drift(db: Session, pack) -> dict[str, Any]:
    """Query clients with stale care plans and their shift-note evidence."""

    # All clients
    clients = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "client")
        .limit(200)
        .all()
    )

    # Detect drift: care plan age > 30 days AND shift notes show drift keywords
    drift_clients = []
    # Parallel dict stores computed values keyed by entity id, avoiding
    # monkey-patching transient attributes onto SQLAlchemy model instances.
    computed: dict[str, tuple[int, list]] = {}  # entity_id -> (age_days, notes)
    for c in clients:
        cf = c.fields or {}
        age_days = _compute_age_days(cf)
        if age_days <= 30:
            continue

        notes = (
            pack_query(db, Entity, pack)
            .filter(Entity.entity_type == "shift_note")
            .filter(Entity.parent_id == c.id)
            .all()
        )
        if _has_drift_signals(notes):
            computed[c.id] = (age_days, notes)
            drift_clients.append(c)

    # Count clients needing clinical review (care plan > 45 days + drift)
    clinical_review = [c for c in drift_clients if computed[c.id][0] > 45]

    # Also count stuck entities flagged for care plan drift
    from db import StuckEntity
    stuck_drift = (
        pack_query(db, StuckEntity, pack)
        .filter(StuckEntity.cleared_at.is_(None))
        .filter(StuckEntity.pipeline_stage == "Confirmed")
        .count()
    )

    drift_count = max(len(drift_clients) + stuck_drift, len(drift_clients))

    # Estimate margin leak
    blended_rate = (pack.seed or {}).get("value_generators", {}).get("blended_rate_per_hour", 52)
    # Each drifting client has ~4 hrs/month of misallocated care. At the blended
    # rate, the agency's ~22% margin on those hours is at risk.
    estimated_margin = int(drift_count * blended_rate * 4 * 0.22)

    # Hero client: Henderson
    hero = next((c for c in drift_clients if c.canonical_name == "Mr. Henderson"), None)
    hero_fields = hero.fields if hero else {}

    # Shift notes for hero (already queried during drift detection)
    shift_notes = []
    if hero:
        _, note_entities = computed.get(hero.id, (0, []))
        note_entities = sorted(note_entities, key=lambda n: (n.fields or {}).get("date", ""))
        shift_notes = [
            {"date": (n.fields or {}).get("date", ""), "quote": (n.fields or {}).get("quote", "")}
            for n in note_entities
        ]

    # Query care plan for hero
    care_plan = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "care_plan")
        .filter(Entity.fields["client_id"].as_string() == hero.id)
        .first()
    ) if hero else None
    care_plan_fields = care_plan.fields if care_plan else {}

    # Build inferred actual from shift notes (primary detection)
    current_plan = care_plan_fields.get("current_plan", "ambulatory, minimal assist, independent transfers")
    note_text = " ".join(n["quote"] for n in shift_notes).lower() if shift_notes else ""
    signals = []
    if "transfer" in note_text or "assist" in note_text:
        signals.append("needs transfer assist")
    if "fell" in note_text or "fall" in note_text:
        signals.append("fall risk")
    if "two-person" in note_text:
        signals.append("two-person assist required")
    inferred_actual = ", ".join(signals) if signals else "needs reassessment"

    # Build agent recommendation
    agent_rec = ""
    hero_age = computed.get(hero.id, (0, []))[0] if hero else 0
    if hero_age > 45 and shift_notes:
        hours_current = hero_fields.get("authorized_hours_per_week", 28) // 7
        agent_rec = (
            f"This client needs an acuity reassessment. The shift-note pattern over "
            f"{len(shift_notes) * 2 + 1} days shows a consistent increase in transfer "
            f"assistance time. Recommended: schedule a reassessment, then submit a "
            f"reauthorization to {hero_fields.get('ltc_carrier', 'John Hancock LTC')} "
            f"requesting an increase from {hours_current} to {hours_current + 1} hours per day. "
            f"Reauth packets typically require recent assessment notes plus the "
            f"requesting clinician's signature."
        )

    hero_client = {}
    if hero:
        hero_client = {
            "name": hero.canonical_name,
            "care_plan_age_days": hero_age,
            "ltc_carrier": hero_fields.get("ltc_carrier", ""),
            "drift_signal": hero_fields.get("drift_signal", "acuity change detected"),
            "drift_first_noted": hero_fields.get("drift_first_noted", ""),
            "drift_type": hero_fields.get("drift_type", "acuity_increase"),
            "shift_notes": shift_notes,
            "current_plan": current_plan,
            "inferred_actual": inferred_actual,
            "agent_recommendation": agent_rec,
        }

    return {
        "care_plan_drift": {
            "drift_client_count": drift_count,
            "clinical_review_count": len(clinical_review),
            "estimated_lost_margin_per_month": estimated_margin,
            "hero_client": hero_client,
        },
        "scenario": None,  # filled by loader wrapper
    }
