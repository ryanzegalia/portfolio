"""Drift event resolver — applies a resolution action to an open drift event."""
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from db import DriftEvent

log = logging.getLogger(__name__)


VALID_ACTIONS = {"close", "route_to_owner", "auto_correct_a", "auto_correct_b"}


def resolve_drift_event(
    db: Session,
    drift_event_id: str,
    action: str,
    owner: str | None = None,
) -> dict:
    """
    Apply a resolution action to a drift event.

    Actions:
      - "close": mark resolved, resolution_action="closed_no_action"
      - "route_to_owner": mark resolved, resolution_action="routed_to:{owner}"
      - "auto_correct_a": mark resolved, resolution_action="auto_corrected_to_source_a"
      - "auto_correct_b": same for source_b

    Returns a dict suitable for JSON response.
    """
    if action not in VALID_ACTIONS:
        raise ValueError(f"unknown drift action: {action}")

    drift = db.get(DriftEvent, drift_event_id)
    if drift is None:
        raise ValueError(f"drift event not found: {drift_event_id}")
    if drift.resolved_at is not None:
        return {
            "id": drift.id,
            "action": drift.resolution_action,
            "resolved_at": drift.resolved_at.isoformat(),
            "already_resolved": True,
        }

    if action == "close":
        drift.resolution_action = "closed_no_action"
    elif action == "route_to_owner":
        if not owner:
            raise ValueError("owner is required for route_to_owner")
        drift.resolution_action = f"routed_to:{owner}"
    elif action == "auto_correct_a":
        drift.resolution_action = "auto_corrected_to_source_a"
    elif action == "auto_correct_b":
        drift.resolution_action = "auto_corrected_to_source_b"

    drift.resolved_at = datetime.now(timezone.utc)
    db.commit()
    log.info("resolver: drift %s resolved via action=%s", drift_event_id, action)

    return {
        "id": drift.id,
        "action": drift.resolution_action,
        "resolved_at": drift.resolved_at.isoformat(),
        "already_resolved": False,
    }