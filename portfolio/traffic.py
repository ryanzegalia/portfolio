"""Client classification, sessionization and report assembly for /traffic.

Pure functions. No database, no request object, no template. `build_report()`
takes a flat list of PageEvent-shaped objects and returns the dict the
traffic template renders, which is what makes the whole thing testable
without Postgres (see tests/test_traffic_classify.py).

What the numbers can and cannot say
-----------------------------------
The beacon in base.html is JavaScript. A client only lands in `page_events`
if it executed that script, so the population here is already skewed toward
real browsers. Crawlers that fetch HTML and never run scripts (most AI
training crawlers, curl, plain scrapers) are invisible to this table
entirely; the ones that do show up are the JS-rendering crawlers, headless
automation and link-preview fetchers. That is why "bot" here means "a
non-person that got far enough to run our script", not "every bot that
touched the server".

Classification is done at view time from the stored user_agent string, so
the rules below can be corrected later without a backfill.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

try:  # tzdata is present in the deploy image; fall back rather than crash
    from zoneinfo import ZoneInfo

    LOCAL_TZ = ZoneInfo("America/New_York")
    LOCAL_TZ_LABEL = "ET"
except Exception:  # pragma: no cover - exotic images without tzdata
    LOCAL_TZ = timezone.utc
    LOCAL_TZ_LABEL = "UTC"


# ---------------------------------------------------------------------------
# Client classification
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Client:
    """What kind of thing produced an event.

    kind    -- "human" or "bot". The only thing the default view filters on.
    family  -- browser | search | ai | preview | seo | monitor | tool | unknown
    label   -- display name ("Chrome on Windows", "Googlebot")
    device  -- desktop | mobile | tablet | "" (unknown)
    """

    kind: str
    family: str
    label: str
    device: str = ""


HUMAN = "human"
BOT = "bot"

# Named agents, checked in order. A named hit wins over the generic patterns
# below so the viewer shows "LinkedIn link preview" instead of "bot".
# `family` is what makes the list worth keeping: a preview fetch means a human
# pasted the URL into LinkedIn or Slack, which is a different signal from a
# search crawler indexing the site.
_NAMED: list[tuple[str, str, str]] = [
    # Search engines
    ("googlebot", "search", "Googlebot"),
    ("google-inspectiontool", "search", "Google Inspection Tool"),
    ("storebot-google", "search", "Google StoreBot"),
    ("adsbot-google", "search", "Google AdsBot"),
    ("mediapartners-google", "search", "Google AdSense"),
    ("apis-google", "search", "Google APIs"),
    ("bingbot", "search", "Bingbot"),
    ("bingpreview", "search", "Bing Preview"),
    ("duckduckbot", "search", "DuckDuckBot"),
    ("duckduckgo-favicons", "search", "DuckDuckGo favicons"),
    ("yandexbot", "search", "YandexBot"),
    ("baiduspider", "search", "Baiduspider"),
    ("applebot", "search", "Applebot"),
    ("petalbot", "search", "PetalBot"),
    ("seznambot", "search", "SeznamBot"),
    ("ia_archiver", "search", "Internet Archive"),
    ("archive.org_bot", "search", "Internet Archive"),
    # AI crawlers and assistant fetches
    ("gptbot", "ai", "GPTBot (OpenAI)"),
    ("oai-searchbot", "ai", "OpenAI SearchBot"),
    ("chatgpt-user", "ai", "ChatGPT browsing"),
    ("claudebot", "ai", "ClaudeBot (Anthropic)"),
    ("claude-web", "ai", "Claude-Web (Anthropic)"),
    ("claude-user", "ai", "Claude browsing"),
    ("anthropic-ai", "ai", "Anthropic AI"),
    ("perplexitybot", "ai", "PerplexityBot"),
    ("perplexity-user", "ai", "Perplexity user fetch"),
    ("google-extended", "ai", "Google-Extended"),
    ("ccbot", "ai", "CCBot (Common Crawl)"),
    ("bytespider", "ai", "Bytespider (ByteDance)"),
    ("amazonbot", "ai", "Amazonbot"),
    ("meta-externalagent", "ai", "Meta External Agent"),
    ("cohere-ai", "ai", "Cohere AI"),
    ("diffbot", "ai", "Diffbot"),
    ("timpibot", "ai", "Timpibot"),
    ("youbot", "ai", "YouBot"),
    # Link previews: a person pasted the URL somewhere
    ("linkedinbot", "preview", "LinkedIn link preview"),
    ("slackbot", "preview", "Slack link preview"),
    ("slack-imgproxy", "preview", "Slack image proxy"),
    ("twitterbot", "preview", "X/Twitter link preview"),
    ("facebookexternalhit", "preview", "Facebook link preview"),
    ("facebookcatalog", "preview", "Facebook catalog"),
    ("whatsapp", "preview", "WhatsApp link preview"),
    ("telegrambot", "preview", "Telegram link preview"),
    ("discordbot", "preview", "Discord link preview"),
    ("redditbot", "preview", "Reddit link preview"),
    ("skypeuripreview", "preview", "Skype link preview"),
    ("microsoftpreview", "preview", "Microsoft link preview"),
    ("embedly", "preview", "Embedly link preview"),
    ("iframely", "preview", "Iframely link preview"),
    ("mastodon", "preview", "Mastodon link preview"),
    # SEO and marketing scrapers
    ("ahrefsbot", "seo", "AhrefsBot"),
    ("semrushbot", "seo", "SemrushBot"),
    ("mj12bot", "seo", "MJ12bot"),
    ("dotbot", "seo", "DotBot"),
    ("blexbot", "seo", "BLEXBot"),
    ("dataforseo", "seo", "DataForSeoBot"),
    ("screaming frog", "seo", "Screaming Frog"),
    ("serpstatbot", "seo", "SerpstatBot"),
    ("barkrowler", "seo", "Barkrowler"),
    ("linkdexbot", "seo", "LinkdexBot"),
    # Uptime and performance monitoring
    ("uptimerobot", "monitor", "UptimeRobot"),
    ("uptime-kuma", "monitor", "Uptime Kuma"),
    ("pingdom", "monitor", "Pingdom"),
    ("statuscake", "monitor", "StatusCake"),
    ("site24x7", "monitor", "Site24x7"),
    ("betteruptime", "monitor", "Better Uptime"),
    ("newrelicpinger", "monitor", "New Relic"),
    ("datadog", "monitor", "Datadog"),
    ("zabbix", "monitor", "Zabbix"),
    ("chrome-lighthouse", "monitor", "Lighthouse audit"),
    ("lighthouse", "monitor", "Lighthouse audit"),
    ("pagespeed", "monitor", "PageSpeed Insights"),
    ("gtmetrix", "monitor", "GTmetrix"),
    # Automation and HTTP clients
    ("headlesschrome", "tool", "Headless Chrome"),
    ("puppeteer", "tool", "Puppeteer"),
    ("playwright", "tool", "Playwright"),
    ("selenium", "tool", "Selenium"),
    ("webdriver", "tool", "WebDriver"),
    ("phantomjs", "tool", "PhantomJS"),
    ("python-requests", "tool", "python-requests"),
    ("python-httpx", "tool", "httpx"),
    ("python-urllib", "tool", "urllib"),
    ("aiohttp", "tool", "aiohttp"),
    ("scrapy", "tool", "Scrapy"),
    ("curl/", "tool", "curl"),
    ("wget", "tool", "wget"),
    ("go-http-client", "tool", "Go HTTP client"),
    ("okhttp", "tool", "OkHttp"),
    ("java/", "tool", "Java HTTP client"),
    ("axios", "tool", "axios"),
    ("node-fetch", "tool", "node-fetch"),
    ("postmanruntime", "tool", "Postman"),
    ("insomnia", "tool", "Insomnia"),
    ("libwww-perl", "tool", "libwww-perl"),
    ("apache-httpclient", "tool", "Apache HttpClient"),
    ("guzzlehttp", "tool", "Guzzle"),
    ("zgrab", "tool", "zgrab scanner"),
    ("masscan", "tool", "masscan scanner"),
    ("nmap", "tool", "nmap scanner"),
]

# Generic fallback. The `bot` alternative deliberately refuses to fire when the
# character after "bot" is a word character, so the Android phone brand CUBOT
# ("CUBOT_X30", "CUBOT NOTE") does not classify a real person as a crawler.
_GENERIC_BOT_RE = re.compile(
    r"(?:^|[^a-z0-9_])"
    # Crawlers name themselves by concatenation ("Someoddspider"), so the
    # family word is allowed a prefix but never a trailing word character.
    r"(?:[a-z0-9.+-]*(?:bot|spider|crawler|scraper|fetcher|indexer|slurp)"
    r"|crawling|scraping|validator|feedparser|monitoring|uptime|headless"
    r"|http-?client|libcurl)"
    r"(?:[^a-z0-9_]|$)"
)

_UNKNOWN = Client(kind=BOT, family="unknown", label="No user agent", device="")


def _device_of(ua: str) -> str:
    if "ipad" in ua or "tablet" in ua or ("android" in ua and "mobile" not in ua):
        return "tablet"
    if "mobile" in ua or "iphone" in ua or "ipod" in ua or "android" in ua:
        return "mobile"
    return "desktop"


def _browser_of(ua: str) -> str:
    # Order matters: every Chromium fork also says "chrome" and "safari".
    if "edg/" in ua or "edga/" in ua or "edgios/" in ua or "edge/" in ua:
        return "Edge"
    if "opr/" in ua or "opera" in ua:
        return "Opera"
    if "samsungbrowser" in ua:
        return "Samsung Internet"
    if "yabrowser" in ua:
        return "Yandex Browser"
    if "vivaldi" in ua:
        return "Vivaldi"
    if "brave" in ua:
        return "Brave"
    if "duckduckgo" in ua:
        return "DuckDuckGo Browser"
    if "firefox" in ua or "fxios" in ua:
        return "Firefox"
    if "crios" in ua or "chrome" in ua or "chromium" in ua:
        return "Chrome"
    if "safari" in ua and "version/" in ua:
        return "Safari"
    if "msie" in ua or "trident" in ua:
        return "Internet Explorer"
    return "Browser"


def _os_of(ua: str) -> str:
    if "windows nt" in ua or "windows phone" in ua:
        return "Windows"
    if "iphone" in ua or "ipad" in ua or "ipod" in ua or "ios " in ua:
        return "iOS"
    if "cros" in ua:
        return "ChromeOS"
    if "android" in ua:
        return "Android"
    if "mac os x" in ua or "macintosh" in ua:
        return "macOS"
    if "linux" in ua or "x11" in ua:
        return "Linux"
    return ""


def classify_user_agent(user_agent: str | None) -> Client:
    """Map a stored user agent string onto a Client.

    Unknown-but-plausible browser strings stay human. The cost of the two
    error directions is not symmetric here: calling a real reader a bot hides
    the one event Ryan cares about, while a stray crawler in the human column
    is visible and correctable from the recent-visits table.
    """
    if not user_agent or not user_agent.strip():
        return _UNKNOWN

    ua = user_agent.lower()

    for needle, family, label in _NAMED:
        if needle in ua:
            return Client(kind=BOT, family=family, label=label, device="")

    if _GENERIC_BOT_RE.search(ua):
        return Client(kind=BOT, family="unknown", label="Unrecognized bot", device="")

    device = _device_of(ua)
    browser = _browser_of(ua)
    os_name = _os_of(ua)
    label = f"{browser} on {os_name}" if os_name else browser
    return Client(kind=HUMAN, family="browser", label=label, device=device)


# ---------------------------------------------------------------------------
# Referrers
# ---------------------------------------------------------------------------
DIRECT = "(direct or private)"


def referrer_label(referrer: str | None, own_hosts: set[str] | None = None) -> str | None:
    """Host a visit arrived from, or None when it is our own page.

    Returns DIRECT for an empty referrer, which on a public site also covers
    clicks out of email clients, PDFs and anything sent with a strict
    referrer policy. It is not proof nobody linked the page.
    """
    if not referrer or not referrer.strip():
        return DIRECT
    host = urlsplit(referrer.strip()).netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return DIRECT
    if own_hosts and host in own_hosts:
        return None
    return host


# ---------------------------------------------------------------------------
# Visits (sessionization)
# ---------------------------------------------------------------------------
@dataclass
class Visit:
    """One visitor's continuous run of events, split on a 30 minute gap."""

    visitor: str
    client: Client
    started_at: datetime
    ended_at: datetime
    paths: list[str] = field(default_factory=list)
    nodes: list[str] = field(default_factory=list)
    src: str | None = None
    referrer: str | None = None
    views: int = 0

    @property
    def duration_seconds(self) -> int:
        return int((self.ended_at - self.started_at).total_seconds())

    @property
    def duration_label(self) -> str:
        # A single beacon carries no second timestamp, so its duration is 0 by
        # construction. Say that rather than print a misleading "0s".
        if self.views < 2:
            return "one hit"
        secs = self.duration_seconds
        if secs < 60:
            return f"{secs}s"
        if secs < 3600:
            return f"{secs // 60}m {secs % 60:02d}s"
        return f"{secs // 3600}h {(secs % 3600) // 60:02d}m"

    @property
    def page_count(self) -> int:
        return len(self.paths)


