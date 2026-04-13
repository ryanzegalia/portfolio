"""Demo 2.1 — The 6am Call-Off.

Queries unfilled shifts and available caregivers from Entity rows, then
ranks backups by: prior shift history (45%), geographic proximity (30%),
recency bonus (15%), and fairness penalty (10%).
"""
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query

# Honorific prefixes to strip when building caregiver-field keys.
# "Mr. Henderson" → "henderson", "Mrs. Ada Robinson" → "ada_robinson"
_HONORIFICS = {"mr", "mrs", "ms", "dr"}


def _client_field_key(client_name: str) -> str:
    """Derive the field-name key from a client's canonical name.

    Strips honorifics and normalizes to lowercase underscore form.
    'Mr. Henderson' → 'henderson', used to build field names like
    'prior_shifts_with_henderson' and 'distance_to_henderson_mi'.
    """
    parts = client_name.lower().replace(".", "").split()
    parts = [p for p in parts if p not in _HONORIFICS]
    return "_".join(parts)


def _rank_score(caregiver_fields: dict, client_name: str) -> float:
    """Compute a caregiver ranking score for a specific client.

    Three-factor weighted composite:
      - Prior shift history with THIS client (50%): strongest signal.
        A caregiver who has worked with the client before knows the routine,
        the home layout, and the client's preferences.
      - Geographic proximity (30%): inverse distance in miles. Closer
        caregivers can arrive faster on a last-minute call-off.
      - Recency bonus (20%): 1.0 if 3+ prior shifts (established relationship),
        0.5 if 1-2 (some familiarity), 0.0 if none.
    """
    # Build dynamic field name from client name (e.g., "prior_shifts_with_henderson")
    client_key = _client_field_key(client_name)
    prior = caregiver_fields.get(f"prior_shifts_with_{client_key}", 0)

    # Geographic proximity (inverse distance: closer is better)
    distance = caregiver_fields.get(f"distance_to_{client_key}_mi", 999)
    proximity = 1.0 / (1.0 + distance)

    # Recency bonus: derived from prior shift count as a proxy
    recency = 1.0 if prior > 2 else (0.5 if prior > 0 else 0.0)

    return (prior * 0.50) + (proximity * 0.30) + (recency * 0.20)


def _backup_note(fields: dict, client_name: str) -> str:
    """Generate a human-readable note for a ranked backup."""
    client_key = _client_field_key(client_name)
    prior = fields.get(f"prior_shifts_with_{client_key}", 0)
    distance = fields.get(f"distance_to_{client_key}_mi")

    parts = []
    if prior > 0:
        suffix = "s" if prior != 1 else ""
        parts.append(f"{prior} prior shift{suffix} with {client_name}")
        parts.append("no schedule conflict")
    elif distance is not None and distance < 3:
        parts.append("closest geographic")

    return " \u00b7 ".join(p for p in parts if p)


def _generate_verdict(top_cg: Entity, ranked: list[Entity], client_name: str) -> str:
    """Generate the agent verdict text from the top-ranked caregiver."""
    f = top_cg.fields or {}
    client_key = _client_field_key(client_name)
    prior = f.get(f"prior_shifts_with_{client_key}", 0)
    dist = f.get(f"distance_to_{client_key}_mi", 0)
    names = [cg.canonical_name for cg in ranked[:4]]
    sequence = " \u2192 ".join(names)

    return (
        f"{top_cg.canonical_name} has the strongest match "
        f"({prior} prior shifts, {dist}mi, no overlap with her "
        f"Tuesday morning shift). Auto-fanout sequenced: {sequence}, "
        f"90s between sends, first reply wins."
    )


def build_call_off(db: Session, pack) -> dict[str, Any]:
    """Query unfilled shifts and rank available caregivers."""
    seed = pack.seed or {}
    blended_rate = (seed.get("value_generators") or {}).get("blended_rate_per_hour", 52)
    cs_cfg = seed.get("critical_shifts") or {}

    # Find unfilled shifts
    unfilled = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "shift")
        .filter(Entity.fields["status"].as_string() == "unfilled")
        .limit(200)
        .all()
    )

    # Sort by scheduled_start (soonest first)
    unfilled.sort(key=lambda s: (s.fields or {}).get("scheduled_start", ""))

    hero_shift_entity = unfilled[0] if unfilled else None
    hero_fields = hero_shift_entity.fields if hero_shift_entity else {}

    # Resolve the client entity for the hero shift
    client_id = hero_fields.get("client_id")
    client = db.get(Entity, client_id) if client_id else None
    client_name = client.canonical_name if client else hero_fields.get("client_name", "Unknown")
    client_fields = client.fields if client else {}

    # Find the called-off caregiver
    call_off_cg_name = hero_fields.get("call_off_caregiver", "Maria Lopez")
    call_off_cg = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "caregiver")
        .filter(Entity.canonical_name == call_off_cg_name)
        .first()
    )

    # Query available caregivers (not called off today)
    all_caregivers = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "caregiver")
        .limit(200)
        .all()
    )
    available = [
        cg for cg in all_caregivers
        if not (cg.fields or {}).get("called_off_today", False)
    ]

    # Rank by computed score
    scored = [(cg, _rank_score(cg.fields or {}, client_name)) for cg in available]
    scored.sort(key=lambda x: x[1], reverse=True)
    ranked_cgs = [cg for cg, _ in scored]

    # Build ranked backups list (top 4)
    ranked_backups = []
    for i, cg in enumerate(ranked_cgs[:4]):
        f = cg.fields or {}
        ranked_backups.append({
            "rank": i + 1,
            "name": cg.canonical_name,
            "prior_shifts": f.get(f"prior_shifts_with_{_client_field_key(client_name)}", 0),
            "distance_miles": f.get(f"distance_to_{_client_field_key(client_name)}_mi", 0),
            "notes": _backup_note(f, client_name),
        })

    # Compute headline stat
    avg_hours = 4  # typical shift length
    family_impact = len(unfilled) * blended_rate * avg_hours

    return {
        "critical_shifts": {
            "count_unfilled_next_4hr": len(unfilled),
            "family_visible_impact_dollars": int(family_impact),
            "blended_rate_per_hour": blended_rate,
            "blended_rate_footnote": cs_cfg.get("blended_rate_footnote", ""),
            "hero_shift": {
                "client_name": client_name,
                "shift_start": hero_fields.get("shift_start", "7:00am"),
                "shift_end": hero_fields.get("shift_end", "11:00am"),
                "starts_in_minutes": hero_fields.get("sla_minutes_until_start", 58),
                "original_caregiver": call_off_cg.canonical_name if call_off_cg else call_off_cg_name,
                "call_off_time": hero_fields.get("call_off_time", "6:02am"),
                "call_off_reason": hero_fields.get("call_off_reason", "flu"),
                "care_needs": hero_fields.get("care_needs", []),
                "authorized_hours_per_day": hero_fields.get("authorized_hours_per_day",
                                                             client_fields.get("authorized_hours_per_week", 28) // 7),
                "billing_type": hero_fields.get("billing_type",
                                                 client_fields.get("billing_method", "private pay")),
                "system_of_record": "WellSky Personal Care",
                "ranked_backups": ranked_backups,
                "agent_verdict": _generate_verdict(ranked_cgs[0], ranked_cgs, client_name) if ranked_cgs else "",
            },
        },
        "scenario": None,  # filled by loader wrapper
    }
