"""JSON API endpoints. /api/health returns liveness + startup state; /api/t
is the first-party page beacon."""
import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from db import PageEvent, get_db
from packs import PACK_REGISTRY

router = APIRouter(prefix="/api")


@router.get("/health")
def health(request: Request):
    """Liveness endpoint that reflects actual startup state, not just HTTP-up.

    Returns 200 when both the seeder and scheduler completed successfully.
    Returns 503 when either is degraded, so external pollers (Uptime Kuma,
    etc.) get a machine-readable signal that the container started but isn't
    fully operational.
    """
    seeder_ok = getattr(request.app.state, "seeder_ok", False)
    scheduler_ok = getattr(request.app.state, "scheduler_started", False)
    all_ok = seeder_ok and scheduler_ok
    return JSONResponse(
        {
            "status": "ok" if all_ok else "degraded",
            "packs": list(PACK_REGISTRY.keys()),
            "seeder_ok": seeder_ok,
            "scheduler_ok": scheduler_ok,
        },
        status_code=200 if all_ok else 503,
    )


def _clip(value, limit: int):
    if not isinstance(value, str):
        return None
    return value.strip()[:limit] or None


@router.post("/t", include_in_schema=False)
async def track(request: Request, db: Session = Depends(get_db)):
    """First-party page beacon: no cookies, no third parties.

    Never fails the page it instruments: malformed payloads are dropped and
    the response is 204 regardless. Raw IPs are not stored; only a
    day-salted hash is kept, for same-day visitor dedup in /traffic.
    """
    try:
        body = await request.json()
    except Exception:
        return Response(status_code=204)
    if not isinstance(body, dict):
        return Response(status_code=204)

    fwd = request.headers.get("x-forwarded-for", "")
    ip = fwd.split(",")[0].strip() if fwd else (
        request.client.host if request.client else ""
    )
    ua = request.headers.get("user-agent", "")
    day = datetime.now(timezone.utc).date().isoformat()
    visitor = hashlib.sha256(f"{day}|{ip}|{ua}".encode()).hexdigest()[:16]

    try:
        db.add(
            PageEvent(
                path=_clip(body.get("p"), 300) or "/",
                hash_route=_clip(body.get("h"), 300),
                referrer=_clip(body.get("r"), 500),
                src=_clip(body.get("s"), 100),
                user_agent=ua[:300] or None,
                visitor_hash=visitor,
            )
        )
        db.commit()
    except Exception:
        db.rollback()
    return Response(status_code=204)
