"""Entity matching across source records.

Links SourceRecord rows that represent the same real-world entity by setting
source_record.entity_id to a shared Entity.id. Uses rapidfuzz token_sort_ratio
on canonical_name with a fast natural_key path first.
"""
import logging
from typing import Any

from rapidfuzz import fuzz, process
from sqlalchemy.orm import Session

from db import Entity, SourceRecord

log = logging.getLogger(__name__)


def _extract_candidate_name(raw_snapshot: dict) -> str | None:
    """Try common name field locations across source-system shapes."""
    if not isinstance(raw_snapshot, dict):
        return None
    # HubSpot-flavored: properties.name
    properties = raw_snapshot.get("properties")
    if isinstance(properties, dict):
        for key in ("name", "company_name", "full_name", "canonical_name"):
            if properties.get(key):
                return str(properties[key])
    # Sheets-flavored: values[0]
    values = raw_snapshot.get("values")
    if isinstance(values, list) and values:
        return str(values[0])
    # Direct: top-level keys
    for key in ("canonical_name", "name", "full_name", "client_name", "practice_name"):
        if raw_snapshot.get(key):
            return str(raw_snapshot[key])
    # Nested client/practice/visit shapes
    for nested_key in ("client", "practice", "visit", "company", "organization"):
        nested = raw_snapshot.get(nested_key)
        if isinstance(nested, dict):
            for key in ("full_name", "name", "canonical_name"):
                if nested.get(key):
                    return str(nested[key])
    return None


def match_entities(db: Session, pack) -> int:
    """
    For each unmatched SourceRecord in this pack, find the best Entity match.

    Strategy:
      1. Pull all entities for this pack into memory.
      2. Pull all source records with entity_id IS NULL into memory.
      3. For each unmatched record:
         a. Fast path: if natural_key already maps to an entity field, use it.
         b. Fuzzy path: rapidfuzz token_sort_ratio against canonical names, score >= 90.
      4. Set entity_id and commit.

    Returns the count of matches made.
    """
    entities = db.query(Entity).filter(Entity.pack_id == pack.id).all()
    if not entities:
        return 0

    name_to_entity: dict[str, Entity] = {}
    for entity in entities:
        if entity.canonical_name:
            name_to_entity[entity.canonical_name] = entity

    natural_key_to_entity: dict[str, Entity] = {}
    for entity in entities:
        fields = entity.fields or {}
        nk = fields.get("natural_key")
        if nk:
            natural_key_to_entity[nk] = entity

    candidate_names = list(name_to_entity.keys())
    if not candidate_names:
        return 0

    unmatched = (
        db.query(SourceRecord)
        .filter(SourceRecord.pack_id == pack.id)
        .filter(SourceRecord.entity_id.is_(None))
        .all()
    )

    matches_made = 0
    for record in unmatched:
        # Fast path: natural_key lookup
        if record.natural_key and record.natural_key in natural_key_to_entity:
            record.entity_id = natural_key_to_entity[record.natural_key].id
            matches_made += 1
            continue

        # Fuzzy path
        candidate_name = _extract_candidate_name(record.raw_snapshot or {})
        if not candidate_name:
            log.debug("matcher: no name in raw_snapshot for record %s", record.id)
            continue

        best = process.extractOne(
            candidate_name,
            candidate_names,
            scorer=fuzz.token_sort_ratio,
            score_cutoff=90,
        )
        if best is None:
            continue

        matched_name, score, _ = best
        record.entity_id = name_to_entity[matched_name].id
        matches_made += 1

    if matches_made:
        db.commit()
        log.info("matcher: linked %d source records for pack=%s", matches_made, pack.id)
    return matches_made