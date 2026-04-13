"""Portfolio site configuration from environment variables."""

import os


def _as_bool(val: str | None, default: bool = False) -> bool:
    """Cast an env var string to a bool."""
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on", "y", "t"}


# L-1 belt: DATABASE_URL must come from the environment. No hardcoded default
# credentials. In docker-compose the DATABASE_URL env var is built from the
# POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB env vars which themselves
# use ${VAR:?required} syntax — so if the compose stack is brought up without
# a .env file (see .env.example), it fails loudly at the compose layer before
# the container even starts.
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL environment variable is required. "
        "Copy .env.example to .env and fill in POSTGRES_USER, "
        "POSTGRES_PASSWORD, POSTGRES_DB. See README.md for details."
    )

# Feature flag for ai/rollup.py fixture dispatch. Default False.
LIVE_AI = _as_bool(os.environ.get("LIVE_AI"), default=False)

# Plausible Analytics domain for the <script> tag on the public pages.
PLAUSIBLE_DOMAIN = os.environ.get("PLAUSIBLE_DOMAIN", "localhost")

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
PACKS_DIR = os.path.join(BASE_DIR, "packs")