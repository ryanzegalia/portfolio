"""Pack engine — the one-YAML-folder-per-vertical architectural commitment.

Adding a new vertical is editing seven YAML files under
`packs/<new_vertical>/`. No new Python, no new routes, no schema migration.
This package is the glue that makes that claim true:

- `loader.py` reads pack YAML into a `Pack` dataclass, validates every
  cross-reference between sources/connectors/pipelines/entities, and
  publishes the module-level `PACK_REGISTRY` at startup.

- `routing.py` exposes `pack_query` (the mandatory pack-scoped query helper
  that makes pack isolation the default).

Everything that pack-scoped routes need is re-exported from here:

    from packs import PACK_REGISTRY, pack_query, Pack
"""

from .loader import (
    PACK_REGISTRY,
    Pack,
    PackLoadError,
    PackValidationError,
    init_pack_registry,
    load_all_packs,
    load_pack,
    validate_pack_registry,
)
from .routing import pack_query

__all__ = [
    "Pack",
    "load_pack",
    "load_all_packs",
    "init_pack_registry",
    "validate_pack_registry",
    "PACK_REGISTRY",
    "PackLoadError",
    "PackValidationError",
    "pack_query",
]