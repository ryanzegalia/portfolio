"""Tests for the reconciliation engine — matching, drift, resolution.

These tests use a real SQLite database (via the db fixture from conftest.py)
to verify the reconciler works end-to-end.
"""

from datetime import datetime, timezone

from db import Entity, Source, SourceRecord, DriftEvent


# ---------------------------------------------------------------------------
# Entity Matching
# ---------------------------------------------------------------------------
class TestMatcher:
    def test_natural_key_match(self, db, sample_pack, sample_sources, sample_entity):
        """Records with a matching natural_key link to the correct entity."""
        from reconciler.matcher import match_entities

        src_a, _ = sample_sources
        record = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_a.id,
            source_external_id="ext-1",
            natural_key="acme_nk",
            raw_snapshot={"name": "Acme Corp"},
        )
        # Give the entity a matching natural_key
        sample_entity.fields = {**sample_entity.fields, "natural_key": "acme_nk"}
        db.add(record)
        db.commit()

        matched = match_entities(db, sample_pack)
        assert matched == 1

        db.refresh(record)
        assert record.entity_id == sample_entity.id

    def test_fuzzy_name_match(self, db, sample_pack, sample_sources, sample_entity):
        """Records with a similar name (no natural_key) match via fuzzy scoring."""
        from reconciler.matcher import match_entities

        src_a, _ = sample_sources
        # Close enough name to score >= 90 on token_sort_ratio
        record = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_a.id,
            source_external_id="ext-2",
            raw_snapshot={"name": "Acme Corp"},
        )
        db.add(record)
        db.commit()

        matched = match_entities(db, sample_pack)
        assert matched == 1

        db.refresh(record)
        assert record.entity_id == sample_entity.id

    def test_no_match_for_unrelated_name(self, db, sample_pack, sample_sources, sample_entity):
        """Records with completely different names don't match."""
        from reconciler.matcher import match_entities

        src_a, _ = sample_sources
        record = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_a.id,
            source_external_id="ext-3",
            raw_snapshot={"name": "Totally Different Company"},
        )
        db.add(record)
        db.commit()

        matched = match_entities(db, sample_pack)
        assert matched == 0

        db.refresh(record)
        assert record.entity_id is None

    def test_empty_entities_returns_zero(self, db, sample_pack):
        """No entities in the pack → 0 matches."""
        from reconciler.matcher import match_entities
        assert match_entities(db, sample_pack) == 0


# ---------------------------------------------------------------------------
# Drift Detection
# ---------------------------------------------------------------------------
class TestDrift:
    def test_detects_field_disagreement(self, db, sample_pack, sample_sources, sample_entity):
        """Two source records with different values create a drift event."""
        from reconciler.drift import detect_drift

        src_a, src_b = sample_sources

        # Source A says seat_count=120
        rec_a = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_a.id,
            source_external_id="ext-a",
            entity_id=sample_entity.id,
            raw_snapshot={"seat_count": 120, "company": "Acme"},
        )
        # Source B says seat_count=135
        rec_b = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_b.id,
            source_external_id="ext-b",
            entity_id=sample_entity.id,
            raw_snapshot={"seat_count": 135, "company": "Acme"},
        )
        db.add_all([rec_a, rec_b])
        db.commit()

        new_drifts = detect_drift(db, sample_pack)
        assert new_drifts == 1  # seat_count disagrees; company agrees

        drift = db.query(DriftEvent).filter(
            DriftEvent.entity_id == sample_entity.id
        ).first()
        assert drift is not None
        assert drift.field_name == "seat_count"

    def test_idempotent_no_duplicates(self, db, sample_pack, sample_sources, sample_entity):
        """Running drift detection twice doesn't create duplicate events."""
        from reconciler.drift import detect_drift

        src_a, src_b = sample_sources
        rec_a = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_a.id,
            source_external_id="ext-a",
            entity_id=sample_entity.id,
            raw_snapshot={"seat_count": 120},
        )
        rec_b = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_b.id,
            source_external_id="ext-b",
            entity_id=sample_entity.id,
            raw_snapshot={"seat_count": 135},
        )
        db.add_all([rec_a, rec_b])
        db.commit()

        first_run = detect_drift(db, sample_pack)
        second_run = detect_drift(db, sample_pack)
        assert first_run == 1
        assert second_run == 0

        total = db.query(DriftEvent).filter(
            DriftEvent.entity_id == sample_entity.id
        ).count()
        assert total == 1

    def test_no_drift_when_sources_agree(self, db, sample_pack, sample_sources, sample_entity):
        """Identical values across sources produce no drift events."""
        from reconciler.drift import detect_drift

        src_a, src_b = sample_sources
        rec_a = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_a.id,
            source_external_id="ext-a",
            entity_id=sample_entity.id,
            raw_snapshot={"seat_count": 120},
        )
        rec_b = SourceRecord(
            pack_id=sample_pack.id,
            source_id=src_b.id,
            source_external_id="ext-b",
            entity_id=sample_entity.id,
            raw_snapshot={"seat_count": 120},
        )
        db.add_all([rec_a, rec_b])
        db.commit()

        assert detect_drift(db, sample_pack) == 0


# ---------------------------------------------------------------------------
# Drift Resolution
# ---------------------------------------------------------------------------
class TestResolver:
    def _create_drift(self, db, sample_pack, sample_sources, sample_entity):
        src_a, src_b = sample_sources
        drift = DriftEvent(
            pack_id=sample_pack.id,
            entity_id=sample_entity.id,
            field_name="seat_count",
            source_a_id=src_a.id,
            value_a="120",
            source_b_id=src_b.id,
            value_b="135",
            detected_at=datetime.now(timezone.utc),
        )
        db.add(drift)
        db.commit()
        return drift

    def test_close_action(self, db, sample_pack, sample_sources, sample_entity):
        from reconciler.resolver import resolve_drift_event

        drift = self._create_drift(db, sample_pack, sample_sources, sample_entity)
        result = resolve_drift_event(db, drift.id, "close")

        assert result["already_resolved"] is False
        assert "closed_no_action" in result["action"]

    def test_route_to_owner(self, db, sample_pack, sample_sources, sample_entity):
        from reconciler.resolver import resolve_drift_event

        drift = self._create_drift(db, sample_pack, sample_sources, sample_entity)
        result = resolve_drift_event(db, drift.id, "route_to_owner", owner="jane@example.com")

        assert "routed_to:jane@example.com" in result["action"]

    def test_already_resolved_returns_early(self, db, sample_pack, sample_sources, sample_entity):
        from reconciler.resolver import resolve_drift_event

        drift = self._create_drift(db, sample_pack, sample_sources, sample_entity)
        resolve_drift_event(db, drift.id, "close")
        result = resolve_drift_event(db, drift.id, "close")

        assert result["already_resolved"] is True

    def test_invalid_action_raises(self, db, sample_pack, sample_sources, sample_entity):
        import pytest
        from reconciler.resolver import resolve_drift_event

        drift = self._create_drift(db, sample_pack, sample_sources, sample_entity)
        with pytest.raises(ValueError, match="unknown drift action"):
            resolve_drift_event(db, drift.id, "invalid_action")

    def test_missing_drift_raises(self, db):
        import pytest
        from reconciler.resolver import resolve_drift_event

        with pytest.raises(ValueError, match="drift event not found"):
            resolve_drift_event(db, "nonexistent-id", "close")
