"""Seeder — deterministic Faker-based population of all 3 packs.

Runs once at startup. Idempotent (skip-if-exists). Same seed → same data → same dashboards.

Calibration matters: figures must match the lived-experience ranges in the build plan.
A 50-person SaaS has $20K-$80K of phantom seat leakage, NOT $5M.

Contract with packs/saas/seed.yaml, packs/home_care/seed.yaml, packs/vertical_ai/seed.yaml:

  account_names: { hero: [...], filler: [...] }     # SaaS
  client_names:  { hero: [...], filler: [...] }     # Home Care
  caregiver_names: { hero: [...] }                  # Home Care
  practice_names: { hero: [...], filler: [...] }    # Vertical AI
  ae_names: [...]                                   # SaaS
  dso_names: [...]                                  # Vertical AI
  customer_names: { hero: [...] }                   # Vertical AI

  value_generators: { mrr_range, seat_count_range, drift_dollar_range, ... }

  connector_data:
    <source_key>:
      - source_external_id: ...
        natural_key: ...
        canonical: { ... }
        raw: { ... }

  drift_dollar_impacts: { natural_key__field_name: dollar_amount }
  aggregate_drift_dollars: int (SaaS)
  aggregate_drift_account_count: int (SaaS)

  pack-specific config blocks: pql, forecast, critical_shifts, evv,
  care_plan_drift, enrichment, sor_detection, customer_roi
"""
import json
import logging
import random
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

from faker import Faker

