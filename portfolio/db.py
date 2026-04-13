"""PostgreSQL database models and session management for the portfolio site.

All 11 canonical models for the reconciliation engine. UUID string PKs via
`_uuid()`. JSONB columns for flexible per-pack payloads. Tables created at
startup via `init_db()` (no Alembic — mirrors jobradar pattern).
"""

import uuid

from sqlalchemy import (
    create_engine,
    Column,
    String,
    Text,
    Float,
    DateTime,
    Integer,
    Boolean,
    ForeignKey,
    Index,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

from config import DATABASE_URL

# Use Postgres JSONB when running against postgres, fall back to JSON for sqlite
# (local syntax-validation only — production always runs on postgres).
if DATABASE_URL.startswith("postgresql"):
    from sqlalchemy.dialects.postgresql import JSONB
else:
    from sqlalchemy import JSON as JSONB  # type: ignore

_engine_kwargs: dict = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs = {"connect_args": {"check_same_thread": False}}
engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def _uuid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# 1. Pack — pack metadata loaded from packs/<pack>/pack.yaml
# ---------------------------------------------------------------------------
class Pack(Base):
    __tablename__ = "packs"

    # The primary key is the pack short name ("saas", "home_care", "vertical_ai")
    # so foreign keys elsewhere are readable without joins.
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    vertical_label = Column(String, nullable=False)
    terminology_json = Column(JSONB)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# 2. Source — a mocked source system inside a pack (HubSpot, Stripe, WellSky...)
# ---------------------------------------------------------------------------
class Source(Base):
    __tablename__ = "sources"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    source_key = Column(String, nullable=False)  # "hubspot", "bigquery", "wellsky"
    display_name = Column(String, nullable=False)
    source_type = Column(String, nullable=False)  # "crm", "warehouse", "evv", etc.

    __table_args__ = (
        UniqueConstraint("pack_id", "source_key", name="uq_source_pack_key"),
    )


# ---------------------------------------------------------------------------
# 3. Entity — canonical object (account, client, practice, shift, ...)
# ---------------------------------------------------------------------------
class Entity(Base):
    __tablename__ = "entities"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    entity_type = Column(String, nullable=False)  # "account", "client", "practice", "shift"
    canonical_name = Column(String, nullable=False)
    parent_id = Column(String, ForeignKey("entities.id"), nullable=True)
    fields = Column(JSONB)  # flexible per-pack fields (seat_count, mrr, acuity_level, ...)
    confidence = Column(Float, nullable=True)
    first_seen_at = Column(DateTime(timezone=True), server_default=func.now())
    last_seen_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    parent = relationship("Entity", remote_side=[id], backref="children")

    __table_args__ = (
        Index("idx_entities_pack_type", "pack_id", "entity_type"),
        Index("idx_entities_fields", "fields", postgresql_using="gin"),
    )


# ---------------------------------------------------------------------------
# 4. SourceRecord — raw observation of an entity from a source system
# ---------------------------------------------------------------------------
class SourceRecord(Base):
    __tablename__ = "source_records"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    source_id = Column(String, ForeignKey("sources.id"), nullable=False)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=True, index=True)
    source_external_id = Column(String, nullable=False)  # natural key from the source system
    natural_key = Column(String, index=True)  # short readable ID like "hs_meridian_labs"
    raw_snapshot = Column(JSONB)
    field_hash = Column(String)
    pulled_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("source_id", "source_external_id", name="uq_source_external"),
        Index("idx_source_records_natural_key", "natural_key"),
    )


# ---------------------------------------------------------------------------
# 5. DriftEvent — a disagreement between two sources on a single field
# ---------------------------------------------------------------------------
class DriftEvent(Base):
    __tablename__ = "drift_events"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=False, index=True)
    field_name = Column(String, nullable=False)
    source_a_id = Column(String, ForeignKey("sources.id"), nullable=False)
    value_a = Column(Text)
    source_b_id = Column(String, ForeignKey("sources.id"), nullable=False)
    value_b = Column(Text)
    dollar_impact = Column(Float, nullable=True)
    detected_at = Column(DateTime(timezone=True), server_default=func.now())
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    resolution_action = Column(String, nullable=True)

    __table_args__ = (
        # Open drift events are the ones with resolved_at NULL — this compound
        # index makes the common "open drift for pack X" query fast.
        Index("idx_drift_pack_resolved", "pack_id", "resolved_at"),
    )


# ---------------------------------------------------------------------------
# 6. StuckEntity — pipeline item that has exceeded its SLA at a stage
# ---------------------------------------------------------------------------
class StuckEntity(Base):
    __tablename__ = "stuck_entities"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=False)
    pipeline_stage = Column(String, nullable=False)
    stage_entered_at = Column(DateTime(timezone=True), nullable=False)
    sla_seconds = Column(Integer, nullable=False)
    reason = Column(String)
    flagged_at = Column(DateTime(timezone=True), server_default=func.now())
    cleared_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("idx_stuck_pack_cleared", "pack_id", "cleared_at"),
    )


# ---------------------------------------------------------------------------
# 7. PQLEvent — SaaS pack, but kept schema-generic for reuse
# ---------------------------------------------------------------------------
class PQLEvent(Base):
    __tablename__ = "pql_events"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=False)
    pql_score = Column(Float, nullable=False)
    score_breakdown = Column(JSONB)
    routed_to = Column(String, nullable=True)  # AE name
    routed_at = Column(DateTime(timezone=True), nullable=True)
    worked_at = Column(DateTime(timezone=True), nullable=True)
    decayed_at = Column(DateTime(timezone=True), nullable=True)
    dollar_at_risk_low = Column(Float)
    dollar_at_risk_high = Column(Float)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# 10. ProductEvent — SaaS pack, behavioral events used for PQL scoring
# ---------------------------------------------------------------------------
class ProductEvent(Base):
    __tablename__ = "product_events"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=False)
    event_type = Column(String, nullable=False)
    event_data = Column(JSONB)
    occurred_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("idx_product_events_entity_time", "entity_id", occurred_at.desc()),
    )


# ---------------------------------------------------------------------------
# 11. Visit — Home-care pack, but kept schema-generic
# ---------------------------------------------------------------------------
class Visit(Base):
    __tablename__ = "visits"

    id = Column(String, primary_key=True, default=_uuid)
    pack_id = Column(String, ForeignKey("packs.id"), nullable=False, index=True)
    client_entity_id = Column(String, ForeignKey("entities.id"), nullable=False)
    caregiver_entity_id = Column(String, ForeignKey("entities.id"), nullable=True)
    scheduled_start = Column(DateTime(timezone=True), nullable=False)
    scheduled_end = Column(DateTime(timezone=True), nullable=False)
    clocked_in_at = Column(DateTime(timezone=True), nullable=True)
    clocked_out_at = Column(DateTime(timezone=True), nullable=True)
    task_list = Column(JSONB)
    evv_record_id = Column(String, nullable=True)
    mismatch_flags = Column(JSONB, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_visits_pack_scheduled", "pack_id", "scheduled_start"),
    )


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
def init_db() -> None:
    """Create all tables and ensure the pg_trgm extension exists (Postgres only).

    Mirrors the jobradar pattern: no Alembic, just `create_all`. Safe to run
    repeatedly; existing tables and indexes are left alone.
    """
    Base.metadata.create_all(engine)

    if DATABASE_URL.startswith("postgresql"):
        with engine.connect() as conn:
            # pg_trgm powers fuzzy name matching in the reconciler (entity resolution).
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            conn.commit()


def get_db():
    """FastAPI dependency for database sessions."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()