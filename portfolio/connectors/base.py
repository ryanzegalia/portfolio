"""BaseConnector ABC and the SourceRecordPayload dataclass."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Iterator
import hashlib
import json


@dataclass
class SourceRecordPayload:
    source_external_id: str
    natural_key: str
    raw_snapshot: dict
    canonical_fields: dict = field(default_factory=dict)
    field_hash: str = ""


class BaseConnector(ABC):
    def __init__(self, pack, source_key: str, source_id, db_session):
        self.pack = pack
        self.source_key = source_key
        self.source_id = source_id
        self.db = db_session

    @abstractmethod
    def pull(self) -> Iterator[SourceRecordPayload]:
        """Yield SourceRecordPayload rows from this connector."""
        ...

    def field_hash(self, payload: SourceRecordPayload) -> str:
        canonical = json.dumps(payload.canonical_fields, sort_keys=True, default=str)
        return hashlib.sha256(canonical.encode()).hexdigest()[:16]

    def push(self, entity, fields: dict) -> None:
        """Write back to the source. No-op in mocks."""
        pass