"""Tests for compute modules — verify the math is real, not passthrough.

These test the pure computation functions (no DB needed) to prove that
displayed values are derived from inputs, not hardcoded.
"""

import math


# ---------------------------------------------------------------------------
# PE Trigger — exponential decay on acquisition windows
# ---------------------------------------------------------------------------
class TestPETriggerDecay:
    def test_full_score_at_day_zero(self):
        from compute.pe_trigger import _compute_fit
        assert _compute_fit(100, 0) == 100

    def test_decay_at_day_100(self):
        from compute.pe_trigger import _compute_fit
        result = _compute_fit(100, 100)
        # e^(-0.008 * 100) = e^(-0.8) ≈ 0.449 → int(100 * 0.449) = 44
        assert result == 44

    def test_decay_at_day_200(self):
        from compute.pe_trigger import _compute_fit
        result = _compute_fit(100, 200)
        # e^(-0.008 * 200) = e^(-1.6) ≈ 0.2019 → int(100 * 0.2019) = 20
        assert result == 20

    def test_zero_base_stays_zero(self):
        from compute.pe_trigger import _compute_fit
        assert _compute_fit(0, 50) == 0

    def test_negative_days_boosts_score(self):
        """Negative days_since (future acquisition) should give > base."""
        from compute.pe_trigger import _compute_fit
        # e^(-0.008 * -10) = e^(0.08) ≈ 1.083 → int(80 * 1.083) = 86
        assert _compute_fit(80, -10) > 80

    def test_uses_named_constant(self):
        """Verify the lambda constant is exposed as a module-level name."""
        from compute.pe_trigger import PE_DECAY_LAMBDA
        assert PE_DECAY_LAMBDA == 0.008


# ---------------------------------------------------------------------------
# Compliance Trigger — dual decay model (deadline urgency + signal decay)
# ---------------------------------------------------------------------------
class TestComplianceDecay:
    def test_deadline_urgency_increases_as_deadline_approaches(self):
        from compute.compliance_trigger import _compute_decay
        score_12mo = _compute_decay("cra_deadline", 0, months_to_deadline=12)
        score_6mo = _compute_decay("cra_deadline", 0, months_to_deadline=6)
        score_1mo = _compute_decay("cra_deadline", 0, months_to_deadline=1)
        assert score_1mo > score_6mo > score_12mo

    def test_signal_decay_decreases_over_time(self):
        from compute.compliance_trigger import _compute_decay
        score_day0 = _compute_decay("m_and_a", 0)
        score_day30 = _compute_decay("m_and_a", 30)
        score_day90 = _compute_decay("m_and_a", 90)
        assert score_day0 > score_day30 > score_day90

    def test_signal_decay_matches_formula(self):
        from compute.compliance_trigger import _compute_decay, SIGNAL_DECAY_LAMBDA
        result = _compute_decay("m_and_a", 46)
        expected = math.exp(-SIGNAL_DECAY_LAMBDA * 46)
        assert abs(result - expected) < 0.001

    def test_composite_score_weights(self):
        from compute.compliance_trigger import _compute_composite
        # 60% recency + 40% fit
        assert _compute_composite(1.0, 1.0) == 100
        assert _compute_composite(0.5, 0.5) == 50
        assert _compute_composite(1.0, 0.0) == 60
        assert _compute_composite(0.0, 1.0) == 40


# ---------------------------------------------------------------------------
# EVV Mismatch — categorization and dollar estimation
# ---------------------------------------------------------------------------
class TestEVVMismatch:
    def test_hourly_rate_constant_exposed(self):
        from compute.evv_mismatch import HOURLY_RATE, PER_MINUTE_RATE
        assert HOURLY_RATE == 52
        assert abs(PER_MINUTE_RATE - 52 / 60) < 0.001


# ---------------------------------------------------------------------------
# POV Pipeline — FTE cost constant
# ---------------------------------------------------------------------------
class TestPOVPipeline:
    def test_fte_cost_constant_exposed(self):
        from compute.pov_pipeline import FTE_ANNUAL_COST
        assert FTE_ANNUAL_COST == 42_000

    def test_evaluate_all_pass(self):
        from compute.pov_pipeline import _evaluate_status
        status, flagged = _evaluate_status(
            {"accuracy": 0.95, "orders_per_day": 200},
            {"accuracy": 0.90, "orders_per_day": 150},
        )
        assert status == "above_threshold"
        assert flagged is None

    def test_evaluate_below_threshold(self):
        from compute.pov_pipeline import _evaluate_status
        status, flagged = _evaluate_status(
            {"accuracy": 0.80, "orders_per_day": 100},
            {"accuracy": 0.90, "orders_per_day": 150},
        )
        assert status == "below_threshold"
        assert flagged is not None

    def test_evaluate_mixed(self):
        from compute.pov_pipeline import _evaluate_status
        status, flagged = _evaluate_status(
            {"accuracy": 0.95, "orders_per_day": 100},
            {"accuracy": 0.90, "orders_per_day": 150},
        )
        assert status == "mixed"
        assert flagged == "orders_per_day"

    def test_error_rate_lower_is_better(self):
        """error_rate is inverted: exceeding the threshold is bad."""
        from compute.pov_pipeline import _evaluate_status
        status, flagged = _evaluate_status(
            {"error_rate": 0.15},
            {"error_rate": 0.10},
        )
        assert status == "below_threshold"
        assert flagged == "error_rate"


# ---------------------------------------------------------------------------
# Care Plan Drift — keyword detection
# ---------------------------------------------------------------------------
class TestCarePlanDrift:
    def _make_note_entity(self, quote_text):
        """Create a minimal object with .fields for keyword testing."""

        class FakeEntity:
            def __init__(self, quote):
                self.fields = {"quote": quote}

        return FakeEntity(quote_text)

    def test_detects_transfer_keyword(self):
        from compute.care_plan_drift import _has_drift_signals
        notes = [self._make_note_entity("Client needs transfer assist to wheelchair")]
        assert _has_drift_signals(notes) is True

    def test_detects_fall_keyword(self):
        from compute.care_plan_drift import _has_drift_signals
        notes = [self._make_note_entity("Client fell during morning routine")]
        assert _has_drift_signals(notes) is True

    def test_no_drift_on_normal_notes(self):
        from compute.care_plan_drift import _has_drift_signals
        notes = [self._make_note_entity("Client had a good day, ate lunch")]
        assert _has_drift_signals(notes) is False

    def test_empty_notes_no_drift(self):
        from compute.care_plan_drift import _has_drift_signals
        assert _has_drift_signals([]) is False

    def test_age_computation(self):
        from compute.care_plan_drift import _compute_age_days
        from datetime import datetime, timezone, timedelta

        yesterday = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        age = _compute_age_days({"care_plan_last_updated_at": yesterday})
        assert age == 10

    def test_age_missing_field(self):
        from compute.care_plan_drift import _compute_age_days
        assert _compute_age_days({}) == 0
