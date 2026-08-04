"""Portfolio site for Ryan Zegalia — five verticals, fifteen demos.

Reads pack configs from packs/*/ at startup, seeds a Postgres database from
the YAML in each pack, then serves a scrollytelling landing page per vertical
plus one sub-page per demo. See README.md for the architecture overview.
"""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException as FastAPIHTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from config import STATIC_DIR, TEMPLATES_DIR, PLAUSIBLE_DOMAIN
from db import init_db, SessionLocal, Entity
from packs import PACK_REGISTRY, init_pack_registry, validate_pack_registry
from connectors import Seeder
from reconciler import schedule_stuck_detector
from routes.root import router as root_router
from routes.pack_demo import router as pack_demo_router
from routes.systems import router as systems_router
from routes.api import router as api_router
from apscheduler.schedulers.background import BackgroundScheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("portfolio")


# ---------------------------------------------------------------------------
# Sitemap generation
# ---------------------------------------------------------------------------
# The canonical public routes. Used as a fallback when no router has been
# registered yet (Foundation build) AND as a filter when routers *are*
# registered (we still only publish these in the sitemap, not /api/*).
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


def _write_sitemap(app: FastAPI) -> None:
    """Emit static/sitemap.xml from the current route registry.

    Walks `app.routes`, keeps GET routes with no path params, intersects
    with the canonical list, and writes a simple urlset. If no routes are
    registered yet (Foundation-only build), falls back to the hardcoded
    canonical list so the file is always valid.
    """
    discovered: set[str] = set()
    try:
        for route in app.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None) or set()
            if not path or "GET" not in methods:
                continue
            if "{" in path or "}" in path:
                continue
            discovered.add(path)
    except Exception as exc:  # pragma: no cover — defensive
        log.warning("sitemap: failed to walk routes: %s", exc)

    # Use discovered ∩ canonical when we have discoveries, else just canonical.
    if discovered:
        routes = [r for r in CANONICAL_ROUTES if r in discovered]
        # Any canonical route the app hasn't wired yet still gets listed as
        # a planned URL so the sitemap stays stable across build phases.
        for r in CANONICAL_ROUTES:
            if r not in routes:
                routes.append(r)
    else:
        routes = list(CANONICAL_ROUTES)

    base = "https://ryanzegalia.com"
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    for path in routes:
        lines.append("  <url>")
        lines.append(f"    <loc>{base}{path}</loc>")
        lines.append("    <changefreq>weekly</changefreq>")
        lines.append("  </url>")
    lines.append("</urlset>\n")

    os.makedirs(STATIC_DIR, exist_ok=True)
    out_path = os.path.join(STATIC_DIR, "sitemap.xml")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    log.info("sitemap: wrote %d routes to %s", len(routes), out_path)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
scheduler = BackgroundScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle.

    1. create DB schema via Base.metadata.create_all
    2. load pack registry from packs/*/
    3. validate pack registry cross-references (scenario ids, glossary keys)
    4. seed the database (idempotent), verify post-seed row counts
    5. start the stuck-pipeline detector on a 5-minute tick (non-critical)
    6. write static/sitemap.xml from the registered route table

    Startup state is tracked on app.state for /api/health to report. The
    seeder is treated as critical — failure aborts startup so the container
    doesn't serve empty tables looking healthy. The scheduler is non-critical
    — failure is logged loudly and surfaced via /api/health but does not
    block startup (the seeded data is the demo; the scheduler only updates it).
    """
    app.state.seeder_ok = False
    app.state.scheduler_started = False

    init_db()
    init_pack_registry()
    validate_pack_registry()

    # M-1: seeder is critical. Re-raise on failure. Post-seed verification
    # catches the "seed_all returned cleanly but left no data" class of bug
    # that a bare re-raise would miss.
    try:
        with SessionLocal() as session:
            Seeder(session).seed_all()
            entity_count = session.query(Entity).count()
            if entity_count == 0:
                raise RuntimeError(
                    "seed verification failed: entity count is 0 after seed_all()"
                )
            log.info(
                "seeder: verified %d entities across %d packs",
                entity_count, len(PACK_REGISTRY),
            )
        app.state.seeder_ok = True
    except Exception:
        log.exception("seeder failed at startup — aborting")
        raise

    # M-2: scheduler is non-critical. Log loudly but don't block startup.
    try:
        schedule_stuck_detector(scheduler, SessionLocal)
        scheduler.start()
        app.state.scheduler_started = True
        log.info("scheduler: stuck detector started")
    except Exception as exc:
        log.error(
            "scheduler failed to start: %s — continuing without background tasks",
            exc, exc_info=True,
        )

    _write_sitemap(app)
    log.info("portfolio started — DB initialized, packs loaded, scheduler running, sitemap written")
    yield

    try:
        scheduler.shutdown(wait=False)
    except Exception:
        pass
    log.info("portfolio shutting down")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Ryan Zegalia", lifespan=lifespan)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response


app.add_middleware(SecurityHeadersMiddleware)

# Static files and templates
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# Custom Jinja filters — see filters.py
# `markup_terms` wraps glossary terms in hover-tooltip <span class="term">.
# `highlight_code` renders Pygments-highlighted code blocks for inline SQL/Python artifacts.
from filters import markup_terms, highlight_code  # noqa: E402
templates.env.filters["markup_terms"] = markup_terms
templates.env.filters["highlight_code"] = highlight_code

app.state.templates = templates


app.include_router(root_router)
app.include_router(pack_demo_router)
# Registration order is not load-bearing here: the pack routes are single-
# segment bare slugs (/saas) and these are two-segment (/systems/genome), so
# the two can never match the same path.
app.include_router(systems_router)
app.include_router(api_router)


# ---------------------------------------------------------------------------
# Error handlers — slate-indigo branded 404 + 500 pages
# ---------------------------------------------------------------------------
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        return templates.TemplateResponse(
            "error.html",
            {"request": request, "status_code": 404, "message": "Page not found.", "plausible_domain": PLAUSIBLE_DOMAIN, "active_pack": None},
            status_code=404,
        )
    return templates.TemplateResponse(
        "error.html",
        {"request": request, "status_code": exc.status_code, "message": exc.detail, "plausible_domain": PLAUSIBLE_DOMAIN, "active_pack": None},
        status_code=exc.status_code,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.exception("unhandled exception on %s: %s", request.url.path, exc)
    try:
        return templates.TemplateResponse(
            "error.html",
            {"request": request, "status_code": 500, "message": "Something went wrong.", "plausible_domain": PLAUSIBLE_DOMAIN, "active_pack": None},
            status_code=500,
        )
    except Exception:
        return JSONResponse({"error": "internal server error"}, status_code=500)