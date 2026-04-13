"""Account brief endpoint backend.

Loads an entity and the source records linked to it, then flattens each
source record into a card of canonical business fields for the entity
detail view.

Business-field flattening (2026-04-11 refinement pass)
------------------------------------------------------
The detail view used to dump `natural_key`, `field_hash`, and raw_snapshot
JSON for each source record — a debug view, not a portfolio view. It now
presents each source as a card of six canonical business fields:
Customer, Plan tier, Paid seats, Active users (30d), MRR, Lifecycle.

Every source card shows the SAME field keys in the SAME order. Where a
source doesn't carry a given field, the value is `None` and the template
renders it as "—". Drift rows (where two sources disagree on a value) are
marked via `is_drift` so the template can highlight the cell and attach a
dollar-impact note from `Entity.fields.dollar_impact_per_field`.

`natural_key`, `field_hash`, and `raw_snapshot` are still loaded on each
row for debug purposes but are NOT surfaced in the rendered template —
`entity_detail.html` only reads the `fields` list.
"""
from typing import Any
from sqlalchemy.orm import Session

from db import Entity, SourceRecord, Source


# Canonical business-field schema for SaaS source cards. Each entry names a
# field and the function that extracts its value from a raw_snapshot dict
# for a specific source_key. The template walks this schema for every
# source so the three cards stay visually parallel.
_UNSET = object()


def _get(d: dict, *path, default=_UNSET):
    """Walk a nested dict path, return default if any key is missing."""
    cur = d
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def _first(*vals):
    """Return the first non-sentinel, non-None value. Used to try multiple
    shapes (seed-driven heroes vs. generated filler)."""
    for v in vals:
        if v is _UNSET or v is None:
            continue
        return v
    return None


def _extract_saas_fields(source_key: str, raw: dict, entity: Entity) -> dict[str, Any]:
    """Pull the five canonical business fields out of a SaaS source record.

    Returns {field_label: value_or_None}. Missing fields are None so the
    template can render em-dashes.

    Key design note: "Seats" is one canonical row, populated by whatever
    that source's view of seat count actually is. HubSpot reports the
    contracted seat count from the CRM; BigQuery reports distinct active
    user count from the warehouse; Stripe has no seat view. Because both
    HubSpot and BigQuery populate the SAME row with different numbers,
    the drift detector catches the disagreement and the template
    highlights both cells. If we used separate labels ("Paid seats" vs.
    "Active users") the drift would hide in two unrelated rows.
    """
    raw = raw or {}
    ef = entity.fields or {}

    if source_key == "hubspot":
        # Shape 1 (hero, from seed.yaml connector_data.hubspot.raw):
        #   {id, properties: {name, seat_count, mrr, plan_tier, hubspot_owner_id}}
        # Shape 2 (filler, from seeder._generate_filler_saas_source_records):
        #   {id, properties: {canonical_name, seat_count, mrr}, archived}
        props = _get(raw, "properties", default={}) or {}
        return {
            "Customer":  _first(_get(props, "canonical_name"), _get(props, "name"), entity.canonical_name),
            "Plan tier": _first(_get(props, "plan_tier"), ef.get("plan_tier")),
            "Seats":     _first(_get(props, "seat_count"), ef.get("seat_count")),
            "MRR":       _first(_get(props, "mrr"), ef.get("mrr")),
            "Lifecycle": _first(_get(props, "lifecycle_stage"), ef.get("lifecycle_stage")),
        }

    if source_key == "bigquery":
        # Shape 1 (hero):
        #   {monthly_active_users: {distinct_user_id_count: N},
        #    events: {most_recent_login: "..."}}
        # Shape 2 (filler): {canonical_name, seat_count}
        mau = _get(raw, "monthly_active_users", "distinct_user_id_count")
        seats = _first(mau, _get(raw, "seat_count"), ef.get("actual_seats"))
        return {
            "Customer":  _first(_get(raw, "canonical_name"), entity.canonical_name),
            "Plan tier": None,
            "Seats":     seats,
            "MRR":       None,
            "Lifecycle": None,
        }

    if source_key == "stripe":
        # Shape 1 (hero): {subscription: {id, plan: {nickname}}, invoice: {amount_due}}
        # Shape 2 (filler): {canonical_name, mrr}
        plan_nick = _get(raw, "subscription", "plan", "nickname")
        mrr = _first(_get(raw, "invoice", "amount_due"), _get(raw, "mrr"), ef.get("mrr"))
        return {
            "Customer":  _first(_get(raw, "canonical_name"), entity.canonical_name),
            "Plan tier": _first(plan_nick, ef.get("plan_tier")),
            "Seats":     None,
            "MRR":       mrr,
            "Lifecycle": None,
        }

    # Unknown source — fall back to a single "Customer" field so the card
    # still renders without exposing debug data.
    return {
        "Customer":  entity.canonical_name,
        "Plan tier": None,
        "Seats":     None,
        "MRR":       None,
        "Lifecycle": None,
    }


