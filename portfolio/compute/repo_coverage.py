"""Demo 4.3 — The Repo Coverage Gap.

Queries customer account and repo entities, computes coverage ratios and
expansion ARR from the relationship between total/active/scanned repos.
"""
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query


def build_repo_coverage(db: Session, pack) -> dict[str, Any]:
    """Query customer accounts and their repos, compute coverage gaps."""

    # Hero account (Vericode)
    hero_entity = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "customer_account")
        .filter(Entity.fields["is_hero"].as_boolean() == True)
        .first()
    )

    hero_account = {}
    if hero_entity:
        hf = hero_entity.fields or {}

        # Query child repo entities
        repos = (
            pack_query(db, Entity, pack)
            .filter(Entity.entity_type == "repo")
            .filter(Entity.parent_id == hero_entity.id)
            .all()
        )

        # Compute stats from actual repo rows
        total_repos = len(repos)
        scanned_repos = sum(1 for r in repos if (r.fields or {}).get("scanned", False))
        active_repos = sum(
            1 for r in repos
            if (r.fields or {}).get("last_commit") is not None
        )

        per_repo_rate = hf.get("per_repo_rate", 950)
        # A scanned-but-inactive repo would otherwise push coverage past 1.0
        # and expansion negative; cap both at the sensible bound.
        coverage_ratio = round(min(scanned_repos / active_repos, 1.0), 2) if active_repos > 0 else 0.0
        expansion_arr = max(active_repos - scanned_repos, 0) * per_repo_rate

        # Build repo list for the grid
        repo_list = []
        for r in repos:
            rf = r.fields or {}
            repo_list.append({
                "name": r.canonical_name,
                "language": rf.get("language", "Unknown"),
                "last_commit": rf.get("last_commit"),
                "scanned": rf.get("scanned", False),
                "dependencies": rf.get("dependencies"),
            })

        hero_account = {
            "company": hf.get("company", hero_entity.canonical_name),
            "contract_arr": hf.get("contract_arr", 0),
            "per_repo_rate": per_repo_rate,
            "total_repos": total_repos,
            "active_repos": active_repos,
            "scanned_repos": scanned_repos,
            "coverage_ratio": coverage_ratio,
            "expansion_arr": expansion_arr,
            "repos": repo_list,
        }

    # Filler accounts
    filler_entities = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "customer_account")
        .filter(Entity.fields["is_hero"].as_boolean() != True)
        .limit(200)
        .all()
    )

    filler_accounts = []
    for fe in filler_entities:
        ff = fe.fields or {}
        repos = (
            pack_query(db, Entity, pack)
            .filter(Entity.entity_type == "repo")
            .filter(Entity.parent_id == fe.id)
            .all()
        )
        total = len(repos)
        scanned = sum(1 for r in repos if (r.fields or {}).get("scanned", False))
        active = sum(1 for r in repos if (r.fields or {}).get("last_commit") is not None)
        rate = ff.get("per_repo_rate", 950)
        cov = round(min(scanned / active, 1.0), 2) if active > 0 else 0.0
        expansion = max(active - scanned, 0) * rate

        filler_accounts.append({
            "company": ff.get("company", fe.canonical_name),
            "contract_arr": ff.get("contract_arr", 0),
            "total_repos": total,
            "scanned_repos": scanned,
            "coverage_ratio": cov,
            "expansion_arr": expansion,
        })

    # Count underscanned: coverage ratio below 50%
    all_accounts = [hero_account] + filler_accounts if hero_account else filler_accounts
    underscanned = sum(1 for a in all_accounts if a.get("coverage_ratio", 1.0) < 0.50)

    return {
        "hero_account": hero_account,
        "filler_accounts": filler_accounts,
        "underscanned_account_count": underscanned,
        "scenario": None,
    }
