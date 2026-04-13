"""Shared test fixtures for the portfolio test suite.

Sets DATABASE_URL before any application modules are imported.

Run tests:
    pytest tests/test_compute.py tests/test_packs.py -v    # no DB needed
    DATABASE_URL=postgresql://... pytest tests/ -v          # full suite
"""

import os

# Default for pure-function tests (compute, packs). Reconciler tests need
# a real Postgres URL set before running.
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

import pytest

from db import Base, engine
from db import Pack as PackModel, Source, Entity, SourceRecord, DriftEvent


_NEEDS_POSTGRES = os.environ.get("DATABASE_URL", "").startswith("postgresql")

# CI and fresh-Postgres local runs need schema + pack registry created before any
# test runs. The FastAPI lifespan normally handles this, but pytest does not trigger
# lifespan, so reconciler/route fixtures would fail trying to INSERT into tables
# that do not exist.
if _NEEDS_POSTGRES:
    from db import init_db
    from packs import init_pack_registry

    init_db()
    init_pack_registry()


@pytest.fixture()
def db():
    """Yield a SQLAlchemy session with SAVEPOINT-based rollback.

    Uses nested transactions so code under test can call db.commit()
    without actually persisting data. Each test gets a clean slate.
    Requires Postgres (SQLite nested transactions are flaky).
    """
    if not _NEEDS_POSTGRES:
        pytest.skip("Reconciler tests require DATABASE_URL pointing to Postgres")

    from sqlalchemy.orm import sessionmaker

    connection = engine.connect()
    transaction = connection.begin()
    Session = sessionmaker(bind=connection)
    session = Session()

    # Start a SAVEPOINT — code under test calls session.commit() which
    # releases the savepoint. We re-establish it via the event listener.
    nested = connection.begin_nested()

    from sqlalchemy import event

    @event.listens_for(session, "after_transaction_end")
    def restart_savepoint(session, transaction_inner):
        nonlocal nested
        if transaction_inner.nested and not transaction_inner._parent.nested:
            nested = connection.begin_nested()

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture()
def sample_pack(db):
    """Insert a minimal pack row and return it."""
    pack = PackModel(id="test-pack", name="Test Pack", vertical_label="Test")
    db.add(pack)
    db.flush()
    return pack


@pytest.fixture()
def sample_sources(db, sample_pack):
    """Insert two sources (simulating HubSpot + BigQuery) and return them."""
    src_a = Source(
        id="src-hubspot",
        pack_id=sample_pack.id,
        source_key="hubspot",
        display_name="HubSpot",
        source_type="crm",
    )
    src_b = Source(
        id="src-bigquery",
        pack_id=sample_pack.id,
        source_key="bigquery",
        display_name="BigQuery",
        source_type="warehouse",
    )
    db.add_all([src_a, src_b])
    db.flush()
    return src_a, src_b


@pytest.fixture()
def sample_entity(db, sample_pack):
    """Insert a single entity and return it."""
    entity = Entity(
        id="entity-acme",
        pack_id=sample_pack.id,
        entity_type="account",
        canonical_name="Acme Corp",
        fields={"mrr": 5000, "seat_count": 120},
    )
    db.add(entity)
    db.flush()
    return entity
