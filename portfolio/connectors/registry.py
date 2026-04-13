"""Connector registry — maps (pack_id, source_key) to a connector instance."""
from .base import BaseConnector
from .mock import MockConnector
from .hubspot_mock import HubSpotMockConnector
from .sheets_mock import SheetsMockConnector


_REGISTRY: dict = {}


def register_connectors(pack, db_session, source_id_lookup: dict) -> None:
    """
    For each source in pack.sources, instantiate a connector and store it
    in _REGISTRY keyed by (pack.id, source_key).

    source_id_lookup: dict mapping source_key to the DB row ID for the matching Source row.
    """
    for source_key, source_meta in pack.sources.items():
        if source_key == "hubspot":
            cls = HubSpotMockConnector
        elif source_key in ("sheets", "google_sheets"):
            cls = SheetsMockConnector
        else:
            cls = MockConnector
        source_id = source_id_lookup.get(source_key)
        _REGISTRY[(pack.id, source_key)] = cls(pack, source_key, source_id, db_session)


def get_connector(pack_id: str, source_key: str) -> BaseConnector:
    return _REGISTRY[(pack_id, source_key)]


def all_connectors_for_pack(pack_id: str) -> list:
    return [c for (pid, _), c in _REGISTRY.items() if pid == pack_id]


def clear_registry() -> None:
    _REGISTRY.clear()