VISIT_GAP = timedelta(minutes=30)


def build_visits(events, own_hosts: set[str] | None = None) -> list[Visit]:
    """Group events into visits. `events` must be sorted oldest first.

    A visit ends when the same visitor hash goes quiet for 30 minutes. The
    hash is re-salted at UTC midnight by the beacon, so a visit never spans a
    day boundary and a returning reader looks like a new visitor the next
    day. That is the privacy trade the beacon already made; it is stated here
    because it puts a floor under how much the visitor counts can mean.
    """
    by_visitor: dict[str, list] = {}
    for event in events:
        by_visitor.setdefault(event.visitor_hash or "?", []).append(event)

    visits: list[Visit] = []
    for visitor, rows in by_visitor.items():
        current: Visit | None = None
        for event in rows:
            when = event.occurred_at
            if current is None or (when - current.ended_at) > VISIT_GAP:
                current = Visit(
                    visitor=visitor,
                    client=classify_user_agent(event.user_agent),
                    started_at=when,
                    ended_at=when,
                    referrer=referrer_label(event.referrer, own_hosts),
                )
                visits.append(current)
            current.ended_at = when
            current.views += 1
            if not current.paths or current.paths[-1] != event.path:
                current.paths.append(event.path)
            if event.hash_route and event.hash_route not in current.nodes:
                current.nodes.append(event.hash_route)
            if event.src and not current.src:
                current.src = event.src
            if current.referrer is None:
                current.referrer = referrer_label(event.referrer, own_hosts)

    visits.sort(key=lambda v: v.started_at, reverse=True)
    return visits


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------
def _tally(pairs) -> list[dict]:
    """Fold (key, visitor) pairs into rows of key / views / visitors."""
    counts: dict[str, dict] = {}
    for key, visitor in pairs:
        row = counts.setdefault(key, {"key": key, "views": 0, "visitors": set()})
        row["views"] += 1
        row["visitors"].add(visitor)
    rows = [
        {"key": r["key"], "views": r["views"], "visitors": len(r["visitors"])}
        for r in counts.values()
    ]
    rows.sort(key=lambda r: (-r["views"], r["key"] or ""))
    return rows


