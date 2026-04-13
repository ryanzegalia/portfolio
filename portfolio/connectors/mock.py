"""Generic mock connector — loads canned data from pack.seed['connector_data'][source_key]."""
from typing import Iterator
from .base import BaseConnector, SourceRecordPayload


class MockConnector(BaseConnector):
    """
    Generic mock connector. Reads canned source data from
    pack.seed["connector_data"][source_key] (a list of {source_external_id, natural_key, raw, canonical} dicts).

    If seed.yaml does not declare connector_data for this source, the connector
    yields nothing — that's a valid state for source systems whose data is
    purely entity-derived rather than externally seeded.
    """

    def pull(self) -> Iterator[SourceRecordPayload]:
        connector_data = (self.pack.seed.get("connector_data") or {}).get(self.source_key) or []
        for row in connector_data:
            payload = SourceRecordPayload(
                source_external_id=row["source_external_id"],
                natural_key=row.get("natural_key", row["source_external_id"]),
                raw_snapshot=row.get("raw", {}),
                canonical_fields=row.get("canonical", {}),
            )
            payload.field_hash = self.field_hash(payload)
            yield payload