"""JSON API endpoints. /api/health returns liveness + startup state."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from packs import PACK_REGISTRY

router = APIRouter(prefix="/api")


@router.get("/health")
def health(request: Request):
    """Liveness endpoint that reflects actual startup state, not just HTTP-up.

    Returns 200 when both the seeder and scheduler completed successfully.
    Returns 503 when either is degraded — external pollers (Uptime Kuma, etc.)
    get a machine-readable signal that the container started but isn't fully
    operational.
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