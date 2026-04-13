"""Non-pack-scoped routes: /, /sitemap.xml."""
import os

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates

from config import TEMPLATES_DIR, STATIC_DIR, PLAUSIBLE_DOMAIN
from packs import PACK_REGISTRY
from filters import attach_filters

router = APIRouter()
templates = Jinja2Templates(directory=TEMPLATES_DIR)
attach_filters(templates)


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


@router.get("/sitemap.xml", include_in_schema=False)
def sitemap():
    path = os.path.join(STATIC_DIR, "sitemap.xml")
    return FileResponse(path, media_type="application/xml")
