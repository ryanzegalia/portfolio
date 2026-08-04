"""Demo 3.3 — Per-Location ROI.

Queries the hero customer entity and its child location entities, computes
lift percentages, aggregate incremental revenue, ROI multiple, and builds
the renewal brief from DB data.
"""
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query


def build_per_location_roi(db: Session, pack) -> dict[str, Any]:
    """Query customer + locations and compute ROI metrics."""

    # Find hero customer
    hero = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "customer")
        .filter(Entity.fields["is_hero"].as_boolean() == True)
        .first()
    )

    if not hero:
        return {"customer_roi": {}, "scenario": None}

    hf = hero.fields or {}

    # Query child locations
    locations = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "location")
        .filter(Entity.parent_id == hero.id)
        .all()
    )

    # Compute per-location data
    location_data = []
    total_lift = 0
    flat_location = None

    for loc in locations:
        lf = loc.fields or {}
        baseline = lf.get("case_acceptance_baseline_pct", 0)
        current = lf.get("case_acceptance_current_pct", 0)
        lift = round(current - baseline, 1)
        status = lf.get("status", "ok")

        # Extract location name from canonical_name. The seeder writes
        # "Health River - Tampa Main" (ASCII hyphen); accept an em dash
        # too in case seed data is ever authored with one.
        loc_name = loc.canonical_name
        for sep in (" - ", " \u2014 "):
            if sep in loc_name:
                loc_name = loc_name.split(sep, 1)[1]
                break

        annual_production = lf.get("annual_production", 0)

        location_data.append({
            "name": loc_name,
            "case_acceptance_baseline_pct": baseline,
            "case_acceptance_current_pct": current,
            "lift_pct": lift,
            "annual_production": annual_production,
            "status": status,
        })

        total_lift += lift
        if lift == 0 or status == "flat":
            flat_location = loc_name

    # Sort by lift descending (flat at bottom)
    location_data.sort(key=lambda l: l["lift_pct"], reverse=True)

    # Compute aggregate metrics
    arr = hf.get("arr", 180000)
    active_locations = len([l for l in location_data if l["lift_pct"] > 0])
    avg_lift = round(total_lift / len(location_data), 1) if location_data else 0
    baseline_avg = round(sum(l["case_acceptance_baseline_pct"] for l in location_data) / len(location_data), 1) if location_data else 0
    current_avg = round(sum(l["case_acceptance_current_pct"] for l in location_data) / len(location_data), 1) if location_data else 0

    # Incremental revenue: for each location, the case acceptance lift
    # converts to additional production dollars proportional to that
    # location's annual production volume.
    # Formula: sum(lift_pct / 100 * annual_production) across all locations.
    incremental_dollars = 0
    for loc in location_data:
        loc_production = loc.get("annual_production", 0)
        loc_lift = loc.get("lift_pct", 0)
        incremental_dollars += int(loc_lift / 100 * loc_production)
    roi_multiple = round(incremental_dollars / arr, 1) if arr > 0 else 0

    renewal_in_days = hf.get("renewal_in_days", 47)

    # Build renewal brief
    renewal_brief = (
        f"Health River renews in {renewal_in_days} days. "
        f"Case acceptance moved from {baseline_avg}% to {current_avg}% across "
        f"{len(location_data)} locations ({active_locations} improving, "
        f"{'1 flat' if flat_location else 'none flat'}). "
        f"Incremental production value: ${incremental_dollars:,} against "
        f"${arr:,} ARR ({roi_multiple}x ROI). "
    )
    if flat_location:
        renewal_brief += (
            f"{flat_location} is the outlier: flat at baseline. "
            f"Recommend CSM outreach before renewal conversation."
        )

    return {
        "customer_roi": {
            "name": hero.canonical_name,
            "location_count": len(location_data),
            "active_locations": active_locations,
            "arr": arr,
            "renewal_in_days": renewal_in_days,
            "case_acceptance_baseline_pct": baseline_avg,
            "case_acceptance_current_pct": current_avg,
            "incremental_dollars": incremental_dollars,
            "roi_multiple": roi_multiple,
            "per_location_lift": location_data,
            "flat_location": flat_location,
            "renewal_brief": renewal_brief,
        },
        "scenario": None,
    }
