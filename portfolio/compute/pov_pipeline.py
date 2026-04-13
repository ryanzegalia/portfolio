"""Demo 5.2 — POV Pipeline.

Queries trial entities and evaluates their metrics against thresholds to
determine pass/fail/mixed status. Computes trial days remaining from dates,
identifies flagged metrics, and generates verdict strings.
"""
from datetime import datetime, timezone, date
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query

FTE_ANNUAL_COST = 42_000  # fully-loaded annual cost per FTE ($)


def _evaluate_status(metrics: dict, thresholds: dict) -> tuple[str, str | None]:
    """Compare metrics against thresholds and return (status, flagged_metric).

    Returns:
        ("above_threshold", None) if all metrics pass
        ("below_threshold", "metric_name") if any critical metric fails
        ("mixed", "metric_name") if some pass, some fail
    """
    failures = []
    for key, threshold in thresholds.items():
        actual = metrics.get(key)
        if actual is None:
            continue

        if key == "error_rate":
            # For error_rate, lower is better
            if actual > threshold:
                failures.append(key)
        else:
            # For all others, higher is better
            if actual < threshold:
                failures.append(key)

    if not failures:
        return "above_threshold", None
    elif len(failures) == len(thresholds):
        return "below_threshold", failures[0]
    else:
        return "mixed", failures[0]


def _generate_verdict(status: str, flagged: str | None, metrics: dict,
                      thresholds: dict, deal_amount: int) -> str:
    """Generate a human-readable verdict from the evaluation."""
    if status == "above_threshold":
        fte = metrics.get("fte_savings", 0)
        savings = int(fte * FTE_ANNUAL_COST)
        return (
            f"All metrics above go threshold. Business case: {fte} FTE savings "
            f"at ${FTE_ANNUAL_COST // 1000}K/FTE = ${savings:,} annual savings against "
            f"${deal_amount:,} contract."
        )
    elif status == "below_threshold" and flagged:
        actual = metrics.get(flagged, 0)
        threshold = thresholds.get(flagged, 0)
        if flagged == "accuracy":
            pct = int(actual * 100)
            thr = int(threshold * 100)
            return (
                f"Accuracy at {pct}% (threshold {thr}%). Error rate trending down. "
                f"SE intervention recommended: review misclassified SKU categories."
            )
        return f"{flagged} below threshold ({actual} vs {threshold}). Review needed."
    elif flagged:
        actual = metrics.get(flagged, 0)
        threshold = thresholds.get(flagged, 0)
        if flagged == "orders_per_day":
            pct = int(actual / threshold * 100) if threshold else 0
            return (
                f"Accuracy and error rate above threshold. Orders/day at {pct}% "
                f"of target ({actual}/{threshold}). Monitor adoption rate."
            )
        return f"Mixed results. {flagged} at {actual} (target: {threshold})."
    return "Evaluation in progress."


def build_pov_pipeline(db: Session, pack) -> dict[str, Any]:
    """Query trial entities and evaluate metrics against thresholds."""
    today = date.today()

    trials = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "trial")
        .all()
    )

    formatted = []
    for trial in trials:
        f = trial.fields or {}
        thresholds = f.get("thresholds", {})
        metrics = f.get("metrics", {})

        # Compute days remaining from trial_end date
        trial_end_str = f.get("trial_end")
        if trial_end_str:
            try:
                trial_end = date.fromisoformat(trial_end_str)
                days_remaining = max(0, (trial_end - today).days)
            except ValueError:
                days_remaining = f.get("trial_days_remaining", 0)
        else:
            days_remaining = 0

        # Evaluate status from metrics vs thresholds
        status, flagged = _evaluate_status(metrics, thresholds)

        # Generate verdict
        deal_amount = f.get("deal_amount", 0)
        verdict = _generate_verdict(status, flagged, metrics, thresholds, deal_amount)

        formatted.append({
            "company": f.get("company", trial.canonical_name),
            "deal_stage": f.get("deal_stage", "POV"),
            "deal_amount": deal_amount,
            "assigned_ae": f.get("assigned_ae", ""),
            "trial_start": f.get("trial_start", ""),
            "trial_end": trial_end_str or "",
            "trial_days_remaining": days_remaining,
            "thresholds": thresholds,
            "metrics": metrics,
            "status": status,
            "flagged_metric": flagged,
            "verdict": verdict,
        })

    # Sort: active trials first (days_remaining > 0), then by days_remaining ascending
    formatted.sort(key=lambda t: (t["trial_days_remaining"] == 0, t["trial_days_remaining"]))

    return {
        "trials": formatted,
        "active_pov_count": len([t for t in formatted if t["trial_days_remaining"] > 0 or t["status"] != "above_threshold"]),
        "scenario": None,
    }