from db import (
    Pack as PackModel,
    Source,
    Entity,
    SourceRecord,
    DriftEvent,
    StuckEntity,
    PQLEvent,
    ProductEvent,
    Visit,
)

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Seeder:
    def __init__(self, db_session):
        self.db = db_session
        self.fake = Faker(["en_US"])
        Faker.seed(42)
        random.seed(42)

    # ------------------------------------------------------------------ orchestration
    def seed_all(self) -> None:
        from packs import PACK_REGISTRY  # late import — registry populated by lifespan

        if not PACK_REGISTRY:
            log.warning("seeder: PACK_REGISTRY is empty, nothing to seed")
            return

        for pack in PACK_REGISTRY.values():
            self.seed_pack(pack)

    def seed_pack(self, pack) -> None:
        existing = self.db.query(Entity).filter(Entity.pack_id == pack.id).first()
        if existing:
            log.info("seeder: pack %s already seeded, skipping", pack.id)
            return

        log.info("seeder: starting pack=%s", pack.id)
        self._seed_pack_metadata(pack)
        source_id_lookup = self._seed_sources(pack)
        entity_id_lookup = self._seed_entities(pack)
        self._seed_source_records(pack, source_id_lookup, entity_id_lookup)
        self._seed_drift_events(pack, source_id_lookup, entity_id_lookup)
        self._seed_stuck_entities(pack, entity_id_lookup)

        if pack.id == "saas":
            self._seed_pql_events(pack, entity_id_lookup)
            self._seed_product_events(pack, entity_id_lookup)
        if pack.id == "home-care":
            self._seed_visits(pack, entity_id_lookup)

        self.db.commit()
        log.info("seeder: completed pack=%s", pack.id)

    # ------------------------------------------------------------------ pack metadata
    def _seed_pack_metadata(self, pack) -> None:
        existing = self.db.query(PackModel).filter(PackModel.id == pack.id).first()
        if existing:
            return
        row = PackModel(
            id=pack.id,
            name=pack.name,
            vertical_label=pack.vertical_label,
            terminology_json=pack.terminology or {},
        )
        self.db.add(row)
        self.db.flush()

    # ------------------------------------------------------------------ sources
    def _seed_sources(self, pack) -> dict[str, str]:
        lookup: dict[str, str] = {}
        for source_key, source_meta in pack.sources.items():
            display_name = source_meta.get("display_name", source_key)
            source_type = source_meta.get("source_type", "unknown")
            row = Source(
                pack_id=pack.id,
                source_key=source_key,
                display_name=display_name,
                source_type=source_type,
            )
            self.db.add(row)
            self.db.flush()
            lookup[source_key] = row.id
        return lookup

    # ------------------------------------------------------------------ entities
    def _seed_entities(self, pack) -> dict[str, str]:
        if pack.id == "saas":
            return self._seed_saas_entities(pack)
        if pack.id == "home-care":
            return self._seed_home_care_entities(pack)
        if pack.id == "vertical-ai":
            return self._seed_vertical_ai_entities(pack)
        if pack.id == "sca":
            return self._seed_sca_entities(pack)
        if pack.id == "distribution":
            return self._seed_distribution_entities(pack)
        return {}

    def _make_entity(self, pack_id: str, entity_type: str, name: str, fields: dict, parent_id: str | None = None, confidence: float | None = None) -> Entity:
        ent = Entity(
            pack_id=pack_id,
            entity_type=entity_type,
            canonical_name=name,
            parent_id=parent_id,
            fields=fields,
            confidence=confidence,
            first_seen_at=_now() - timedelta(days=random.randint(30, 720)),
            last_seen_at=_now() - timedelta(hours=random.randint(0, 48)),
        )
        self.db.add(ent)
        self.db.flush()
        return ent

    # --- SaaS entities ---
    def _seed_saas_entities(self, pack) -> dict[str, str]:
        seed = pack.seed or {}
        account_names = seed.get("account_names") or {}
        hero_names = list(account_names.get("hero") or [])
        # Hardcoded fallbacks if seed.yaml is sparse
        canonical_hero = [
            "Meridian Labs",
            "Bridgewater Systems",
            "Northwind Software",
            "Atlas Digital",
            "Cascade Analytics",
            "Pinnacle Group",
            "Lattice Health",
            "Helix Robotics",
        ]
        for n in canonical_hero:
            if n not in hero_names:
                hero_names.append(n)

        ae_names = list(seed.get("ae_names") or ["Sarah Kim", "Mike Reyes", "Jenna Larsson", "Priya Shah"])

        # Hardcoded calibrated drift fixtures
        hero_data = {
            "Meridian Labs":     {"hubspot_seats": 8,  "bigquery_seats": 23, "mrr": 2360, "drift_dollars": 22800, "ae": "Sarah Kim",     "natural_key": "ent_meridian_labs",     "stage": "Closed-Won", "stage_age_days": 180},
            "Bridgewater Systems":{"hubspot_seats": 5, "bigquery_seats": 14, "mrr": 1475, "drift_dollars": 11400, "ae": "Mike Reyes",    "natural_key": "ent_bridgewater_systems","stage": "Closed-Won","stage_age_days": 200},
            "Northwind Software": {"hubspot_seats": 4,"bigquery_seats": 11, "mrr": 1180, "drift_dollars": 7200,  "ae": "Jenna Larsson", "natural_key": "ent_northwind_software","stage": "Closed-Won","stage_age_days": 220},
            "Atlas Digital":      {"hubspot_seats": 0,"bigquery_seats": 23, "mrr": 0,    "drift_dollars": 0,     "ae": "Sarah Kim",     "natural_key": "ent_atlas_digital",     "stage": "Demo",      "stage_age_days": 28, "pql_score": 94},
            "Cascade Analytics":  {"hubspot_seats": 0,"bigquery_seats": 18, "mrr": 0,    "drift_dollars": 0,     "ae": "Mike Reyes",    "natural_key": "ent_cascade_analytics", "stage": "Discovery", "stage_age_days": 22, "pql_score": 87},
            "Pinnacle Group":     {"hubspot_seats": 12,"bigquery_seats": 12,"mrr": 3540, "drift_dollars": 0,     "ae": "Priya Shah",    "natural_key": "ent_pinnacle_group",    "stage": "Negotiation","stage_age_days": 18, "commission_credited_to": "Sarah Kim"},
            "Lattice Health":     {"hubspot_seats": 8, "bigquery_seats": 8, "mrr": 2360, "drift_dollars": 0,     "ae": "Sarah Kim",     "natural_key": "ent_lattice_health",    "stage": "Verbal",    "stage_age_days": 9},
            "Helix Robotics":     {"hubspot_seats": 15,"bigquery_seats": 22,"mrr": 4425, "drift_dollars": 0,     "ae": "Mike Reyes",    "natural_key": "ent_helix_robotics",    "stage": "Negotiation","stage_age_days": 17, "commission_credited_to": "Jenna Larsson"},
        }

        entity_id_lookup: dict[str, str] = {}

        # Hero accounts
        for name in canonical_hero:
            data = hero_data[name]
            fields = {
                "natural_key": data["natural_key"],
                "mrr": data["mrr"],
                "seat_count": data["hubspot_seats"],
                "actual_seats": data["bigquery_seats"],
                "plan_tier": "Growth",
                "hubspot_owner": data["ae"],
                "lifecycle_stage": "customer" if data["mrr"] > 0 else "PQL",
                "pipeline_stage": data["stage"],
                "stage_entered_at": (_now() - timedelta(days=data["stage_age_days"])).isoformat(),
                "dollar_impact_per_field": {"seat_count": data["drift_dollars"]} if data["drift_dollars"] else {},
                "is_hero": True,
            }
            if "pql_score" in data:
                fields["pql_score"] = data["pql_score"]
            if "commission_credited_to" in data:
                fields["commission_credited_to"] = data["commission_credited_to"]
            ent = self._make_entity(pack.id, "account", name, fields)
            entity_id_lookup[name] = ent.id

        # Filler accounts to reach ~500 total entities (~18 with drift)
        filler_count = 492  # 8 hero + 492 filler = 500
        mrr_low, mrr_high = (seed.get("value_generators") or {}).get("mrr_range", [1500, 18000])
        seat_low, seat_high = (seed.get("value_generators") or {}).get("seat_count_range", [3, 80])
        stages = ["Discovery", "Demo", "Negotiation", "Verbal", "Closed-Won", "Closed-Lost"]
        for i in range(filler_count):
            name = self.fake.unique.company()
            mrr = random.randint(mrr_low, mrr_high)
            seats = random.randint(seat_low, seat_high)
            # 10% have drift
            has_drift = random.random() < 0.10
            actual_seats = seats + random.randint(2, 8) if has_drift else seats
            stage = random.choice(stages)
            # ~70% closed (legitimate customers), 30% open
            if random.random() < 0.7:
                stage = random.choice(["Closed-Won", "Closed-Lost"])
            fields = {
                "mrr": mrr,
                "seat_count": seats,
                "actual_seats": actual_seats,
                "plan_tier": random.choice(["Starter", "Growth", "Scale", "Enterprise"]),
                "hubspot_owner": random.choice(ae_names),
                "lifecycle_stage": "customer",
                "pipeline_stage": stage,
                "stage_entered_at": (_now() - timedelta(days=random.randint(1, 60))).isoformat(),
            }
            ent = self._make_entity(pack.id, "account", name, fields)
            entity_id_lookup[f"filler_{i}"] = ent.id

        return entity_id_lookup

    # --- Home Care entities ---
    def _seed_home_care_entities(self, pack) -> dict[str, str]:
        seed = pack.seed or {}
        client_hero = list((seed.get("client_names") or {}).get("hero") or [])
        for n in ("Mr. Henderson", "Mrs. Ada Robinson"):
            if n not in client_hero:
                client_hero.append(n)
        caregiver_hero = list((seed.get("caregiver_names") or {}).get("hero") or [])
        for n in ("Maria Lopez", "Yolanda Torres", "Brittany Williams", "Crystal Hudson", "Marcus Johnson"):
            if n not in caregiver_hero:
                caregiver_hero.append(n)

        entity_id_lookup: dict[str, str] = {}

        # Hero clients — care_plan_last_updated_at is the authoritative timestamp;
        # care_plan_drift.py computes age from it at request time.
        client_data = {
            "Mr. Henderson":     {"natural_key": "client_henderson",  "ltc_carrier": "John Hancock LTC", "ltc_daily_cap": 210, "care_plan_last_updated_at": (_now() - timedelta(days=47)).isoformat(), "billing_method": "private-pay", "authorized_hours_per_week": 28, "drift_signal": "two-person transfers + recent fall", "drift_first_noted": "2026-03-29", "drift_type": "acuity_increase"},
            "Mrs. Ada Robinson": {"natural_key": "client_robinson",   "ltc_carrier": "John Hancock LTC", "ltc_daily_cap": 210, "care_plan_last_updated_at": (_now() - timedelta(days=12)).isoformat(), "billing_method": "LTC",        "authorized_hours_per_week": 28},
        }
        for name, data in client_data.items():
            fields = {
                **data,
                "is_hero": True,
                "pipeline_stage": "Confirmed",
                "stage_entered_at": (_now() - timedelta(days=2)).isoformat(),
            }
            ent = self._make_entity(pack.id, "client", name, fields)
            entity_id_lookup[name] = ent.id

        # Filler clients — timestamp-based age, no pre-baked acuity flag
        for i in range(48):
            name = self.fake.unique.name()
            age_days = random.randint(1, 180)
            fields = {
                "ltc_carrier": random.choice(["John Hancock LTC", "Genworth", "Private Pay", "Private Pay"]),
                "ltc_daily_cap": random.randint(180, 300),
                "care_plan_last_updated_at": (_now() - timedelta(days=age_days)).isoformat(),
                "billing_method": random.choice(["private-pay", "LTC"]),
                "authorized_hours_per_week": random.choice([12, 16, 20, 24, 28, 32, 40]),
                "pipeline_stage": "Confirmed",
                "stage_entered_at": (_now() - timedelta(days=random.randint(1, 90))).isoformat(),
            }
            ent = self._make_entity(pack.id, "client", name, fields)
            entity_id_lookup[f"filler_client_{i}"] = ent.id

        # Hero caregivers
        cg_data = {
            "Maria Lopez":      {"called_off_today": True,  "prior_shifts_with_henderson": 12, "distance_to_henderson_mi": 2.5, "natural_key": "cg_maria_lopez"},
            "Yolanda Torres":   {"called_off_today": False, "prior_shifts_with_henderson": 4,  "distance_to_henderson_mi": 3.2, "natural_key": "cg_yolanda_torres"},
            "Brittany Williams":{"called_off_today": False, "prior_shifts_with_henderson": 1,  "distance_to_henderson_mi": 5.8, "natural_key": "cg_brittany_williams"},
            "Crystal Hudson":   {"called_off_today": False, "prior_shifts_with_henderson": 0,  "distance_to_henderson_mi": 2.1, "natural_key": "cg_crystal_hudson"},
            "Marcus Johnson":   {"called_off_today": False, "prior_shifts_with_henderson": 0,  "distance_to_henderson_mi": 7.4, "natural_key": "cg_marcus_johnson"},
        }
        for name, data in cg_data.items():
            fields = {
                **data,
                "is_hero": True,
                "certifications": ["medication", "ADL", "transfers"],
            }
            ent = self._make_entity(pack.id, "caregiver", name, fields)
            entity_id_lookup[name] = ent.id

        # Filler caregivers
        for i in range(38):
            name = self.fake.unique.name()
            fields = {
                "certifications": random.sample(["medication", "ADL", "transfers", "wound_care", "fall_prevention"], k=random.randint(1, 4)),
                "max_distance_mi": random.choice([5, 8, 10, 15]),
            }
            ent = self._make_entity(pack.id, "caregiver", name, fields)
            entity_id_lookup[f"filler_cg_{i}"] = ent.id

        # Care plans — last_updated mirrors the client's care_plan_last_updated_at
        for client_name in ("Mr. Henderson", "Mrs. Ada Robinson"):
            client_id = entity_id_lookup[client_name]
            fields = {
                "client_id": client_id,
                "last_updated": client_data[client_name]["care_plan_last_updated_at"],
                "tasks": ["medication", "breakfast", "light_housekeeping"] if client_name == "Mr. Henderson" else ["bath", "meal_prep"],
                "current_plan": "ambulatory, minimal assist, independent transfers" if client_name == "Mr. Henderson" else "bath assist, meal prep",
                "inferred_actual": None,  # computed by care_plan_drift.py from shift notes
            }
            ent = self._make_entity(pack.id, "care_plan", f"Care Plan: {client_name}", fields)
            entity_id_lookup[f"careplan_{client_name}"] = ent.id

        # Hero shifts (the 3 unfilled in next 4hr)
        shift_data = [
            {"name": "Shift: Mr. Henderson 7am",    "client": "Mr. Henderson",     "start_offset_min": 58,  "duration_hr": 4, "status": "unfilled", "natural_key": "shift_h_0117"},
            {"name": "Shift: Filler client 9am",    "client": "filler_client_0",   "start_offset_min": 178, "duration_hr": 4, "status": "unfilled", "natural_key": "shift_h_0118"},
            {"name": "Shift: Filler client 11am",   "client": "filler_client_1",   "start_offset_min": 298, "duration_hr": 4, "status": "unfilled", "natural_key": "shift_h_0119"},
        ]
        for sd in shift_data:
            client_id = entity_id_lookup.get(sd["client"])
            start = _now() + timedelta(minutes=sd["start_offset_min"])
            end = start + timedelta(hours=sd["duration_hr"])
            fields = {
                "natural_key": sd["natural_key"],
                "client_id": client_id,
                "scheduled_start": start.isoformat(),
                "scheduled_end": end.isoformat(),
                "status": sd["status"],
                "care_needs": ["medication reminder", "breakfast prep", "light housekeeping"],
                "sla_minutes_until_start": sd["start_offset_min"],
                "pipeline_stage": "Scheduled",
                "stage_entered_at": (_now() - timedelta(hours=8)).isoformat(),
                "is_hero": True,
                "shift_start": f"{(start.hour % 12) or 12}:00am" if start.hour < 12 else f"{(start.hour % 12) or 12}:00pm",
                "shift_end": f"{(end.hour % 12) or 12}:00am" if end.hour < 12 else f"{(end.hour % 12) or 12}:00pm",
            }
            # Add call-off data to hero Henderson shift
            if sd["client"] == "Mr. Henderson":
                fields.update({
                    "call_off_caregiver": "Maria Lopez",
                    "call_off_time": "6:02am",
                    "call_off_reason": "flu",
                    "authorized_hours_per_day": 4,
                    "billing_type": "private pay",
                    "shift_start": "7:00am",
                    "shift_end": "11:00am",
                })
            ent = self._make_entity(pack.id, "shift", sd["name"], fields)
            entity_id_lookup[sd["name"]] = ent.id

        # Shift notes for Henderson (acuity drift evidence)
        henderson_id = entity_id_lookup.get("Mr. Henderson")
        if henderson_id:
            shift_notes = [
                {"date": "3/29", "quote": "client having more trouble getting out of bed, asked me to help him sit up before transferring. Took longer this morning."},
                {"date": "4/01", "quote": "needed two-person assist for transfer to chair. Unusual for him."},
                {"date": "4/04", "quote": "wife mentioned he fell last weekend before bed. No visible injury."},
                {"date": "4/06", "quote": "took 25 min for what used to be a 10 min transfer. He apologized."},
            ]
            for note in shift_notes:
                self._make_entity(
                    pack.id, "shift_note",
                    f"Note: Henderson {note['date']}",
                    {"date": note["date"], "quote": note["quote"], "drift_signal": True},
                    parent_id=henderson_id,
                )

        # Filler shifts (~400 over the past 30 days)
        for i in range(400):
            day_offset = random.randint(0, 30)
            start = _now() - timedelta(days=day_offset, hours=random.randint(0, 12))
            end = start + timedelta(hours=4)
            fields = {
                "scheduled_start": start.isoformat(),
                "scheduled_end": end.isoformat(),
                "status": "completed",
                "pipeline_stage": "Completed",
                "stage_entered_at": end.isoformat(),
            }
            ent = self._make_entity(pack.id, "shift", f"Shift {i}", fields)
            entity_id_lookup[f"filler_shift_{i}"] = ent.id

        return entity_id_lookup

    # --- Vertical AI entities ---
    def _seed_vertical_ai_entities(self, pack) -> dict[str, str]:
        seed = pack.seed or {}
        practice_hero = list((seed.get("practice_names") or {}).get("hero") or [])
        for n in ("Smile Dental of Tampa", "Beachside Family Dentistry"):
            if n not in practice_hero:
                practice_hero.append(n)
        dso_names = list(seed.get("dso_names") or ["Heartland Dental", "Aspen Dental", "MB2 Dental", "Pacific Dental Services"])

        entity_id_lookup: dict[str, str] = {}

        # DSO parent entities
        dso_data = {
            "Heartland Dental":          {"natural_key": "ent_heartland",       "existing_msa": True,  "warm_contacts": 2,  "owned_practice_count": 31},
            "Aspen Dental":              {"natural_key": "ent_aspen",           "existing_msa": False, "warm_contacts": 0,  "owned_practice_count": 18},
            "MB2 Dental":                {"natural_key": "ent_mb2",             "existing_msa": False, "warm_contacts": 0,  "owned_practice_count": 12},
            "Pacific Dental Services":   {"natural_key": "ent_pacific",         "existing_msa": False, "warm_contacts": 0,  "owned_practice_count": 7},
        }
        for name, data in dso_data.items():
            fields = {**data, "is_dso": True, "is_hero": True}
            ent = self._make_entity(pack.id, "dso", name, fields)
            entity_id_lookup[name] = ent.id

        # Hero practices
        smile_dental = self._make_entity(
            pack.id,
            "practice",
            "Smile Dental of Tampa",
            {
                "natural_key": "ent_smile_dental_tampa",
                "state": "FL",
                "practice_size_employees": 8,
                "parent_dso_id": None,  # initially classified as independent
                "detected_pms": "Eaglesoft",
                "detection_confidence": 0.88,
                "prospect_status": "active",
                "account_owner_team": "SMB",
                "verdict_parent_dso": "Heartland Dental",  # the agent's verdict
                "verdict_confidence": 0.96,
                "sunbiz_filing_date": "2025-12-08",
                "sunbiz_filing_type": "Articles of Merger",
                "is_hero": True,
                "dollar_impact_per_field": {"parent_dso_id": 180000},
                "pipeline_stage": "Qualified",
                "stage_entered_at": (_now() - timedelta(days=18)).isoformat(),
                # Enrichment waterfall source signals (queried by enrichment_waterfall.py)
                "apollo_says_employees": 12,
                "apollo_says_parent": "Heartland Dental",
                "zoominfo_says_employees": 8,
                "zoominfo_says_independent": True,
                "linkedin_office_manager_changed_at": "2026-03-25",
                "web_scrape_footer_match": True,
                "warm_contacts_at_heartland_hq": 2,
            },
        )
        entity_id_lookup["Smile Dental of Tampa"] = smile_dental.id

        beachside = self._make_entity(
            pack.id,
            "practice",
            "Beachside Family Dentistry",
            {
                "natural_key": "ent_beachside_family_dentistry",
                "state": "FL",
                "practice_size_employees": 6,
                "parent_dso_id": None,
                "detected_pms": "Eaglesoft",
                "detection_confidence": 0.88,
                "detection_signals": [
                    "Patterson Innovation Connection portal markup detected in <head> (Patterson-hosted patient engagement library)",
                    "Indeed job 2025-12: 'front desk, Eaglesoft 2 yrs req'",
                    "Patterson Dental partner case study mention (2023)",
                    "Patient portal subdomain (patient.beachsidefamilydental.com) resolves to a Patterson-hosted endpoint",
                ],
                "prospect_status": "active",
                "is_hero": True,
                "pipeline_stage": "New",
                "stage_entered_at": (_now() - timedelta(days=5)).isoformat(),
            },
        )
        entity_id_lookup["Beachside Family Dentistry"] = beachside.id

        # Health River customer (parent + 12 location children)
        health_river = self._make_entity(
            pack.id,
            "customer",
            "Health River Dental Group",
            {
                "natural_key": "customer_health_river",
                "location_count": 12,
                "active_locations": 11,
                "arr": 180000,
                "renewal_in_days": 47,
                "case_acceptance_baseline_pct": 38.4,
                "case_acceptance_current_pct": 43.7,
                "is_hero": True,
            },
        )
        entity_id_lookup["Health River Dental Group"] = health_river.id

        # Baselines scattered realistically (32-44 range, non-sequential).
        # annual_production is per-location gross production in dollars,
        # used by the compute module to derive incremental revenue from lift.
        location_data = [
            ("Tampa Main",  38, 44, "ok",      680000),
            ("Sarasota",    34, 43, "ok",      520000),
            ("St. Pete",    42, 43, "warning", 610000),
            ("Clearwater",  37, 37, "flat",    490000),
            ("Brandon",     33, 47, "ok",      730000),
            ("Largo",       40, 44, "ok",      550000),
            ("Riverview",   36, 43, "ok",      470000),
            ("Carrollwood", 44, 46, "ok",      580000),
            ("Wesley Chapel",35,45, "ok",      510000),
            ("Lutz",        39, 43, "ok",      440000),
            ("Plant City",  41, 44, "ok",      390000),
            ("Apollo Beach",32, 42, "ok",      460000),
        ]
        for loc_name, baseline, current, status, production in location_data:
            ent = self._make_entity(
                pack.id,
                "location",
                f"Health River - {loc_name}",
                {
                    "parent_customer_id": health_river.id,
                    "case_acceptance_baseline_pct": baseline,
                    "case_acceptance_current_pct": current,
                    "annual_production": production,
                    "status": status,
                },
                parent_id=health_river.id,
            )
            entity_id_lookup[f"location_{loc_name}"] = ent.id

        # Filler practices to reach ~500 prospects, 73 reclassified
        for i in range(485):
            name = self.fake.unique.company() + " Dental"
            is_dso_owned = random.random() < (73 / 500)
            parent_dso = random.choice(dso_names) if is_dso_owned else None
            fields = {
                "state": random.choice(["FL", "TX", "CA", "NY", "GA"]),
                "practice_size_employees": random.randint(4, 24),
                "parent_dso_id": entity_id_lookup.get(parent_dso) if parent_dso else None,
                "detected_pms": random.choice(["Dentrix", "Eaglesoft", "Open Dental", "Curve Dental", "Denticon", "Carestream", "Sirona", None]),
                "detection_confidence": round(random.uniform(0.45, 0.99), 2),
                "prospect_status": "active",
                "account_owner_team": "enterprise" if is_dso_owned else "SMB",
                "pipeline_stage": random.choice(["New", "Qualified", "Demo", "Negotiation"]),
                "stage_entered_at": (_now() - timedelta(days=random.randint(1, 30))).isoformat(),
            }
            ent = self._make_entity(pack.id, "practice", name, fields)
            entity_id_lookup[f"filler_practice_{i}"] = ent.id

        return entity_id_lookup

    # --- SCA entities ---
    def _seed_sca_entities(self, pack) -> dict[str, str]:
        seed = pack.seed or {}
        prospect_names = seed.get("prospect_names") or {}
        hero_names = list(prospect_names.get("hero") or [])
        filler_names = list(prospect_names.get("filler") or [])

        entity_id_lookup: dict[str, str] = {}

        # Hero prospects (named in deal/trigger/coverage scenarios)
        for name in hero_names:
            ent = self._make_entity(
                pack.id, "prospect", name,
                {"is_hero": True, "prospect_status": "active"},
            )
            entity_id_lookup[name] = ent.id

        # Filler prospects
        for name in filler_names:
            ent = self._make_entity(
                pack.id, "prospect", name,
                {"is_hero": False, "prospect_status": "active"},
            )
            entity_id_lookup[name] = ent.id

        # --- Deal entities (Multi-Threaded Deal scenario) ---
        # Threads store last_touch_at as ISO timestamps (computed from _now()).
        # The compute module derives days_since at request time.
        now = _now()
        def _touch_at(days_ago: int | None) -> str | None:
            if days_ago is None:
                return None
            return (now - timedelta(days=days_ago)).isoformat()

        deal_data = [
            {"company": "Vericode", "deal_stage": "POC", "deal_amount": 142000, "assigned_ae": "Jordan Reeves",
             "threads": [
                 {"role": "engineering", "contact": "Sam Torres, Staff Engineer", "last_touch_at": _touch_at(3), "last_trial_scan_at": _touch_at(2), "status": "active", "detail": "Ran CI integration on 4 repos, reviewing false-positive rates"},
                 {"role": "legal", "contact": "Diana Park, Associate GC", "last_touch_at": _touch_at(19), "last_trial_scan_at": None, "status": "stalled", "detail": "Requested copyleft attribution report, no follow-up since"},
                 {"role": "security", "contact": "Raj Mehta, CISO", "last_touch_at": _touch_at(24), "last_trial_scan_at": None, "status": "stalled", "detail": "Submitted vendor risk questionnaire, awaiting response"},
             ]},
            {"company": "Meridian Federal Solutions", "deal_stage": "Legal/Procurement", "deal_amount": 178000, "assigned_ae": "Marcus Whitfield",
             "threads": [
                 {"role": "engineering", "contact": "Alex Drummond, DevOps Lead", "last_touch_at": _touch_at(31), "last_trial_scan_at": _touch_at(28), "status": "stalled", "detail": "POC completed, waiting on legal to clear procurement"},
                 {"role": "legal", "contact": "Karen Liu, Senior Counsel", "last_touch_at": _touch_at(8), "last_trial_scan_at": None, "status": "active", "detail": "Reviewing SBOM format compliance with federal attestation requirements"},
                 {"role": "security", "contact": "Tom Baskin, ISSO", "last_touch_at": _touch_at(14), "last_trial_scan_at": None, "status": "stalled", "detail": "Cleared the vendor risk assessment, waiting on legal sign-off"},
             ]},
            {"company": "Archway Fintech", "deal_stage": "POC", "deal_amount": 56000, "assigned_ae": "Alyssa Chen",
             "threads": [
                 {"role": "engineering", "contact": "Wei Zhang, Platform Engineer", "last_touch_at": _touch_at(2), "last_trial_scan_at": _touch_at(1), "status": "active", "detail": "Actively scanning 6 repos, filed 2 false-positive reports"},
                 {"role": "legal", "contact": "Maria Santos, Compliance Manager", "last_touch_at": _touch_at(12), "last_trial_scan_at": None, "status": "stalled", "detail": "Requested PCI DSS 4.0 component inventory mapping, no response yet"},
                 {"role": "security", "contact": None, "last_touch_at": None, "last_trial_scan_at": None, "status": "no_contact", "detail": "No security contact identified on this opportunity"},
             ]},
            {"company": "NexGen Payments", "deal_stage": "Security Review", "deal_amount": 94000, "assigned_ae": "Alyssa Chen",
             "threads": [
                 {"role": "engineering", "contact": "Chris Novak, VP Engineering", "last_touch_at": _touch_at(6), "last_trial_scan_at": _touch_at(5), "status": "active", "detail": "Scanning 2 repos, testing SPDX export for PCI audit"},
                 {"role": "legal", "contact": None, "last_touch_at": None, "last_trial_scan_at": None, "status": "no_contact", "detail": "No legal contact identified on this opportunity"},
                 {"role": "security", "contact": "Priya Sato, Security Lead", "last_touch_at": _touch_at(4), "last_trial_scan_at": None, "status": "active", "detail": "Reviewing vulnerability database coverage, comparing to Snyk"},
             ]},
        ]
        for d in deal_data:
            prospect_id = entity_id_lookup.get(d["company"])
            self._make_entity(
                pack.id, "deal", f"Deal: {d['company']}",
                {**d, "is_hero": True},
                parent_id=prospect_id,
            )

        # --- Compliance event entities (Compliance Trigger scenario) ---
        trigger_data = [
            {"company": "Tessera Health", "event_type": "m_and_a", "event_label": "Acquired by Palantir Health Systems", "event_detail": "Announced 12 days ago. Acquirer requires SBOM audit of all target company software assets before close.", "days_since": 12, "base_fit_score": 0.95, "assigned_ae": "Jordan Reeves"},
            {"company": "Cloudspan", "event_type": "cra_deadline", "event_label": "EU CRA vulnerability reporting deadline", "event_detail": "Sells SaaS product to EU customers. September 2026 vulnerability reporting requirement is 5 months out.", "days_since": 0, "months_to_deadline": 5, "base_fit_score": 0.90, "assigned_ae": "Alyssa Chen"},
            {"company": "NexGen Payments", "event_type": "pci_dss", "event_label": "PCI DSS 4.0 audit due", "event_detail": "Payment processor. Requirement 6.3.2 component inventory audit scheduled for Q3. Currently no SBOM tooling in place.", "days_since": 0, "months_to_deadline": 3, "base_fit_score": 0.88, "assigned_ae": "Alyssa Chen"},
            {"company": "Beacon Platform", "event_type": "job_signal", "event_label": "Hiring SBOM Program Manager", "event_detail": "Posted 8 days ago on LinkedIn. Job description references SPDX, CycloneDX, and federal attestation requirements.", "days_since": 8, "base_fit_score": 0.70, "assigned_ae": None},
            {"company": "Stratos Software", "event_type": "m_and_a", "event_label": "Series D from Vista Equity", "event_detail": "Announced 34 days ago. Vista typically requires open-source license audits within first 90 days of investment.", "days_since": 34, "base_fit_score": 0.65, "assigned_ae": None},
            {"company": "Ridgeline Systems", "event_type": "ai_code_adoption", "event_label": "Deploying GitHub Copilot at scale", "event_detail": "Engineering blog post 22 days ago announced org-wide Copilot rollout. 400+ developers. No mention of license scanning for generated code.", "days_since": 22, "base_fit_score": 0.60, "assigned_ae": None},
        ]
        for t in trigger_data:
            prospect_id = entity_id_lookup.get(t["company"])
            detected_at = (_now() - timedelta(days=t["days_since"])).isoformat()
            self._make_entity(
                pack.id, "compliance_event",
                f"Trigger: {t['company']} - {t['event_type']}",
                {**t, "detected_at": detected_at, "is_hero": True},
                parent_id=prospect_id,
            )

        # --- Customer account + repo entities (Repo Coverage scenario) ---
        hero_acct = self._make_entity(
            pack.id, "customer_account", "Vericode",
            {"company": "Vericode", "contract_arr": 142000, "per_repo_rate": 950, "is_hero": True},
        )
        entity_id_lookup["Vericode_account"] = hero_acct.id

        repo_data = [
            ("vericode/api-gateway", "Go", "1 day ago", True, 142),
            ("vericode/web-client", "TypeScript", "2 days ago", True, 387),
            ("vericode/auth-service", "Python", "3 days ago", True, 98),
            ("vericode/billing-engine", "Go", "1 day ago", False, None),
            ("vericode/data-pipeline", "Python", "4 days ago", False, None),
            ("vericode/ml-models", "Python", "2 days ago", False, None),
            ("vericode/mobile-ios", "Swift", "6 days ago", False, None),
            ("vericode/mobile-android", "Kotlin", "5 days ago", False, None),
            ("vericode/infra-terraform", "HCL", "3 days ago", False, None),
            ("vericode/docs", "Markdown", "12 days ago", False, None),
            ("vericode/sdk-node", "TypeScript", "8 days ago", False, None),
            ("vericode/sdk-python", "Python", "9 days ago", False, None),
        ]
        for name, lang, commit, scanned, deps in repo_data:
            self._make_entity(
                pack.id, "repo", name,
                {"language": lang, "last_commit": commit, "scanned": scanned, "dependencies": deps},
                parent_id=hero_acct.id,
            )
        # Pad to 47 total repos (35 generated filler)
        for i in range(12, 47):
            self._make_entity(
                pack.id, "repo", f"vericode/internal-{i + 1}",
                {"language": "Go", "last_commit": None, "scanned": False, "dependencies": None},
                parent_id=hero_acct.id,
            )

        # Filler customer accounts — child repo entities created below so
        # repo_coverage.py computes stats from DB rows (same as hero account).
        filler_acct_data = [
            ("Cloudspan", 88000, 950, [
                ("cloudspan/api-gateway", "TypeScript", True, True),
                ("cloudspan/billing-service", "Go", True, True),
                ("cloudspan/infra-terraform", "HCL", False, True),
                ("cloudspan/docs", "Markdown", False, False),
            ]),
            ("NexGen Payments", 94000, 950, [
                ("nexgen/core-ledger", "Java", True, True),
                ("nexgen/fraud-engine", "Python", True, True),
                ("nexgen/mobile-app", "Kotlin", False, True),
                ("nexgen/compliance-reports", "SQL", True, True),
                ("nexgen/legacy-portal", "PHP", False, False),
            ]),
            ("Meridian Federal Solutions", 178000, 950, [
                ("meridian/auth-service", "Rust", True, True),
                ("meridian/data-pipeline", "Python", True, True),
                ("meridian/web-portal", "TypeScript", True, True),
                ("meridian/ci-templates", "YAML", False, True),
                ("meridian/internal-tools", "Go", False, True),
            ]),
            ("Tessera Health", 56000, 950, [
                ("tessera/patient-api", "Python", True, True),
                ("tessera/ehr-connector", "Java", True, True),
                ("tessera/analytics", "R", False, True),
            ]),
        ]
        for company, arr, rate, repos in filler_acct_data:
            acct = self._make_entity(
                pack.id, "customer_account", company,
                {"company": company, "contract_arr": arr,
                 "per_repo_rate": rate, "is_hero": False},
            )
            for repo_name, lang, scanned, active in repos:
                self._make_entity(
                    pack.id, "repo", repo_name,
                    {"language": lang, "scanned": scanned,
                     "last_commit": (_now() - timedelta(days=random.randint(1, 90))).isoformat() if active else None,
                     "dependencies": random.randint(12, 85) if scanned else None},
                    parent_id=acct.id,
                )

        return entity_id_lookup

    # --- Distribution entities ---
    def _seed_distribution_entities(self, pack) -> dict[str, str]:
        seed = pack.seed or {}
        prospect_names = seed.get("prospect_names") or {}
        hero_names = list(prospect_names.get("hero") or [])
        filler_names = list(prospect_names.get("filler") or [])

        entity_id_lookup: dict[str, str] = {}

        # ERP detection signal data per prospect
        erp_data = {
            "Consolidated Electrical Distributors": {
                "sub_vertical": "Electrical", "branch_count": 22, "company": "Consolidated Electrical Distributors",
                "signals": [
                    {"source": "job_posting", "detail": "Indeed posting: 'Prophet 21 System Administrator, 3+ years'", "found": True},
                    {"source": "vendor_directory", "detail": "Listed in Epicor partner success stories (2024)", "found": True},
                    {"source": "trade_show", "detail": "Exhibitor at Epicor Insights 2025 conference", "found": True},
                    {"source": "technographic", "detail": "6sense profile shows Epicor match", "found": False},
                ],
            },
            "Mountain West Industrial": {
                "sub_vertical": "MRO / Industrial", "branch_count": 14, "company": "Mountain West Industrial",
                "signals": [
                    {"source": "job_posting", "detail": "No ERP-specific keywords in 12 recent postings", "found": False},
                    {"source": "vendor_directory", "detail": "Not found in Epicor, SAP, or NetSuite directories", "found": False},
                    {"source": "trade_show", "detail": "Exhibited at ISA (Industrial Supply Association) 2025", "found": True},
                    {"source": "technographic", "detail": "No match in 6sense", "found": False},
                ],
            },
            "Granite State Plumbing Supply": {
                "sub_vertical": "Plumbing / PVF", "branch_count": 6, "company": "Granite State Plumbing Supply",
                "signals": [
                    {"source": "job_posting", "detail": "LinkedIn job: 'Warehouse Manager, NetSuite experience preferred'", "found": True},
                    {"source": "vendor_directory", "detail": "No match in NetSuite customer directory", "found": False},
                    {"source": "trade_show", "detail": "Attended SuiteWorld 2025 (badge scan data)", "found": True},
                    {"source": "technographic", "detail": "6sense shows NetSuite ERP match", "found": True},
                ],
            },
            "Heartland HVAC Parts": {
                "sub_vertical": "HVAC", "branch_count": 9, "company": "Heartland HVAC Parts",
                "signals": [
                    {"source": "job_posting", "detail": "Glassdoor review mentions 'Eclipse system' in daily workflow", "found": True},
                    {"source": "vendor_directory", "detail": "No match in Epicor Eclipse directory", "found": False},
                    {"source": "trade_show", "detail": "AHR Expo 2025 exhibitor", "found": True},
                    {"source": "technographic", "detail": "No match in 6sense", "found": False},
                ],
            },
            "Pacific Pipe & Supply": {
                "sub_vertical": "PVF", "branch_count": 4, "company": "Pacific Pipe & Supply",
                "signals": [
                    {"source": "job_posting", "detail": "Indeed: 'Inside Sales, Acumatica distribution module experience'", "found": True},
                    {"source": "vendor_directory", "detail": "Acumatica customer case study (2023)", "found": True},
                    {"source": "trade_show", "detail": "No relevant trade show signal", "found": False},
                    {"source": "technographic", "detail": "6sense shows Acumatica match", "found": True},
                ],
            },
        }

        for name in hero_names:
            extra = erp_data.get(name, {})
            ent = self._make_entity(
                pack.id, "prospect", name,
                {"is_hero": True, "prospect_status": "active", **extra},
            )
            entity_id_lookup[name] = ent.id

        for name in filler_names:
            ent = self._make_entity(
                pack.id, "prospect", name,
                {"is_hero": False, "prospect_status": "active"},
            )
            entity_id_lookup[name] = ent.id

        # --- Trial entities (POV Pipeline scenario) ---
        trial_data = [
            {"company": "Granite State Plumbing Supply", "deal_stage": "POV", "deal_amount": 96000, "assigned_ae": "Samantha Voss",
             "trial_start": "2026-03-28", "trial_end": "2026-04-11",
             "thresholds": {"accuracy": 0.90, "orders_per_day": 100, "fte_savings": 2.0, "error_rate": 0.05},
             "metrics": {"accuracy": 0.94, "accuracy_trend": "stable", "orders_per_day": 218, "fte_savings": 3.1, "error_rate": 0.028, "error_rate_baseline": 0.072}},
            {"company": "Heartland HVAC Parts", "deal_stage": "POV", "deal_amount": 142000, "assigned_ae": "Derek Hollis",
             "trial_start": "2026-04-01", "trial_end": "2026-04-15",
             "thresholds": {"accuracy": 0.90, "orders_per_day": 150, "fte_savings": 2.5, "error_rate": 0.05},
             "metrics": {"accuracy": 0.87, "accuracy_trend": "improving", "orders_per_day": 164, "fte_savings": 2.2, "error_rate": 0.061, "error_rate_baseline": 0.089}},
            {"company": "Mountain West Industrial", "deal_stage": "POV", "deal_amount": 210000, "assigned_ae": "Carlos Ruiz",
             "trial_start": "2026-04-05", "trial_end": "2026-04-19",
             "thresholds": {"accuracy": 0.90, "orders_per_day": 200, "fte_savings": 3.0, "error_rate": 0.05},
             "metrics": {"accuracy": 0.91, "accuracy_trend": "stable", "orders_per_day": 187, "fte_savings": 2.8, "error_rate": 0.043, "error_rate_baseline": 0.095}},
        ]
        for t in trial_data:
            prospect_id = entity_id_lookup.get(t["company"])
            self._make_entity(
                pack.id, "trial", f"POV: {t['company']}",
                {**t, "is_hero": True},
                parent_id=prospect_id,
            )

        # --- Acquisition entities (PE Trigger Window scenario) ---
        pe_data = [
            {"pe_firm": "Platinum Equity", "deal_type": "Acquisition", "target_company": "R&B Wholesale Distributors", "sub_vertical": "Foodservice / Janitorial", "acquisition_date": "2026-02-14", "base_fit_score": 88, "revenue_band": "$200M-$500M", "geography": "Western US", "assigned_ae": "Carlos Ruiz", "context": "Platinum targets operational efficiency in distribution. R&B has 12 branches across 4 states, processing 800+ orders/day by phone and email."},
            {"pe_firm": "QXO Inc.", "deal_type": "Roll-up", "target_company": "Beacon Roofing Supply", "sub_vertical": "Roofing / Construction", "acquisition_date": "2026-01-22", "base_fit_score": 72, "revenue_band": "$5B+", "geography": "National", "assigned_ae": "Derek Hollis", "context": "QXO's stated thesis is digitizing analog distribution. Beacon is the largest US roofing distributor. Enterprise deal, long cycle."},
            {"pe_firm": "WinSupply", "deal_type": "Roll-up", "target_company": "R.A. Novia Associates", "sub_vertical": "Plumbing / HVAC", "acquisition_date": "2026-03-18", "base_fit_score": 91, "revenue_band": "$10M-$50M", "geography": "Connecticut", "assigned_ae": "Samantha Voss", "context": "WinSupply acquires 3-5 regional distributors per year. R.A. Novia is their third 2026 acquisition. Standard integration playbook includes technology audit in first 60 days."},
            {"pe_firm": "Clearlake Capital", "deal_type": "Acquisition", "target_company": "Kaman Distribution", "sub_vertical": "Industrial / MRO", "acquisition_date": "2026-03-02", "base_fit_score": 79, "revenue_band": "$500M-$1B", "geography": "National", "assigned_ae": None, "context": "Clearlake has a distribution vertical thesis. Kaman Distribution Group spun off from Kaman Aerospace. 200+ branches, complex ERP landscape."},
            {"pe_firm": "KKR", "deal_type": "Carve-out", "target_company": "HD Supply Facilities Maintenance", "sub_vertical": "MRO / Facilities", "acquisition_date": "2026-01-08", "base_fit_score": 65, "revenue_band": "$1B+", "geography": "National", "assigned_ae": None, "context": "Window closing. If no outreach has happened, this trigger is likely stale. Low priority."},
        ]
        for p in pe_data:
            self._make_entity(
                pack.id, "acquisition",
                f"PE: {p['pe_firm']} \u2192 {p['target_company']}",
                {**p, "is_hero": True},
            )

        return entity_id_lookup

    # ------------------------------------------------------------------ source records
    def _seed_source_records(self, pack, source_id_lookup, entity_id_lookup) -> None:
        # Use connector_data from pack.seed for hero entities; generate filler.
        connector_data = (pack.seed or {}).get("connector_data") or {}

        # First: emit canned source records from pack.seed.connector_data
        for source_key, rows in connector_data.items():
            source_id = source_id_lookup.get(source_key)
            if source_id is None:
                continue
            for row in rows:
                # Try to link to an entity by canonical name
                canonical = row.get("canonical") or {}
                name_candidate = (
                    canonical.get("canonical_name")
                    or canonical.get("name")
                    or canonical.get("client_name")
                    or canonical.get("practice_name")
                )
                entity_id = entity_id_lookup.get(name_candidate) if name_candidate else None
                sr = SourceRecord(
                    pack_id=pack.id,
                    source_id=source_id,
                    entity_id=entity_id,
                    source_external_id=row["source_external_id"],
                    natural_key=row.get("natural_key", row["source_external_id"]),
                    raw_snapshot=row.get("raw") or canonical,
                    field_hash=self._hash(canonical),
                    pulled_at=_now(),
                )
                self.db.add(sr)

        # Second: for filler entities, generate 2-3 source records each (one per source)
        # Just for the SaaS pack to keep the demo small.
        if pack.id == "saas":
            self._generate_filler_saas_source_records(pack, source_id_lookup, entity_id_lookup)

        self.db.flush()

    def _hash(self, payload: dict) -> str:
        import hashlib
        return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:16]

    def _generate_filler_saas_source_records(self, pack, source_id_lookup, entity_id_lookup) -> None:
        hubspot_id = source_id_lookup.get("hubspot")
        bigquery_id = source_id_lookup.get("bigquery")
        stripe_id = source_id_lookup.get("stripe")

        for key, entity_id in entity_id_lookup.items():
            if not key.startswith("filler_"):
                continue
            entity = self.db.get(Entity, entity_id)
            if entity is None or entity.entity_type != "account":
                continue
            fields = entity.fields or {}
            seats = fields.get("seat_count", 0)
            actual_seats = fields.get("actual_seats", seats)
            mrr = fields.get("mrr", 0)

            if hubspot_id:
                hub_canonical = {"canonical_name": entity.canonical_name, "seat_count": seats, "mrr": mrr}
                self.db.add(SourceRecord(
                    pack_id=pack.id, source_id=hubspot_id, entity_id=entity.id,
                    source_external_id=f"hs_{entity.id[:8]}",
                    natural_key=f"hs_{entity.canonical_name.lower().replace(' ', '_')[:30]}",
                    raw_snapshot={"id": entity.id, "properties": hub_canonical, "archived": False},
                    field_hash=self._hash(hub_canonical),
                    pulled_at=_now(),
                ))
            if bigquery_id:
                bq_canonical = {"canonical_name": entity.canonical_name, "seat_count": actual_seats}
                self.db.add(SourceRecord(
                    pack_id=pack.id, source_id=bigquery_id, entity_id=entity.id,
                    source_external_id=f"bq_{entity.id[:8]}",
                    natural_key=f"bq_{entity.canonical_name.lower().replace(' ', '_')[:30]}",
                    raw_snapshot=bq_canonical,
                    field_hash=self._hash(bq_canonical),
                    pulled_at=_now(),
                ))
            if stripe_id:
                stripe_canonical = {"canonical_name": entity.canonical_name, "mrr": mrr}
                self.db.add(SourceRecord(
                    pack_id=pack.id, source_id=stripe_id, entity_id=entity.id,
                    source_external_id=f"stripe_{entity.id[:8]}",
                    natural_key=f"stripe_{entity.canonical_name.lower().replace(' ', '_')[:30]}",
                    raw_snapshot=stripe_canonical,
                    field_hash=self._hash(stripe_canonical),
                    pulled_at=_now(),
                ))

    # ------------------------------------------------------------------ drift events
    def _seed_drift_events(self, pack, source_id_lookup, entity_id_lookup) -> None:
        if pack.id == "saas":
            self._seed_saas_drift_events(pack, source_id_lookup, entity_id_lookup)
        elif pack.id == "home-care":
            self._seed_home_care_drift_events(pack, source_id_lookup, entity_id_lookup)
        elif pack.id == "vertical-ai":
            self._seed_vertical_ai_drift_events(pack, source_id_lookup, entity_id_lookup)

    def _seed_saas_drift_events(self, pack, source_id_lookup, entity_id_lookup) -> None:
        hubspot_id = source_id_lookup.get("hubspot")
        bigquery_id = source_id_lookup.get("bigquery")
        if not (hubspot_id and bigquery_id):
            return

        canonical_drifts = [
            {"name": "Meridian Labs",      "field": "seat_count", "value_a": "8",  "value_b": "23", "dollars": 22800, "days_ago": 6},
            {"name": "Bridgewater Systems","field": "seat_count", "value_a": "5",  "value_b": "14", "dollars": 11400, "days_ago": 12},
            {"name": "Northwind Software", "field": "seat_count", "value_a": "4",  "value_b": "11", "dollars": 7200,  "days_ago": 9},
        ]

        for d in canonical_drifts:
            entity_id = entity_id_lookup.get(d["name"])
            if not entity_id:
                continue
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=entity_id,
                field_name=d["field"],
                source_a_id=hubspot_id,
                value_a=d["value_a"],
                source_b_id=bigquery_id,
                value_b=d["value_b"],
                dollar_impact=d["dollars"],
                detected_at=_now() - timedelta(days=d["days_ago"]),
            ))

        # Add 6-9 more random drifts on filler entities to reach ~12 total.
        # Walk filler entities until we find 9 with seat drift.
        filler_keys = [k for k in entity_id_lookup if k.startswith("filler_")]
        added = 0
        for key in filler_keys:
            if added >= 9:
                break
            entity_id = entity_id_lookup[key]
            entity = self.db.get(Entity, entity_id)
            fields = entity.fields or {}
            seats = fields.get("seat_count", 0)
            actual = fields.get("actual_seats", seats)
            if seats == actual:
                continue
            dollar_impact = random.randint(3000, 18000)
            added += 1
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=entity_id,
                field_name="seat_count",
                source_a_id=hubspot_id,
                value_a=str(seats),
                source_b_id=bigquery_id,
                value_b=str(actual),
                dollar_impact=dollar_impact,
                detected_at=_now() - timedelta(days=random.randint(1, 14)),
            ))

    def _seed_home_care_drift_events(self, pack, source_id_lookup, entity_id_lookup) -> None:
        sandata_id = source_id_lookup.get("sandata")
        wellsky_id = source_id_lookup.get("wellsky_personal_care")

        # Hero drift: Mrs. Ada Robinson 4/3/26 visit overage
        robinson_id = entity_id_lookup.get("Mrs. Ada Robinson")
        if robinson_id and sandata_id and wellsky_id:
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=robinson_id,
                field_name="clocked_out_at",
                source_a_id=sandata_id,
                value_a="12:42",
                source_b_id=wellsky_id,
                value_b="12:00",
                dollar_impact=14.10,
                detected_at=_now() - timedelta(days=7),
            ))
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=robinson_id,
                field_name="task_list",
                source_a_id=sandata_id,
                value_a='["bath", "meal_prep", "laundry"]',
                source_b_id=wellsky_id,
                value_b='["bath", "meal_prep"]',
                dollar_impact=None,
                detected_at=_now() - timedelta(days=7),
            ))

        # 9 more across the 47 mismatch population — pick filler shifts
        filler_shifts = [k for k in entity_id_lookup if k.startswith("filler_shift_")][:9]
        for k in filler_shifts:
            shift_id = entity_id_lookup[k]
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=shift_id,
                field_name="clocked_out_at",
                source_a_id=sandata_id,
                value_a="varies",
                source_b_id=wellsky_id,
                value_b="varies",
                dollar_impact=round(random.uniform(8.0, 35.0), 2),
                detected_at=_now() - timedelta(days=random.randint(1, 28)),
            ))

    def _seed_vertical_ai_drift_events(self, pack, source_id_lookup, entity_id_lookup) -> None:
        zoominfo_id = source_id_lookup.get("zoominfo")
        apollo_id = source_id_lookup.get("apollo")
        sunbiz_id = source_id_lookup.get("fl_sunbiz")

        smile_id = entity_id_lookup.get("Smile Dental of Tampa")
        if smile_id and zoominfo_id and apollo_id:
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=smile_id,
                field_name="parent_company",
                source_a_id=zoominfo_id,
                value_a="independent",
                source_b_id=apollo_id,
                value_b="Heartland Dental",
                dollar_impact=180000,
                detected_at=_now() - timedelta(days=4),
            ))
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=smile_id,
                field_name="employee_count",
                source_a_id=zoominfo_id,
                value_a="8",
                source_b_id=apollo_id,
                value_b="12",
                dollar_impact=None,
                detected_at=_now() - timedelta(days=4),
            ))

        # 7 more random drifts on filler practices
        filler_practices = [k for k in entity_id_lookup if k.startswith("filler_practice_")][:7]
        for k in filler_practices:
            ent_id = entity_id_lookup[k]
            if not (zoominfo_id and apollo_id):
                continue
            self.db.add(DriftEvent(
                pack_id=pack.id,
                entity_id=ent_id,
                field_name="parent_company",
                source_a_id=zoominfo_id,
                value_a="independent",
                source_b_id=apollo_id,
                value_b=random.choice(["Heartland Dental", "Aspen Dental", "MB2 Dental"]),
                dollar_impact=random.randint(8000, 35000),
                detected_at=_now() - timedelta(days=random.randint(1, 14)),
            ))

    # ------------------------------------------------------------------ stuck entities
    def _seed_stuck_entities(self, pack, entity_id_lookup) -> None:
        if pack.id == "saas":
            self._seed_saas_stuck(pack, entity_id_lookup)
        elif pack.id == "home-care":
            self._seed_home_care_stuck(pack, entity_id_lookup)
        elif pack.id == "vertical-ai":
            self._seed_vertical_ai_stuck(pack, entity_id_lookup)

    def _seed_saas_stuck(self, pack, entity_id_lookup) -> None:
        # Pick 18 filler accounts as stuck deals across all stages
        filler = [k for k in entity_id_lookup if k.startswith("filler_")][:18]
        stages_with_sla = [("Discovery", 14), ("Demo", 21), ("Negotiation", 14), ("Verbal", 7)]
        for i, k in enumerate(filler):
            stage, sla_days = stages_with_sla[i % 4]
            ent_id = entity_id_lookup[k]
            self.db.add(StuckEntity(
                pack_id=pack.id,
                entity_id=ent_id,
                pipeline_stage=stage,
                stage_entered_at=_now() - timedelta(days=sla_days + random.randint(2, 14)),
                sla_seconds=sla_days * 86400,
                reason=f"Overdue in stage {stage} (SLA: {sla_days}d)",
                flagged_at=_now() - timedelta(days=random.randint(1, 5)),
            ))

    def _seed_home_care_stuck(self, pack, entity_id_lookup) -> None:
        # The 3 unfilled shifts inside the SLA window
        for shift_name in ("Shift: Mr. Henderson 7am", "Shift: Filler client 9am", "Shift: Filler client 11am"):
            ent_id = entity_id_lookup.get(shift_name)
            if not ent_id:
                continue
            self.db.add(StuckEntity(
                pack_id=pack.id,
                entity_id=ent_id,
                pipeline_stage="Scheduled",
                stage_entered_at=_now() - timedelta(hours=8),
                sla_seconds=14400,  # 4 hours
                reason="Unfilled within 4-hour SLA window",
                flagged_at=_now() - timedelta(minutes=8),
            ))
        # 14 more random clients with care plan drift
        filler_clients = [k for k in entity_id_lookup if k.startswith("filler_client_")][:14]
        for k in filler_clients:
            self.db.add(StuckEntity(
                pack_id=pack.id,
                entity_id=entity_id_lookup[k],
                pipeline_stage="Confirmed",
                stage_entered_at=_now() - timedelta(days=random.randint(35, 90)),
                sla_seconds=2592000,  # 30 days
                reason="Care plan reauth overdue",
                flagged_at=_now() - timedelta(days=random.randint(1, 10)),
            ))

    def _seed_vertical_ai_stuck(self, pack, entity_id_lookup) -> None:
        # Practices with low enrichment confidence in manual review
        filler = [k for k in entity_id_lookup if k.startswith("filler_practice_")][:18]
        for k in filler:
            self.db.add(StuckEntity(
                pack_id=pack.id,
                entity_id=entity_id_lookup[k],
                pipeline_stage="Manual-Review",
                stage_entered_at=_now() - timedelta(days=random.randint(4, 12)),
                sla_seconds=259200,  # 3 days
                reason="Enrichment confidence below 0.85; manual review required",
                flagged_at=_now() - timedelta(days=random.randint(1, 5)),
            ))

    # ------------------------------------------------------------------ PQL events (SaaS)
    def _seed_pql_events(self, pack, entity_id_lookup) -> None:
        seed = pack.seed or {}
        pql_cfg = seed.get("pql") or {}
        conv_low = pql_cfg.get("conversion_rate_low", 0.32)
        conv_high = pql_cfg.get("conversion_rate_high", 1.00)

        hero_decayed = [
            {"name": "Atlas Digital",      "score": 94, "ae": "Sarah Kim", "decayed_days": 14},
            {"name": "Cascade Analytics",  "score": 87, "ae": "Mike Reyes","decayed_days": 18},
        ]
        for hd in hero_decayed:
            ent_id = entity_id_lookup.get(hd["name"])
            if not ent_id:
                continue
            inferred_value = 13000  # plan-tier average
            self.db.add(PQLEvent(
                pack_id=pack.id,
                entity_id=ent_id,
                pql_score=hd["score"],
                score_breakdown={"product_usage": 60, "engagement": 34},
                routed_to=hd["ae"],
                routed_at=_now() - timedelta(days=hd["decayed_days"]),
                worked_at=None,
                decayed_at=_now() - timedelta(days=2),
                dollar_at_risk_low=int(inferred_value * conv_low),
                dollar_at_risk_high=int(inferred_value * conv_high),
            ))

        # 12 more decayed PQLs with deliberate score spread
        ae_pool = ["Sarah Kim", "Mike Reyes", "Jenna Larsson", "Priya Shah"]
        filler_scores = [93, 91, 88, 84, 82, 79, 76, 74, 71, 70, 68, 65]
        filler = [k for k in entity_id_lookup if k.startswith("filler_")][:12]
        for i, k in enumerate(filler):
            inferred_value = random.randint(4000, 22000)
            score = filler_scores[i] if i < len(filler_scores) else random.randint(65, 93)
            self.db.add(PQLEvent(
                pack_id=pack.id,
                entity_id=entity_id_lookup[k],
                pql_score=score,
                score_breakdown={"product_usage": random.randint(30, 75)},
                routed_to=random.choice(ae_pool),
                routed_at=_now() - timedelta(days=random.randint(8, 45)),
                worked_at=None,
                decayed_at=_now() - timedelta(days=random.randint(1, 8)),
                dollar_at_risk_low=int(inferred_value * conv_low),
                dollar_at_risk_high=int(inferred_value * conv_high),
            ))

    # ------------------------------------------------------------------ product events (SaaS)
    def _seed_product_events(self, pack, entity_id_lookup) -> None:
        meridian_id = entity_id_lookup.get("Meridian Labs")
        if not meridian_id:
            return
        # Meridian: 23 distinct user logins in last 30 days
        for i in range(23):
            self.db.add(ProductEvent(
                pack_id=pack.id,
                entity_id=meridian_id,
                event_type="user_login",
                event_data={"user_id": f"user_{i}", "session_minutes": random.randint(5, 180)},
                occurred_at=_now() - timedelta(days=random.randint(0, 30), hours=random.randint(0, 23)),
            ))
        # Bridgewater: 14 logins
        bw_id = entity_id_lookup.get("Bridgewater Systems")
        if bw_id:
            for i in range(14):
                self.db.add(ProductEvent(
                    pack_id=pack.id,
                    entity_id=bw_id,
                    event_type="user_login",
                    event_data={"user_id": f"user_bw_{i}"},
                    occurred_at=_now() - timedelta(days=random.randint(0, 30)),
                ))

    # ------------------------------------------------------------------ visits (Home Care)
    def _seed_visits(self, pack, entity_id_lookup) -> None:
        robinson_id = entity_id_lookup.get("Mrs. Ada Robinson")
        yolanda_id = entity_id_lookup.get("Yolanda Torres")

        # Hero visit: 4/3/26 with the canonical times
        if robinson_id and yolanda_id:
            april_3 = datetime(2026, 4, 3, tzinfo=timezone.utc)
            self.db.add(Visit(
                pack_id=pack.id,
                client_entity_id=robinson_id,
                caregiver_entity_id=yolanda_id,
                scheduled_start=april_3.replace(hour=8, minute=0),
                scheduled_end=april_3.replace(hour=12, minute=0),
                clocked_in_at=april_3.replace(hour=8, minute=14),
                clocked_out_at=april_3.replace(hour=12, minute=42),
                task_list=["bath", "meal_prep", "laundry"],
                evv_record_id="sandata_clock_in_117",
                mismatch_flags={
                    "overage_minutes": 28,
                    "unauthorized_task": "laundry",
                    "ltc_unbillable_dollars": 14.10,
                },
            ))

        # 1,246 filler visits over the past 30 days; 46 with mismatch flags
        client_ids = [v for k, v in entity_id_lookup.items() if k.startswith("filler_client_")] or []
        cg_ids = [v for k, v in entity_id_lookup.items() if k.startswith("filler_cg_") or k in ("Yolanda Torres", "Brittany Williams", "Crystal Hudson", "Marcus Johnson")]
        if not client_ids or not cg_ids:
            return

        for i in range(1246):
            day_offset = random.randint(0, 29)
            visit_day = _now() - timedelta(days=day_offset)
            scheduled_start = visit_day.replace(hour=random.choice([7, 9, 11, 13, 15]), minute=0, second=0, microsecond=0)
            scheduled_end = scheduled_start + timedelta(hours=4)
            has_mismatch = i < 46
            clock_in_offset = random.randint(-5, 30) if has_mismatch else random.randint(-5, 5)
            clock_out_offset = random.randint(-15, 45) if has_mismatch else random.randint(-5, 5)
            self.db.add(Visit(
                pack_id=pack.id,
                client_entity_id=random.choice(client_ids),
                caregiver_entity_id=random.choice(cg_ids),
                scheduled_start=scheduled_start,
                scheduled_end=scheduled_end,
                clocked_in_at=scheduled_start + timedelta(minutes=clock_in_offset),
                clocked_out_at=scheduled_end + timedelta(minutes=clock_out_offset),
                task_list=["bath", "meal_prep"],
                evv_record_id=f"sandata_clk_{i}",
                mismatch_flags={"overage_minutes": clock_out_offset - clock_in_offset} if has_mismatch else None,
            ))


if __name__ == "__main__":
    from db import SessionLocal, init_db
    from packs import init_pack_registry

    init_db()
    init_pack_registry()
    with SessionLocal() as session:
        Seeder(session).seed_all()
        print("Seeding complete.")