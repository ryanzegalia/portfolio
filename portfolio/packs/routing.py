"""FastAPI routing helpers for pack-scoped requests.

This module is the *only* file in `packs/` that imports FastAPI. The loader
stays framework-agnostic so it can be driven by tests and CLI scripts; the
pack-scoped query helper lives here.

`pack_query(db, model, pack)` is a tiny wrapper around
`db.query(model).filter(model.pack_id == pack.id)`. The point is to make it
syntactically impossible to forget the pack filter on a list query. Every
pack-scoped read goes through this; opening two browser tabs at `/saas` and
`/home-care` simultaneously must show zero state bleed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from .loader import Pack


def pack_query(db: Session, model, pack: "Pack"):
    """Return a SQLAlchemy Query filtered by `pack_id == pack.id`.

    Use this for every pack-scoped read — it makes pack isolation the default
    and forgetting it a compile-level impossibility (you have to explicitly
    bypass this helper to get unfiltered rows).

    Example:

        from packs import pack_query
        from db import Entity

        accounts = pack_query(db, Entity, pack).filter(
            Entity.entity_type == "account"
        ).all()

    The `model` argument is any SQLAlchemy model from `db.py` that has a
    `pack_id` column (all 11 canonical models do, per Agent A's schema).
    """
    return db.query(model).filter(model.pack_id == pack.id)