def _tally_visits(visits, key_of) -> list[dict]:
    """Fold visits into rows of key / visits / views / visitors.

    Referrer and source tag belong to the arrival, not to every page the
    visitor then clicked, so counting them per view would inflate whichever
    entry point led to the longest read. One row per visit is the honest
    count for "where did this come from".
    """
    counts: dict[str, dict] = {}
    for visit in visits:
        key = key_of(visit)
        if key is None:
            continue
        row = counts.setdefault(
            key, {"key": key, "visits": 0, "views": 0, "visitors": set()}
        )
        row["visits"] += 1
        row["views"] += visit.views
        row["visitors"].add(visit.visitor)
    rows = [
        {"key": r["key"], "visits": r["visits"], "views": r["views"],
         "visitors": len(r["visitors"])}
        for r in counts.values()
    ]
    rows.sort(key=lambda r: (-r["visits"], -r["views"], r["key"] or ""))
    return rows


ACTIVE_WINDOW = timedelta(minutes=15)


def build_report(
    events,
    *,
    who: str = "humans",
    own_hosts: set[str] | None = None,
    now: datetime | None = None,
) -> dict:
    """Assemble every table the /traffic template renders.

    `events` is oldest-first. `who` filters the per-page/source/visit tables
    to "humans" (default), "bots" or "all"; the day table and the headline
    counts always show both so a bot wave is never hidden by the filter.
    """
    now = now or datetime.now(timezone.utc)
    own_hosts = own_hosts or set()
    who = who if who in {"humans", "bots", "all"} else "humans"

    tagged = [(e, classify_user_agent(e.user_agent)) for e in events]
    humans = [(e, c) for e, c in tagged if c.kind == HUMAN]
    bots = [(e, c) for e, c in tagged if c.kind == BOT]

    if who == "humans":
        selected = humans
    elif who == "bots":
        selected = bots
    else:
        selected = tagged

    # Headline counts. Both columns, always.
    def _visitors(rows):
        return len({e.visitor_hash for e, _ in rows if e.visitor_hash})

    active_since = now - ACTIVE_WINDOW
    active_now = len(
        {e.visitor_hash for e, _ in humans if e.occurred_at >= active_since}
    )
    last_human = max((e.occurred_at for e, _ in humans), default=None)

    all_visits = build_visits([e for e, _ in tagged], own_hosts)
    human_visits = [v for v in all_visits if v.client.kind == HUMAN]
    bot_visits = [v for v in all_visits if v.client.kind == BOT]
    if who == "humans":
        visits = human_visits
    elif who == "bots":
        visits = bot_visits
    else:
        visits = all_visits

    summary = {
        "human_views": len(humans),
        "human_visitors": _visitors(humans),
        "human_visits": len(human_visits),
        "bot_views": len(bots),
        "bot_visitors": _visitors(bots),
        "bot_visits": len(bot_visits),
        "active_now": active_now,
        "last_human": last_human,
    }

    # By day: humans and bots side by side.
    days: dict[str, dict] = {}
    for rows, key in ((humans, "human"), (bots, "bot")):
        for event, _ in rows:
            day = to_local(event.occurred_at).date().isoformat()
            slot = days.setdefault(
                day,
                {"day": day, "human_views": 0, "bot_views": 0,
                 "_human_visitors": set(), "_bot_visitors": set()},
            )
            slot[f"{key}_views"] += 1
            slot[f"_{key}_visitors"].add(event.visitor_hash)
    by_day = [
        {
            "day": d["day"],
            "human_views": d["human_views"],
            "human_visitors": len(d["_human_visitors"] - {None}),
            "bot_views": d["bot_views"],
            "bot_visitors": len(d["_bot_visitors"] - {None}),
        }
        for d in days.values()
    ]
    by_day.sort(key=lambda d: d["day"], reverse=True)

    by_page = _tally((e.path, e.visitor_hash) for e, _ in selected)
    by_node = _tally(
        (e.hash_route, e.visitor_hash)
        for e, _ in selected
        if e.path == "/platform" and e.hash_route
    )

    by_referrer = _tally_visits(visits, lambda v: v.referrer)
    by_src = _tally_visits(visits, lambda v: v.src)

    families = {c.label: c.family for _, c in selected}
    by_client = _tally((c.label, e.visitor_hash) for e, c in selected)
    for row in by_client:
        row["family"] = families.get(row["key"], "")

    return {
        "who": who,
        "summary": summary,
        "by_day": by_day,
        "by_page": by_page,
        "by_src": by_src,
        "by_node": by_node,
        "by_referrer": by_referrer,
        "by_client": by_client,
        "visits": visits,
        "tz_label": LOCAL_TZ_LABEL,
    }


def to_local(when: datetime | None) -> datetime | None:
    """Render UTC storage in the timezone Ryan actually reads the page in."""
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(LOCAL_TZ)
