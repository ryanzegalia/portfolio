"""AI rollup loader.

Public default (LIVE_AI=false): reads from packs/{pack_id}/rollups/{rollup_name}.md.
Local-only (LIVE_AI=true): would call Claude with the entity context. Not the
public path — never set LIVE_AI=true on the public host.
"""
import logging
from typing import Any

from config import LIVE_AI

log = logging.getLogger(__name__)


def get_rollup(pack, rollup_name: str) -> str:
    """
    Returns the markdown rollup text for a given pack + rollup name.
    Falls back to a small placeholder if the pre-rendered file doesn't exist.
    """
    if LIVE_AI:
        return _live_rollup(pack, rollup_name)
    return _mock_rollup(pack, rollup_name)


def _mock_rollup(pack, rollup_name: str) -> str:
    text = pack.rollups.get(rollup_name)
    if text:
        return text.strip()
    log.warning("rollup: missing %s for pack=%s, returning placeholder", rollup_name, pack.id)
    return f"_(rollup `{rollup_name}` not yet authored for {pack.id})_"


def _live_rollup(pack, rollup_name: str) -> str:
    """
    Local-only Claude rollup. Stub for now — would call anthropic SDK with the
    pack context and the entity rollup data. Falls back to mock if anthropic
    isn't available.
    """
    log.warning("rollup: LIVE_AI=true requested but live mode is dev-only; falling back to mock")
    return _mock_rollup(pack, rollup_name)


def load_rollup(pack, rollup_name: str) -> dict[str, Any]:
    """Returns a dict suitable for template rendering."""
    return {
        "pack_id": pack.id,
        "rollup_name": rollup_name,
        "markdown": get_rollup(pack, rollup_name),
        "live_mode": LIVE_AI,
    }