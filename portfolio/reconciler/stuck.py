"""Stuck pipeline entity detection.

Reads pack.pipelines for stage SLAs, finds entities currently in a stage longer
than the per-stage SLA, and creates StuckEntity rows. Idempotent — skips entities
that already have an open StuckEntity row.

Also exposes schedule_stuck_detector() to register an APScheduler job that runs
this every 5 minutes for every pack.
"""
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.orm import Session

from db import Entity, StuckEntity

log = logging.getLogger(__name__)


def _iter_pipeline_stages(pipelines: dict) -> list[tuple[str, str, int]]:
    """
    Walk pack.pipelines and yield (pipeline_name, stage_name, sla_days) tuples.
    Tolerates missing or oddly-shaped pipelines.yaml content.
    """
    if not isinstance(pipelines, dict):
        return []
    out: list[tuple[str, str, int]] = []
    for pipeline_name, pipeline in pipelines.items():
        if not isinstance(pipeline, dict):
            continue
        stages = pipeline.get("stages")
        if not isinstance(stages, list):
            continue
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            stage_name = stage.get("name")
            sla_days = stage.get("sla_days")
            if stage_name and isinstance(sla_days, (int, float)):
                out.append((pipeline_name, stage_name, int(sla_days)))
    return out


def _existing_open_stuck(db: Session, entity_id: str, stage_name: str) -> bool:
    return (
        db.query(StuckEntity)
        .filter(StuckEntity.entity_id == entity_id)
        .filter(StuckEntity.pipeline_stage == stage_name)
        .filter(StuckEntity.cleared_at.is_(None))
        .first()
        is not None
    )


def flag_stuck_entities(db: Session, pack) -> int:
    """
    For each pipeline stage with an SLA in pack.pipelines, find entities in that
    stage older than the SLA. Create StuckEntity rows for new ones.

    Returns count of new stuck flags created.
    """
    stages = _iter_pipeline_stages(pack.pipelines or {})
    if not stages:
        return 0

    new_flags = 0
    now = datetime.now(timezone.utc)

    entities = db.query(Entity).filter(Entity.pack_id == pack.id).all()

    for entity in entities:
        fields = entity.fields or {}
        current_stage = fields.get("pipeline_stage")
        stage_entered_at_raw = fields.get("stage_entered_at")
        if not current_stage or not stage_entered_at_raw:
            continue

        # Parse stage_entered_at — accept ISO string or datetime
        if isinstance(stage_entered_at_raw, datetime):
            stage_entered_at = stage_entered_at_raw
        else:
            try:
                stage_entered_at = datetime.fromisoformat(str(stage_entered_at_raw).replace("Z", "+00:00"))
            except ValueError:
                continue
        if stage_entered_at.tzinfo is None:
            stage_entered_at = stage_entered_at.replace(tzinfo=timezone.utc)

        # Find this stage's SLA
        matching = [(p, s, d) for p, s, d in stages if s == current_stage]
        if not matching:
            continue
        pipeline_name, stage_name, sla_days = matching[0]
        sla_seconds = sla_days * 86400

        elapsed = (now - stage_entered_at).total_seconds()
        if elapsed < sla_seconds:
            continue

        if _existing_open_stuck(db, entity.id, stage_name):
            continue

        flag = StuckEntity(
            pack_id=pack.id,
            entity_id=entity.id,
            pipeline_stage=stage_name,
            stage_entered_at=stage_entered_at,
            sla_seconds=sla_seconds,
            reason=f"Overdue in stage {stage_name} (SLA: {sla_days}d)",
            flagged_at=now,
        )
        db.add(flag)
        new_flags += 1

    if new_flags:
        db.commit()
        log.info("stuck: flagged %d new stuck entities for pack=%s", new_flags, pack.id)
    return new_flags


def schedule_stuck_detector(scheduler: BackgroundScheduler, db_session_factory) -> None:
    """Register the stuck detector to run every 5 minutes against every pack."""
    _consecutive_failures = [0]

    def _tick():
        from packs import PACK_REGISTRY  # late import to avoid circular at module load

        try:
            with db_session_factory() as session:
                for pack in PACK_REGISTRY.values():
                    flag_stuck_entities(session, pack)
                session.commit()
            _consecutive_failures[0] = 0
        except Exception as e:
            _consecutive_failures[0] += 1
            if _consecutive_failures[0] >= 3:
                log.warning(
                    "stuck detector has failed %d consecutive times: %s",
                    _consecutive_failures[0], e,
                )
            else:
                log.exception("stuck detector tick failed: %s", e)

    scheduler.add_job(
        _tick,
        "interval",
        minutes=5,
        id="stuck_detector",
        replace_existing=True,
    )
    log.info("stuck detector scheduled (every 5 minutes)")