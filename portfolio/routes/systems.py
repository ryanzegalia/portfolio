"""Per-system landing pages: /systems/<slug>.

The personal-shelf counterpart to routes/pack_demo.py. The packs need a
database session and a loader per section; these are static content out of
systems.SYSTEM_REGISTRY, so the handler is a dictionary lookup and a render.

Kept in its own module rather than bolted onto routes/root.py because root.py
is the non-pack-scoped grab bag (/, /platform, /traffic, /sitemap.xml) and
this is its own shelf with its own registry.
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from config import TEMPLATES_DIR, PLAUSIBLE_DOMAIN
from filters import attach_filters
from systems import SYSTEM_REGISTRY

router = APIRouter()
templates = Jinja2Templates(directory=TEMPLATES_DIR)
attach_filters(templates)


@router.get("/systems/{slug}", response_class=HTMLResponse)
def system_landing(request: Request, slug: str):
    system = SYSTEM_REGISTRY.get(slug)
    if system is None:
        raise HTTPException(status_code=404)
    return templates.TemplateResponse(
        "system_landing.html",
        {
            "request": request,
            "plausible_domain": PLAUSIBLE_DOMAIN,
            # These pages are not pack-scoped, so the nav stays in its root
            # state exactly as it does on / and /platform. `page_pack` is the
            # separate hook that carries the accent colour onto <body>, so a
            # system keeps the colour it had on its home-page card.
            "active_pack": None,
            "page_pack": system["pack"],
            "system": system,
        },
    )
