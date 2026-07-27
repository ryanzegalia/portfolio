"""Non-pack-scoped routes: /, /atlas, /traffic, /sitemap.xml."""
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func
from sqlalchemy.orm import Session

from config import TEMPLATES_DIR, STATIC_DIR, PLAUSIBLE_DOMAIN, TRAFFIC_TOKEN
from db import PageEvent, get_db
from packs import PACK_REGISTRY
from filters import attach_filters

router = APIRouter()
templates = Jinja2Templates(directory=TEMPLATES_DIR)
attach_filters(templates)

# The sanitized Nexus Atlas artifact: a single self-contained HTML file
# produced by a private build pipeline and dropped here only after its leak
# gate passes. The route 404s until the file exists so it can ship ahead of
# the artifact.
ATLAS_FILE = os.path.join(STATIC_DIR, "atlas", "atlas.html")


def _common_context(request: Request, **extra) -> dict:
    return {
        "request": request,
        "plausible_domain": PLAUSIBLE_DOMAIN,
        "active_pack": None,
        **extra,
    }


@router.get("/", response_class=HTMLResponse)
def root_landing(request: Request):
    return templates.TemplateResponse(
        "root_landing.html",
        _common_context(request, packs=list(PACK_REGISTRY.values())),
    )


@router.get("/atlas")
def atlas():
    if not os.path.exists(ATLAS_FILE):
        raise HTTPException(status_code=404)
    return FileResponse(ATLAS_FILE, media_type="text/html")


@router.get("/traffic", include_in_schema=False)
def traffic(request: Request, k: str = "", days: int = 14,
            db: Session = Depends(get_db)):
    """Token-gated first-party traffic viewer.

    Answers 404 (not 401/403) on a missing or wrong token so the route's
    existence isn't advertised to scanners.
    """
    if not TRAFFIC_TOKEN or k != TRAFFIC_TOKEN:
        raise HTTPException(status_code=404)
    days = max(1, min(days, 90))
    since = datetime.now(timezone.utc) - timedelta(days=days)

    day_col = func.date(PageEvent.occurred_at)
    views = func.count(PageEvent.id)
    visitors = func.count(func.distinct(PageEvent.visitor_hash))

    by_day = (
        db.query(day_col, views, visitors)
        .filter(PageEvent.occurred_at >= since)
        .group_by(day_col).order_by(day_col.desc()).all()
    )
    by_page = (
        db.query(PageEvent.path, views, visitors)
        .filter(PageEvent.occurred_at >= since)
        .group_by(PageEvent.path).order_by(views.desc()).limit(30).all()
    )
    by_src = (
        db.query(PageEvent.src, views, visitors)
        .filter(PageEvent.occurred_at >= since, PageEvent.src.isnot(None))
        .group_by(PageEvent.src).order_by(views.desc()).limit(30).all()
    )
    by_node = (
        db.query(PageEvent.hash_route, views)
        .filter(
            PageEvent.occurred_at >= since,
            PageEvent.path == "/atlas",
            PageEvent.hash_route.isnot(None),
            PageEvent.hash_route != "",
        )
        .group_by(PageEvent.hash_route).order_by(views.desc()).limit(40).all()
    )
    recent = (
        db.query(PageEvent)
        .filter(PageEvent.occurred_at >= since)
        .order_by(PageEvent.occurred_at.desc()).limit(50).all()
    )

    return templates.TemplateResponse(
        "traffic.html",
        _common_context(
            request, days=days, by_day=by_day, by_page=by_page,
            by_src=by_src, by_node=by_node, recent=recent,
        ),
    )


@router.get("/sitemap.xml", include_in_schema=False)
def sitemap():
    path = os.path.join(STATIC_DIR, "sitemap.xml")
    return FileResponse(path, media_type="application/xml")