_SAAS_FIELD_ORDER = [
    "Customer",
    "Plan tier",
    "Seats",
    "MRR",
    "Lifecycle",
]
# Which canonical field corresponds to each drift key in
# Entity.fields.dollar_impact_per_field, so drift dollars can flow into the
# matching row on the card. Today only seat_count is populated; the shape
# leaves room for mrr drift detection.
_SAAS_DRIFT_FIELD_MAP = {
    "seat_count": "Seats",
    "mrr":        "MRR",
}
# Fields formatted with a currency prefix.
_SAAS_CURRENCY_FIELDS = {"MRR"}


def _format_saas_value(label: str, value: Any) -> str:
    if value is None:
        return "—"
    if label in _SAAS_CURRENCY_FIELDS:
        try:
            return f"${int(value):,}"
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def _detect_saas_drift_fields(cards: list[dict[str, Any]], entity: Entity) -> set[str]:
    """Return the set of field labels where at least two cards have
    different non-None values. Used by the template to highlight rows."""
    by_field: dict[str, set[Any]] = {}
    for card in cards:
        for label, value in card["fields"].items():
            if value is None:
                continue
            by_field.setdefault(label, set()).add(str(value))
    return {label for label, vals in by_field.items() if len(vals) > 1}


def _build_saas_source_cards(
    source_records: list[SourceRecord],
    source_lookup: dict[str, Source],
    entity: Entity,
) -> list[dict[str, Any]]:
    """Build one card per source in canonical order (HubSpot → BigQuery →
    Stripe → others)."""
    order = {"hubspot": 0, "bigquery": 1, "stripe": 2}

    raw_cards: list[dict[str, Any]] = []
    for sr in source_records:
        src = source_lookup.get(sr.source_id)
        if src is None:
            continue
        source_key = src.source_key
        fields = _extract_saas_fields(source_key, sr.raw_snapshot or {}, entity)
        raw_cards.append({
            "source_key": source_key,
            "source_display_name": src.display_name,
            "fields": fields,
            "pulled_at": sr.pulled_at,
        })

    raw_cards.sort(key=lambda c: (order.get(c["source_key"], 99), c["source_display_name"]))

    drift_field_labels = _detect_saas_drift_fields(raw_cards, entity)
    dollar_impacts = (entity.fields or {}).get("dollar_impact_per_field") or {}
    label_to_dollars: dict[str, int] = {}
    for drift_key, dollars in dollar_impacts.items():
        label = _SAAS_DRIFT_FIELD_MAP.get(drift_key)
        if label and dollars:
            label_to_dollars[label] = int(dollars)

    # Render each card into an ordered list of (label, display_value, is_drift, drift_note).
    rendered: list[dict[str, Any]] = []
    for card in raw_cards:
        rows = []
        for label in _SAAS_FIELD_ORDER:
            value = card["fields"].get(label)
            is_drift = label in drift_field_labels and value is not None
            drift_note = None
            if is_drift and label in label_to_dollars:
                drift_note = f"${label_to_dollars[label]:,} drift"
            rows.append({
                "label": label,
                "value": _format_saas_value(label, value),
                "is_missing": value is None,
                "is_drift": is_drift,
                "drift_note": drift_note,
            })
        rendered.append({
            "source_key": card["source_key"],
            "source_display_name": card["source_display_name"],
            "pulled_at": card["pulled_at"],
            "rows": rows,
        })

    return rendered


def build_account_brief(db: Session, pack, entity_id: str) -> dict[str, Any]:
    """Returns the data the account brief / entity detail view needs."""
    entity = db.get(Entity, entity_id)
    if entity is None or entity.pack_id != pack.id:
        return {"entity": None, "source_cards": []}

    sources = db.query(Source).filter(Source.pack_id == pack.id).all()
    source_lookup = {s.id: s for s in sources}

    source_records = (
        db.query(SourceRecord)
        .filter(SourceRecord.entity_id == entity.id)
        .all()
    )

    if pack.id == "saas":
        source_cards = _build_saas_source_cards(source_records, source_lookup, entity)
    else:
        # Other packs still use the old shape for now (home-care / vertical-ai
        # don't have a /accounts/{uuid} debug-view complaint yet). Build a
        # minimal safe fallback: one card per source with the canonical name
        # only, so nothing debug-shaped leaks through.
        source_cards = []
        for sr in source_records:
            src = source_lookup.get(sr.source_id)
            if src is None:
                continue
            source_cards.append({
                "source_key": src.source_key,
                "source_display_name": src.display_name,
                "pulled_at": sr.pulled_at,
                "rows": [{
                    "label": "Record",
                    "value": entity.canonical_name,
                    "is_missing": False,
                    "is_drift": False,
                    "drift_note": None,
                }],
            })

    return {
        "entity": entity,
        "source_cards": source_cards,
    }