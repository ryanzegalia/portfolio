"""Connector layer — BaseConnector + mocks + seeder + registry."""
from .base import BaseConnector, SourceRecordPayload
from .mock import MockConnector
from .hubspot_mock import HubSpotMockConnector
from .sheets_mock import SheetsMockConnector
from .registry import register_connectors, get_connector, all_connectors_for_pack, clear_registry
from .seeder import Seeder

__all__ = [
    "BaseConnector",
    "SourceRecordPayload",
    "MockConnector",
    "HubSpotMockConnector",
    "SheetsMockConnector",
    "register_connectors",
    "get_connector",
    "all_connectors_for_pack",
    "clear_registry",
    "Seeder",
]