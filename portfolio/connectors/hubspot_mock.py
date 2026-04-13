"""HubSpot-shaped mock — wraps raw_snapshot in a HubSpot-flavored envelope."""
from typing import Iterator
from .mock import MockConnector
from .base import SourceRecordPayload


class HubSpotMockConnector(MockConnector):
    def pull(self) -> Iterator[SourceRecordPayload]:
        for payload in super().pull():
            if "properties" not in payload.raw_snapshot:
                payload.raw_snapshot = {
                    "id": payload.source_external_id,
                    "properties": dict(payload.canonical_fields),
                    "archived": False,
                    "createdAt": "2025-01-01T00:00:00Z",
                    "updatedAt": "2026-04-10T00:00:00Z",
                }
            yield payload