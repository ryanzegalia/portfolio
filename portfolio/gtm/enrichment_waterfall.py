"""Demos 3.1 + 3.2 backend — Account Hierarchy Resolver + SOR Detection.

Renders the enrichment waterfall view: source disagreements per practice,
the resolver verdict from the seed, and the SOR detection high-confidence
example.

All headline stats (prospect count, DSO reclassification count, PMS
distribution) are computed from Entity rows at request time — the seed
provides hero narratives only.
"""
from collections import Counter
from typing import Any
from sqlalchemy.orm import Session

from db import Entity, DriftEvent, Source
from packs import pack_query


def build_enrichment_waterfall(db: Session, pack) -> dict[str, Any]:
    """Returns the data for /vertical-ai/enrichment."""
    seed = pack.seed or {}

    # Source rollup
    sources = db.query(Source).filter(Source.pack_id == pack.id).all()
    source_lookup = {s.id: s for s in sources}

    # ----- Compute headline stats from Entity rows -----
    practices = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "practice")
        .limit(200)
        .all()
    )

    prospect_count = len(practices)

    # DSO reclassification: practices where parent_dso_id is set
    reclassified = [p for p in practices if (p.fields or {}).get("parent_dso_id")]
    dso_reclassified_count = len(reclassified)

    # Breakdown by DSO name (resolve parent_dso_id → DSO entity name)
    dso_id_counts = Counter(p.fields["parent_dso_id"] for p in reclassified)
    reclassification_breakdown = {}
    for dso_id, count in dso_id_counts.most_common():
        dso_entity = db.get(Entity, dso_id)
        label = dso_entity.canonical_name if dso_entity else dso_id
        reclassification_breakdown[label] = count

    # PMS detection: practices where detected_pms is set
    pms_practices = [p for p in practices if (p.fields or {}).get("detected_pms")]
    practices_with_pms_count = len(pms_practices)
    detected_distribution = dict(Counter(
        p.fields["detected_pms"] for p in pms_practices
    ).most_common())

    # ----- Top drift practices (DSO reclassifications) -----
    drift_events = (
        db.query(DriftEvent)
        .filter(DriftEvent.pack_id == pack.id)
        .filter(DriftEvent.field_name == "parent_company")
        .filter(DriftEvent.resolved_at.is_(None))
        .order_by(DriftEvent.dollar_impact.desc().nullslast())
        .limit(5)
        .all()
    )
    drift_rows = []
    for d in drift_events:
        entity = db.get(Entity, d.entity_id) if d.entity_id else None
        drift_rows.append({
            "id": d.id,
            "entity_id": d.entity_id,
            "name": entity.canonical_name if entity else "(unknown)",
            "field_name": d.field_name,
            "source_a": source_lookup.get(d.source_a_id).display_name if d.source_a_id in source_lookup else d.source_a_id,
            "value_a": d.value_a,
            "source_b": source_lookup.get(d.source_b_id).display_name if d.source_b_id in source_lookup else d.source_b_id,
            "value_b": d.value_b,
            "dollar_impact": d.dollar_impact,
        })

    # ----- Hero practice: Smile Dental (enrichment waterfall narrative) -----
    hero_practice = next(
        (p for p in practices if p.canonical_name == "Smile Dental of Tampa"),
        None,
    )
    hero_smile_dental = {}
    if hero_practice:
        hf = hero_practice.fields or {}
        hero_smile_dental = {
            "name": hero_practice.canonical_name,
            "state": hf.get("state", "FL"),
            "apollo_says_employees": hf.get("apollo_says_employees"),
            "apollo_says_parent": hf.get("apollo_says_parent"),
            "zoominfo_says_employees": hf.get("zoominfo_says_employees"),
            "zoominfo_says_independent": hf.get("zoominfo_says_independent"),
            "linkedin_office_manager_changed_at": hf.get("linkedin_office_manager_changed_at"),
            "web_scrape_footer_match": hf.get("web_scrape_footer_match"),
            "sunbiz_filing_date": hf.get("sunbiz_filing_date"),
            "sunbiz_filing_type": hf.get("sunbiz_filing_type"),
            "verdict_confidence": hf.get("verdict_confidence"),
            "warm_contacts_at_heartland_hq": hf.get("warm_contacts_at_heartland_hq"),
        }

    # ----- SOR detection: hero practice from DB -----
    sor_hero = next(
        (p for p in practices if p.canonical_name == "Beachside Family Dentistry"),
        None,
    )
    sor_hero_data = {}
    if sor_hero:
        sf = sor_hero.fields or {}
        sor_hero_data = {
            "name": sor_hero.canonical_name,
            "detected_pms": sf.get("detected_pms"),
            "confidence": sf.get("detection_confidence"),
            "signals": sf.get("detection_signals", []),
        }

    high_confidence_threshold = (seed.get("sor_detection") or {}).get("high_confidence_threshold", 0.85)
    sor_data = {
        "practices_with_pms_detection_count": practices_with_pms_count,
        "high_confidence_threshold": high_confidence_threshold,
        "detected_distribution": detected_distribution,
        "hero_practice": sor_hero_data,
    }

    return {
        "prospect_count": prospect_count,
        "dso_reclassified_count": dso_reclassified_count,
        "reclassification_breakdown": reclassification_breakdown,
        "hero_smile_dental": hero_smile_dental,
        "drift_rows": drift_rows,
        "sor_detection": sor_data,
    }