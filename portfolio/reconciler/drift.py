"""Field-level drift detection across source records.

For each entity, compares canonical_fields stored in source_records.raw_snapshot
across each source pair. When two sources disagree on a field, creates a
DriftEvent (idempotently — skip if an open drift event already exists for that
entity_id+field_name).
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from db import DriftEvent, Entity, Source, SourceRecord

log = logging.getLogger(__name__)


def _canonical_fields_from_record(record: SourceRecord) -> dict[str, Any]:
    """Extract the canonical fields from a source record's raw_snapshot."""
    raw = record.raw_snapshot or {}
    if not isinstance(raw, dict):
        return {}
    # HubSpot-shaped: properties dict
    if "properties" in raw and isinstance(raw["properties"], dict):
        return raw["properties"]
    # Sheets-shaped: skip values list — no field names
    if "values" in raw:
        return {}
    # Direct shape (default mock): the dict itself is the canonical
    # Filter out structural keys.
    return {k: v for k, v in raw.items() if k not in ("id", "createdAt", "updatedAt", "archived", "row_index", "last_modified")}


def _stable_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, default=str)
    return str(value)


def _existing_open_drift(db: Session, entity_id: str, field_name: str) -> bool:
    return (
        db.query(DriftEvent)
        .filter(DriftEvent.entity_id == entity_id)
        .filter(DriftEvent.field_name == field_name)
        .filter(DriftEvent.resolved_at.is_(None))
        .first()
        is not None
    )


def detect_drift(db: Session, pack) -> int:
    """
    For each entity in this pack, compare canonical_fields across source records.
    Create a DriftEvent row for each disagreement (idempotent — skip if an open
    drift event for the same (entity_id, field_name) already exists).

    Returns count of new drift events created.
    """
    entities = db.query(Entity).filter(Entity.pack_id == pack.id).all()
    if not entities:
        return 0

    new_drifts = 0

    for entity in entities:
        records = (
            db.query(SourceRecord)
            .filter(SourceRecord.entity_id == entity.id)
            .all()
        )
        if len(records) < 2:
            continue

        # Build (source_id → canonical_fields) for each source backing this entity
        per_source: list[tuple[str, dict[str, Any]]] = []
        for record in records:
            per_source.append((record.source_id, _canonical_fields_from_record(record)))

        # Compare every pair of sources for every field
        seen_pairs: set[tuple[str, str]] = set()
        for i in range(len(per_source)):
            for j in range(i + 1, len(per_source)):
                source_a_id, fields_a = per_source[i]
                source_b_id, fields_b = per_source[j]
                if not source_a_id or not source_b_id:
                    continue
                shared_fields = set(fields_a.keys()) & set(fields_b.keys())
                for field_name in shared_fields:
                    val_a = _stable_str(fields_a[field_name])
                    val_b = _stable_str(fields_b[field_name])
                    if val_a == val_b:
                        continue
                    # Dedup: this entity+field already has an open drift?
                    key = (entity.id, field_name)
                    if key in seen_pairs:
                        continue
                    seen_pairs.add(key)
                    if _existing_open_drift(db, entity.id, field_name):
                        continue

                    # Lookup dollar impact from entity.fields
                    fields = entity.fields or {}
                    impact_map = fields.get("dollar_impact_per_field") or {}
                    dollar_impact = impact_map.get(field_name)

                    drift = DriftEvent(
                        pack_id=pack.id,
                        entity_id=entity.id,
                        field_name=field_name,
                        source_a_id=source_a_id,
                        value_a=val_a,
                        source_b_id=source_b_id,
                        value_b=val_b,
                        dollar_impact=dollar_impact,
                        detected_at=datetime.now(timezone.utc),
                    )
                    db.add(drift)
                    new_drifts += 1

    if new_drifts:
        db.commit()
        log.info("drift: created %d new drift events for pack=%s", new_drifts, pack.id)
    return new_drifts