"""Google Sheets-shaped mock — wraps raw_snapshot in a Sheets-flavored envelope."""
from typing import Iterator
from .mock import MockConnector
from .base import SourceRecordPayload


class SheetsMockConnector(MockConnector):
    def pull(self) -> Iterator[SourceRecordPayload]:
        for i, payload in enumerate(super().pull()):
            if "values" not in payload.raw_snapshot:
                payload.raw_snapshot = {
                    "row_index": i + 2,
                    "values": list(payload.canonical_fields.values()),
                    "last_modified": "2026-04-10T00:00:00Z",
                }
            yield payload