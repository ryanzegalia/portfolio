"""Tests for the pack loading system.

Verifies that all 5 pack directories load and validate without errors.
These tests read real YAML files from packs/*/ — no mocking.
"""

import os
import sys

# Ensure portfolio/ is on sys.path so pack imports resolve
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestPackLoading:
    def test_all_five_packs_load(self):
        """All 5 pack directories parse without errors."""
        from packs.loader import load_all_packs

        registry = load_all_packs()
        assert len(registry) == 5

    def test_expected_pack_ids(self):
        """Registry contains the exact expected pack IDs."""
        from packs.loader import load_all_packs

        registry = load_all_packs()
        assert set(registry.keys()) == {
            "saas",
            "home-care",
            "vertical-ai",
            "sca",
            "distribution",
        }

    def test_each_pack_has_required_fields(self):
        """Every pack has a name, vertical_label, landing config, and scenarios."""
        from packs.loader import load_all_packs

        registry = load_all_packs()
        for pack_id, pack in registry.items():
            assert pack.name, f"{pack_id} missing name"
            assert pack.vertical_label, f"{pack_id} missing vertical_label"
            assert pack.landing, f"{pack_id} missing landing config"
            assert pack.scenarios, f"{pack_id} missing scenarios"

    def test_each_pack_has_three_scenarios(self):
        """Every vertical has exactly 3 demo scenarios."""
        from packs.loader import load_all_packs

        registry = load_all_packs()
        for pack_id, pack in registry.items():
            # Scenarios may be stored as a dict with _raw key or as a list
            raw = pack.scenarios.get("_raw", pack.scenarios) if isinstance(pack.scenarios, dict) else pack.scenarios
            assert len(raw) == 3, (
                f"{pack_id} has {len(raw)} scenarios, expected 3"
            )

    def test_pack_validation_passes(self):
        """Cross-reference validation (scenario IDs, glossary keys) succeeds."""
        from packs import init_pack_registry, validate_pack_registry

        init_pack_registry()
        # Should not raise
        validate_pack_registry()

    def test_each_pack_has_sources(self):
        """Every pack defines at least one source system."""
        from packs.loader import load_all_packs

        registry = load_all_packs()
        for pack_id, pack in registry.items():
            assert pack.sources, f"{pack_id} has no sources defined"

    def test_each_pack_has_seed_data(self):
        """Every pack has a seed dict (from seed.yaml)."""
        from packs.loader import load_all_packs

        registry = load_all_packs()
        for pack_id, pack in registry.items():
            assert pack.seed, f"{pack_id} has no seed data"
