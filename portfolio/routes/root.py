"""Non-pack-scoped routes: /, /platform, /traffic, /sitemap.xml."""
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from config import TEMPLATES_DIR, STATIC_DIR, PLAUSIBLE_DOMAIN, TRAFFIC_TOKEN
from db import PageEvent, get_db
from packs import PACK_REGISTRY
from filters import attach_filters
from traffic import build_report, to_local

router = APIRouter()
templates = Jinja2Templates(directory=TEMPLATES_DIR)
attach_filters(templates)

# The platform map: a generated Jinja template produced by
# scripts/build_platform_map.py from platform_map/fragments/ (its lint gates
# ASCII + banned identifiers). The route 404s until the generated file
# exists so the route can ship ahead of the artifact.
PLATFORM_TEMPLATE = os.path.join(TEMPLATES_DIR, "platform_map.html")


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


@router.get("/platform", response_class=HTMLResponse)
def platform(request: Request):
    if not os.path.exists(PLATFORM_TEMPLATE):
        raise HTTPException(status_code=404)
    return templates.TemplateResponse("platform_map.html", _common_context(request))


# Ceiling on rows pulled into memory for one /traffic render. Classification
# happens in Python (the rules live in traffic.py, not in SQL), so the window
# is materialised. At beacon volumes for a personal site this is a few
# thousand rows; the cap is a guard against a crawler flood, and the template
# says so when it trips.
TRAFFIC_EVENT_CAP = 20000


@router.get("/traffic", include_in_schema=False)
def traffic(request: Request, k: str = "", days: int = 14, who: str = "humans",
            db: Session = Depends(get_db)):
    """Token-gated first-party traffic viewer.

    Answers 404 (not 401/403) on a missing or wrong token so the route's
    existence isn't advertised to scanners.

    `who` is humans (default), bots or all. Bot classification is done at
    view time from the stored user agent, so the rules can be corrected
    without touching stored rows.
    """
    if not TRAFFIC_TOKEN or k != TRAFFIC_TOKEN:
        raise HTTPException(status_code=404)
    days = max(1, min(days, 90))
    since = datetime.now(timezone.utc) - timedelta(days=days)

    rows = (
        db.query(PageEvent)
        .filter(PageEvent.occurred_at >= since)
        .order_by(PageEvent.occurred_at.desc())
        .limit(TRAFFIC_EVENT_CAP)
        .all()
    )
    truncated = len(rows) == TRAFFIC_EVENT_CAP
    rows.reverse()  # build_report wants oldest first

    own_hosts = {h for h in {request.url.hostname, PLAUSIBLE_DOMAIN} if h}
    own_hosts |= {h[4:] for h in own_hosts if h.startswith("www.")}

    report = build_report(rows, who=who, own_hosts=own_hosts)

    return templates.TemplateResponse(
        "traffic.html",
        _common_context(
            request, days=days, token=k, truncated=truncated,
            event_cap=TRAFFIC_EVENT_CAP, to_local=to_local, **report,
        ),
    )


@router.get("/sitemap.xml", include_in_schema=False)
def sitemap():
    path = os.path.join(STATIC_DIR, "sitemap.xml")
    return FileResponse(path, media_type="application/xml")
