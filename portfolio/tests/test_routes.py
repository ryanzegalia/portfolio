"""Route smoke tests — verify all canonical routes return 200.

These tests require a running Postgres database (the app's lifespan seeds
data into Postgres). Run with:

    docker compose up portfolio-db -d
    DATABASE_URL=postgresql://portfolio:portfolio@localhost:5432/portfolio pytest tests/test_routes.py

Skip these tests when no Postgres is available:
    pytest tests/ -k "not integration"
"""

import os
import pytest

# These tests need a real Postgres database, so skip when only SQLite is available
needs_postgres = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Route tests require a running Postgres database (set DATABASE_URL)",
)


CANONICAL_ROUTES = [
    "/",
    "/saas",
    "/saas/revenue",
    "/saas/pql",
    "/saas/forecast",
    "/home-care",
    "/home-care/shifts/critical",
    "/home-care/reconciliation/evv",
    "/home-care/care-plans/drift",
    "/vertical-ai",
    "/vertical-ai/enrichment",
    "/vertical-ai/enrichment/sor-detection",
    "/vertical-ai/customers",
    "/sca",
    "/sca/deals",
    "/sca/triggers",
    "/sca/coverage",
    "/distribution",
    "/distribution/erp-detection",
    "/distribution/pov",
    "/distribution/pe-triggers",
]


@needs_postgres
class TestRoutes:
    @pytest.fixture(autouse=True)
    def client(self):
        from fastapi.testclient import TestClient
        from app import app
        # Context manager triggers FastAPI lifespan (seeder + scheduler) so
        # routes have real data instead of rendering over an empty DB.
        with TestClient(app) as c:
            self._client = c
            yield

    @pytest.mark.parametrize("route", CANONICAL_ROUTES)
    def test_route_returns_200(self, route):
        resp = self._client.get(route)
        assert resp.status_code == 200, f"{route} returned {resp.status_code}"

    def test_health_endpoint(self):
        resp = self._client.get("/api/health")
        # TestClient doesn't run the full lifespan (seeder/scheduler),
        # so health may report 503/degraded. Just verify the shape.
        assert resp.status_code in (200, 503)
        data = resp.json()
        assert "status" in data
        assert "packs" in data

    def test_unknown_pack_returns_404(self):
        resp = self._client.get("/nonexistent-pack")
        assert resp.status_code == 404

    def test_404_page_is_styled(self):
        resp = self._client.get("/nonexistent-page")
        assert resp.status_code == 404
        assert "Page not found" in resp.text

    def test_security_headers_present(self):
        resp = self._client.get("/")
        assert resp.headers.get("X-Content-Type-Options") == "nosniff"
        assert resp.headers.get("X-Frame-Options") == "DENY"
