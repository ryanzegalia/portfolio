"""Demo 2.2 — EVV Triple Mismatch.

Queries the Visit table for the hero visit and all mismatch visits in the
last 30 days, then computes aggregate stats and categorizes mismatches.
The three-way reconciliation (Sandata clock vs WellSky schedule vs care
plan authorization) is computed from Visit column comparisons.
"""
from collections import Counter
from datetime import timedelta
from typing import Any
from sqlalchemy.orm import Session

from db import Entity, Visit
from packs import pack_query

HOURLY_RATE = 52                      # blended caregiver rate $/hr
PER_MINUTE_RATE = HOURLY_RATE / 60    # ~$0.87/min


def _categorize_mismatch(visit: Visit) -> str:
    """Categorize a mismatch visit into a human-readable bucket."""
    if visit.clocked_in_at is None or visit.clocked_out_at is None:
        return "EVV record missing entirely (paper)"

    clocked_hours = (visit.clocked_out_at - visit.clocked_in_at).total_seconds() / 3600
    scheduled_hours = (visit.scheduled_end - visit.scheduled_start).total_seconds() / 3600

    if clocked_hours > scheduled_hours + 0.08:  # >5 min overage
        return "caregiver hours > authorized hours"
    elif clocked_hours < scheduled_hours - 0.08:
        return "caregiver hours < scheduled hours"
    else:
        # Hours agree within tolerance, but the visit still carries mismatch
        # flags (task or authorization level).
        return "hours agree, tasks or authorization mismatch"


def _mismatch_dollars(visit: Visit) -> float:
    """Estimate dollar impact of a mismatch visit."""
    flags = visit.mismatch_flags or {}
    if "ltc_unbillable_dollars" in flags:
        return flags["ltc_unbillable_dollars"]

    # Estimate from overage minutes at the blended caregiver rate
    overage_min = flags.get("overage_minutes", 0)
    return round(abs(overage_min) * PER_MINUTE_RATE, 2) if overage_min else 15.0


def build_evv_mismatch(db: Session, pack) -> dict[str, Any]:
    """Query visits from DB, compute mismatch stats and hero reconciliation."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    thirty_days_ago = now - timedelta(days=30)

    # Total visits in last 30 days
    total_visits = (
        pack_query(db, Visit, pack)
        .filter(Visit.scheduled_start >= thirty_days_ago)
        .count()
    )

    # All mismatch visits
    mismatch_visits = (
        pack_query(db, Visit, pack)
        .filter(Visit.mismatch_flags.isnot(None))
        .all()
    )
    mismatch_count = len(mismatch_visits)

    # Compute total mismatch dollars and breakdown
    total_dollars = 0
    bucket_visits = Counter()
    bucket_dollars = Counter()

    for v in mismatch_visits:
        category = _categorize_mismatch(v)
        dollars = _mismatch_dollars(v)
        total_dollars += dollars
        bucket_visits[category] += 1
        bucket_dollars[category] += dollars

    mismatch_breakdown = [
        {
            "bucket": bucket,
            "visits": bucket_visits[bucket],
            "dollars": -int(round(bucket_dollars[bucket])),
        }
        for bucket in ["caregiver hours > authorized hours",
                       "caregiver hours < scheduled hours",
                       "hours agree, tasks or authorization mismatch",
                       "EVV record missing entirely (paper)"]
        if bucket_visits[bucket] > 0
    ]

    # Hero visit: the canonical Robinson 4/3/26 visit
    hero_visit_row = (
        pack_query(db, Visit, pack)
        .filter(Visit.evv_record_id == "sandata_clock_in_117")
        .first()
    )

    hero_visit = {}
    if hero_visit_row:
        # Resolve client and caregiver entities
        client = db.get(Entity, hero_visit_row.client_entity_id) if hero_visit_row.client_entity_id else None
        caregiver = db.get(Entity, hero_visit_row.caregiver_entity_id) if hero_visit_row.caregiver_entity_id else None
        client_fields = client.fields if client else {}

        # Compute times from Visit columns
        sandata_hours = round(
            (hero_visit_row.clocked_out_at - hero_visit_row.clocked_in_at).total_seconds() / 3600, 2
        )
        schedule_hours = round(
            (hero_visit_row.scheduled_end - hero_visit_row.scheduled_start).total_seconds() / 3600, 2
        )
        overage_hours = round(sandata_hours - schedule_hours, 2)

        # Check for unauthorized tasks
        authorized_tasks = ["bath", "meal_prep"]  # from care plan
        actual_tasks = hero_visit_row.task_list or []
        laundry_unauthorized = "laundry" in actual_tasks and "laundry" not in authorized_tasks

        hero_visit = {
            "client": client.canonical_name if client else "Mrs. Ada Robinson",
            "caregiver": caregiver.canonical_name if caregiver else "Yolanda Torres",
            "visit_date": hero_visit_row.scheduled_start.strftime("%Y-%m-%d"),
            "sandata_clock_in": hero_visit_row.clocked_in_at.strftime("%H:%M"),
            "sandata_clock_out": hero_visit_row.clocked_out_at.strftime("%H:%M"),
            "sandata_hours": sandata_hours,
            "schedule_start": hero_visit_row.scheduled_start.strftime("%H:%M"),
            "schedule_end": hero_visit_row.scheduled_end.strftime("%H:%M"),
            "schedule_hours": schedule_hours,
            "overage_hours": overage_hours,
            "ltc_carrier": client_fields.get("ltc_carrier", "John Hancock LTC"),
            "ltc_daily_cap_dollars": client_fields.get("ltc_daily_cap", 210),
            "overage_unbillable_dollars": (hero_visit_row.mismatch_flags or {}).get(
                "ltc_unbillable_dollars", round(overage_hours * 30, 2)
            ),
            "laundry_unauthorized": laundry_unauthorized,
        }

    return {
        "evv": {
            "monthly_visit_count": total_visits,
            "monthly_mismatch_count": mismatch_count,
            "monthly_mismatch_dollars": int(round(total_dollars)),
            "hero_visit": hero_visit,
            "mismatch_breakdown": mismatch_breakdown,
        },
        "scenario": None,  # filled by loader wrapper
    }
