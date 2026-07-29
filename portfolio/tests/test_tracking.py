"""Tests for the first-party beacon (/api/t), the /platform mount, and the
token-gated /traffic viewer.

Like test_routes.py these need a running Postgres (the app lifespan seeds):

    docker compose up portfolio-db -d
    DATABASE_URL=postgresql://portfolio:portfolio@localhost:5432/portfolio pytest tests/test_tracking.py
"""

import os
import pytest

needs_postgres = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Tracking tests require a running Postgres database (set DATABASE_URL)",
)


def banned_terms():
    """The internal artifact names that must never render on the public map.

    Supplied from OUTSIDE this file on purpose. This repository is published,
    and a test asserting `"<name>" not in page` states the very name the map
    exists to avoid -- the same de-anonymisation as shipping the scrub harness.
    Set PORTFOLIO_BANNED_TERMS="a,b" or drop one term per line in
    scripts/banned_terms.local (gitignored). Absent both, the assertion is
    skipped; the deploy step greps the rendered page as the real gate.
    """
    raw = os.environ.get("PORTFOLIO_BANNED_TERMS", "")
    if not raw:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(here, "scripts", "banned_terms.local")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                raw = ",".join(fh.read().split())
    return [t.strip() for t in raw.split(",") if t.strip()]


@needs_postgres
class TestTracking:
    @pytest.fixture(autouse=True)
    def client(self):
        from fastapi.testclient import TestClient
        from app import app
        with TestClient(app) as c:
            self._client = c
            yield

    def test_beacon_records_event(self):
        from db import SessionLocal, PageEvent
        resp = self._client.post(
            "/api/t",
            json={"p": "/test-beacon", "h": "#/n/orders", "r": "", "s": "unit-test"},
        )
        assert resp.status_code == 204
        db = SessionLocal()
        try:
            row = (
                db.query(PageEvent)
                .filter(PageEvent.path == "/test-beacon")
                .order_by(PageEvent.occurred_at.desc())
                .first()
            )
            assert row is not None
            assert row.src == "unit-test"
            assert row.hash_route == "#/n/orders"
            # Only the hash ships to the table, never a raw IP.
            assert row.visitor_hash
        finally:
            db.close()

    def test_beacon_malformed_payload_is_swallowed(self):
        resp = self._client.post(
            "/api/t",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 204

    def test_platform_404_until_generated_template_exists(self, tmp_path, monkeypatch):
        import routes.root as root_mod
        monkeypatch.setattr(root_mod, "PLATFORM_TEMPLATE", str(tmp_path / "missing.html"))
        assert self._client.get("/platform").status_code == 404

    def test_platform_serves_generated_map(self):
        # The generated template ships with the tree (scripts/build_platform_map.py).
        resp = self._client.get("/platform")
        assert resp.status_code == 200
        assert "The platform map" in resp.text
        assert 'data-node="pricing"' in resp.text
        # The banned artifact names never render. Terms come from the local
        # list so this file does not publish them; see banned_terms().
        terms = banned_terms()
        if terms:
            for term in terms:
                assert term.lower() not in resp.text.lower(), f"banned term rendered: {term}"

    def test_traffic_hidden_without_token(self, monkeypatch):
        import routes.root as root_mod
        monkeypatch.setattr(root_mod, "TRAFFIC_TOKEN", "")
        assert self._client.get("/traffic").status_code == 404

        monkeypatch.setattr(root_mod, "TRAFFIC_TOKEN", "sekrit")
        assert self._client.get("/traffic?k=wrong").status_code == 404
        resp = self._client.get("/traffic?k=sekrit")
        assert resp.status_code == 200
        assert "First-party traffic" in resp.text
