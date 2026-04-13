"""Demo 4.1 — The Multi-Threaded Deal.

Queries deal entities with their thread arrays, computes thread gap days
from last_touch_at timestamps, and identifies stalled deals.

Thread gap = max(days_since_last_touch) - min(days_since_last_touch) across
all threads in a deal. A large gap means one evaluation track has gone cold
while another is still active — a signal that the deal needs intervention.
"""
from datetime import datetime, timezone
from typing import Any
from sqlalchemy.orm import Session

from db import Entity
from packs import pack_query


def _days_since(iso_str: str | None, now: datetime) -> int | None:
    """Compute days since a timestamp. Returns None if unparseable."""
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (now - dt).days)
    except (ValueError, TypeError):
        return None


def _compute_thread_gap(threads: list[dict], now: datetime) -> int:
    """Compute the gap in days between the most and least recently touched threads.

    Parses last_touch_at ISO timestamps and computes days_since for each,
    then returns max - min. A gap of 0 means all threads were touched on
    the same day; a gap of 21 means one thread is 3 weeks staler than another.
    """
    touch_days = []
    for t in threads:
        days = _days_since(t.get("last_touch_at"), now)
        if days is not None:
            touch_days.append(days)
    if len(touch_days) < 2:
        return 0
    return max(touch_days) - min(touch_days)


def _thread_is_stalled(thread: dict, now: datetime) -> bool:
    """A thread is stalled if its last touch was more than 30 days ago."""
    if thread.get("status") == "no_contact":
        return False
    days = _days_since(thread.get("last_touch_at"), now)
    return days is not None and days > 30


def _format_relative_time(days_ago: int | None) -> str | None:
    """Convert days_ago integer to a human-readable relative string."""
    if days_ago is None:
        return None
    if days_ago == 0:
        return "today"
    if days_ago == 1:
        return "1 day ago"
    return f"{days_ago} days ago"


def build_multi_thread_deals(db: Session, pack) -> dict[str, Any]:
    """Query deal entities and compute thread gaps and stall detection."""
    now = datetime.now(timezone.utc)

    deals = (
        pack_query(db, Entity, pack)
        .filter(Entity.entity_type == "deal")
        .all()
    )

    formatted_deals = []
    stalled_count = 0

    for deal in deals:
        f = deal.fields or {}
        threads = f.get("threads", [])

        # Compute thread gap from timestamps
        thread_gap = _compute_thread_gap(threads, now)

        # Determine if deal has stalled threads
        has_stall = any(_thread_is_stalled(t, now) for t in threads)
        if has_stall:
            stalled_count += 1

        # Format threads with computed relative time strings
        formatted_threads = []
        for t in threads:
            days_ago = _days_since(t.get("last_touch_at"), now)
            trial_days = _days_since(t.get("last_trial_scan_at"), now)

            formatted_threads.append({
                "role": t.get("role"),
                "contact": t.get("contact"),
                "last_touch": _format_relative_time(days_ago),
                "days_since_touch": days_ago,
                "last_trial_scan": _format_relative_time(trial_days),
                "status": t.get("status", "active"),
                "detail": t.get("detail", ""),
            })

        formatted_deals.append({
            "company": f.get("company", deal.canonical_name),
            "deal_stage": f.get("deal_stage", ""),
            "deal_amount": f.get("deal_amount", 0),
            "assigned_ae": f.get("assigned_ae", ""),
            "threads": formatted_threads,
            "thread_gap_days": thread_gap,
        })

    # Sort by thread_gap descending (most stalled first)
    formatted_deals.sort(key=lambda d: d["thread_gap_days"], reverse=True)

    return {
        "deals": formatted_deals,
        "stalled_deal_count": stalled_count,
        "scenario": None,
    }
