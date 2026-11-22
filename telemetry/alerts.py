"""Send an alert when a real person opens a tagged (?src=) link.

Why this is fussier than "POST to Discord on every beacon"
----------------------------------------------------------
The beacon in base.html is JavaScript, which already filters out crawlers that
never run scripts. What it does NOT filter out is the population that matters
here: ATS platforms and corporate email-security scanners (Proofpoint,
Mimecast and friends) rewrite and pre-fetch every link in a message, and they
do it with a real headless browser that runs the script and reports a
plausible desktop user agent. A tagged link goes out, the scanner opens the
link seconds later, and a naive alert says "someone read your application!"

An alert that is wrong half the time gets muted, and a muted alert is worse
than none. So three gates have to pass, all of them cheap:

  1. NOT A KNOWN BOT   -- reuse traffic.classify_user_agent, the same rules the
                          /traffic viewer uses. One source of truth; fixing a
                          rule fixes both.
  2. NOT RYAN          -- a private/loopback client IP means he is on the LAN
                          at home. Public visitors are never RFC1918.
  3. ACTUALLY READ IT  -- the visit must reach MIN_EVENTS pages AND MIN_DWELL
                          seconds. This is the gate that kills scanners: they
                          fetch, render, and leave in single-digit seconds.
                          The real 2026-08-04 ue-systems hit was 3 events in
                          8 seconds and would NOT alert under these defaults,
                          which is the intended (conservative) behaviour.

Then dedup on (visitor, src, day) so one reader is one message.

`decide()` is a pure function over already-fetched rows and is what the tests
exercise; nothing in this module needs a database or a network to be tested.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address

from traffic import HUMAN, classify_user_agent, referrer_label

logger = logging.getLogger(__name__)

# --- tunables (env-overridable, sane defaults) ------------------------------
MIN_EVENTS = int(os.environ.get("CLICK_ALERT_MIN_EVENTS", "2"))
MIN_DWELL_SEC = int(os.environ.get("CLICK_ALERT_MIN_DWELL_SEC", "15"))
VISIT_WINDOW = timedelta(minutes=30)  # matches traffic.VISIT_GAP

DISPATCHER_URL = os.environ.get(
    "DISPATCHER_URL", "")
DISPATCHER_KEY = os.environ.get("DISPATCHER_KEY", "")
ALERT_CHANNEL = os.environ.get("CLICK_ALERT_CHANNEL", "portfolio")
ENABLED = os.environ.get("CLICK_ALERT_ENABLED", "false").lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class Decision:
    """Either an alert to send, or the reason we are staying quiet."""

    send: bool
    reason: str
    title: str = ""
    message: str = ""
    fields: dict | None = None


def is_own_traffic(ip: str | None) -> bool:
    """True when the client is on the LAN (i.e. Ryan at home), so: stay quiet.

    A hiring manager is never on a private network. An unparseable or missing IP is
    treated as NOT own traffic -- failing open here risks one noisy alert,
    failing closed risks silently swallowing the one message that matters.
    """
    if not ip:
        return False
    try:
        addr = ip_address(ip.strip())
    except ValueError:
        return False
    return addr.is_private or addr.is_loopback or addr.is_link_local


def decide(events, *, now=None, own_hosts=None) -> Decision:
    """Pure: given one visitor's recent events (oldest first), alert or not.

    `events` are PageEvent-shaped: .path .hash_route .referrer .src
    .user_agent .occurred_at. They are expected to be a single visitor's rows
    inside VISIT_WINDOW, which is what makes len(events) a visit length.
    """
    if not events:
        return Decision(False, "no events")

    latest = events[-1]
    src = (latest.src or "").strip()
    if not src:
        return Decision(False, "no src tag (not a tagged link)")

    client = classify_user_agent(latest.user_agent)
    if client.kind != HUMAN:
        return Decision(False, "classified as bot: %s" % client.label)

    if len(events) < MIN_EVENTS:
        return Decision(False, "only %d event(s), need %d" % (len(events), MIN_EVENTS))

    now = now or datetime.now(timezone.utc)
    started = events[0].occurred_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    dwell = (now - started).total_seconds()
    if dwell < MIN_DWELL_SEC:
        return Decision(
            False, "dwell %.0fs under %ds floor" % (dwell, MIN_DWELL_SEC))

    # --- worth telling him about -------------------------------------------
    pages, nodes = [], []
    for e in events:
        if e.path and e.path not in pages:
            pages.append(e.path)
        route = (e.hash_route or "").strip()
        if route.startswith("#/n/"):
            node = route[4:]
            if node and node not in nodes:
                nodes.append(node)

    came_from = referrer_label(events[0].referrer, own_hosts or set())

    fields = {
        "Application": src,
        "Time on site": _humanise(dwell),
        "Pages": "%d (%s)" % (len(pages), ", ".join(pages[:6])),
        "Client": client.label + (" / %s" % client.device if client.device else ""),
    }
    if nodes:
        fields["Systems opened"] = ", ".join(nodes[:8])
    if came_from:
        fields["Came from"] = came_from

    return Decision(
        True,
        "ok",
        title="Someone opened your %s link" % src,
        message=(
            "A visitor that does not look like a bot followed the `?src=%s` "
            "link and stayed %s across %d page(s)."
            % (src, _humanise(dwell), len(pages))
        ),
        fields=fields,
    )


def _humanise(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 90:
        return "%ds" % seconds
    minutes = seconds // 60
    if minutes < 60:
        return "%dm %ds" % (minutes, seconds % 60)
    return "%dh %dm" % (minutes // 60, minutes % 60)


def send(decision: Decision, *, url: str | None = None, timeout: int = 5) -> bool:
    """POST to the configured alert dispatcher. Never raises."""
    if not decision.send:
        return False
    if not ENABLED:
        logger.debug("click alert suppressed: CLICK_ALERT_ENABLED is false")
        return False
    if not DISPATCHER_KEY:
        logger.warning("click alert not sent: DISPATCHER_KEY is unset")
        return False

    payload = {
        "service": "portfolio-traffic",
        "channel": ALERT_CHANNEL,
        "severity": "INFO",
        "title": decision.title,
        "message": decision.message,
        "fields": decision.fields or {},
        "url": url or "https://ryanzegalia.com/traffic",
    }
    req = urllib.request.Request(
        DISPATCHER_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Dispatcher-Key": DISPATCHER_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
        return True
    except Exception as e:  # a dead dispatcher must never matter to the site
        logger.warning("click alert dispatch failed (non-fatal): %s", e)
        return False
