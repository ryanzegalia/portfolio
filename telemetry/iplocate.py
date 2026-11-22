"""Second-opinion location from ip-api.com, preferred over DB-IP City Lite once known.

Why: on 2026-11-10 ip-api was the only one of four free lookups that placed a test
address in the right town (Springfield; DB-IP, ipinfo and ipapi.co all said Shelbyville).

How it stays off the beacon's path: the beacon never waits on the network. It reads this module's
in-memory cache; on a miss it queues the address and DB-IP answers for now. One worker thread asks
ip-api for queued addresses at most ~40 a minute (free tier allows 45; HTTP only, personal use),
stores each answer, and rewrites that address's stored visits.

Only public, outside addresses are ever sent. Ryan's own and private/LAN addresses never leave.
Answers older than MAX_AGE are asked again (home addresses get reassigned).
"""
from __future__ import annotations

import ipaddress
import logging
import queue
import threading
import time

import httpx

import netinfo

log = logging.getLogger(__name__)

URL = 'http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,zip'
MAX_AGE = 30 * 86400
GAP = 1.6          # seconds between requests: ~37/min, under the 45/min free limit
BACKOFF = 65       # seconds to wait after a 429 / rate-limit answer

_cache: dict[str, dict] = {}   # ip -> {country, region, city, zip, looked_up}
_pending: set[str] = set()
_queue: queue.Queue[str] = queue.Queue(maxsize=2000)
_lock = threading.Lock()


def _public(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def cached(ip: str) -> dict | None:
    """Fresh ip-api answer for this address, or None."""
    with _lock:
        rec = _cache.get(ip)
    if rec and time.time() - rec.get('looked_up', 0) < MAX_AGE:
        return rec
    return None


def remember(ip: str, rec: dict) -> None:
    with _lock:
        _cache[ip] = rec


def want(ip: str) -> bool:
    """Queue an address for lookup. Returns True if queued (outside, not fresh, not already waiting)."""
    if not _public(ip) or netinfo.is_own(ip) or cached(ip):
        return False
    with _lock:
        if ip in _pending:
            return False
        _pending.add(ip)
    try:
        _queue.put_nowait(ip)
        return True
    except queue.Full:
        with _lock:
            _pending.discard(ip)
        return False


def fetch(ip: str) -> dict | None:
    """One ip-api lookup. None when ip-api has no answer for the address.
    Raises httpx.HTTPStatusError on 429 so the worker can back off."""
    response = httpx.get(URL.format(ip=ip), timeout=10)
    response.raise_for_status()
    data = response.json()
    if data.get('status') != 'success':
        return None
    return dict(country=(data.get('country') or '')[:100], region=(data.get('regionName') or '')[:100],
                city=(data.get('city') or '')[:100], zip=(data.get('zip') or '')[:20], looked_up=time.time())


def worker(stop: threading.Event, store) -> None:
    """Drain the queue until `stop`. `store(ip, rec)` persists one answer; it must not raise."""
    while not stop.is_set():
        try:
            ip = _queue.get(timeout=5)
        except queue.Empty:
            continue
        wait, requeue = GAP, False
        try:
            if netinfo.OFFLINE or cached(ip):
                wait = 0
                continue
            rec = fetch(ip)
            if rec:
                remember(ip, rec)
                store(ip, rec)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                wait, requeue = BACKOFF, True
            else:
                log.warning('ip-api lookup failed (status %s); DB-IP location kept', exc.response.status_code)
        except Exception:
            log.warning('ip-api lookup failed; DB-IP location kept')
        finally:
            if requeue:
                try:
                    _queue.put_nowait(ip)  # still pending; asked again after the back-off
                except queue.Full:
                    requeue = False
            if not requeue:
                with _lock:
                    _pending.discard(ip)
            if wait:
                stop.wait(wait)
