"""Tests for /traffic client classification, sessionization and report build.

No database. traffic.py is pure functions over PageEvent-shaped objects, so
these run in the default `pytest tests/` pass alongside test_compute.py.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from traffic import (
    BOT,
    DIRECT,
    HUMAN,
    build_report,
    build_visits,
    classify_user_agent,
    referrer_label,
)

CHROME_WIN = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)
SAFARI_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
)


def event(path="/", *, ua=CHROME_WIN, visitor="v1", minutes=0, src=None,
          referrer=None, hash_route=None, base=None):
    base = base or datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
    return SimpleNamespace(
        path=path,
        hash_route=hash_route,
        referrer=referrer,
        src=src,
        user_agent=ua,
        visitor_hash=visitor,
        occurred_at=base + timedelta(minutes=minutes),
    )


class TestClassifyHumans:
    @pytest.mark.parametrize(
        "ua, browser, device",
        [
            (CHROME_WIN, "Chrome on Windows", "desktop"),
            (SAFARI_IPHONE, "Safari on iOS", "mobile"),
            (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
                "Edge on macOS",
                "desktop",
            ),
            (
                "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
                "Firefox on Linux",
                "desktop",
            ),
            (
                "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
                "(KHTML, like Gecko) Version/17.5 Safari/604.1",
                "Safari on iOS",
                "tablet",
            ),
        ],
    )
    def test_real_browsers_are_human(self, ua, browser, device):
        client = classify_user_agent(ua)
        assert client.kind == HUMAN
        assert client.label == browser
        assert client.device == device

    def test_cubot_phone_is_not_a_bot(self):
        """The Android brand CUBOT is the reason the generic rule needs a
        non-word character after "bot"; a person on a cheap phone is a person."""
        ua = (
            "Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        )
        assert classify_user_agent(ua).kind == HUMAN


class TestClassifyBots:
    @pytest.mark.parametrize(
        "ua, family, label",
        [
            ("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
             "search", "Googlebot"),
            ("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
             "search", "Bingbot"),
            ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; "
             "+https://openai.com/gptbot",
             "ai", "GPTBot (OpenAI)"),
            ("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
             "ai", "ClaudeBot (Anthropic)"),
            ("LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
             "preview", "LinkedIn link preview"),
            ("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
             "preview", "Slack link preview"),
            ("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
             "seo", "AhrefsBot"),
            ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
             "HeadlessChrome/131.0.0.0 Safari/537.36",
             "tool", "Headless Chrome"),
            ("python-requests/2.32.3", "tool", "python-requests"),
            ("curl/8.5.0", "tool", "curl"),
            ("Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
             "monitor", "UptimeRobot"),
        ],
    )
    def test_named_agents(self, ua, family, label):
        client = classify_user_agent(ua)
        assert client.kind == BOT
        assert client.family == family
        assert client.label == label

    def test_unnamed_crawler_falls_back_to_generic(self):
        client = classify_user_agent("Mozilla/5.0 (compatible; Someoddspider/1.0)")
        assert client.kind == BOT
        assert client.label == "Unrecognized bot"

    @pytest.mark.parametrize("ua", ["", None, "   "])
    def test_missing_user_agent_is_a_bot(self, ua):
        client = classify_user_agent(ua)
        assert client.kind == BOT
        assert client.label == "No user agent"


class TestReferrers:
    def test_empty_is_direct(self):
        assert referrer_label("") == DIRECT
        assert referrer_label(None) == DIRECT

    def test_own_host_is_dropped(self):
        assert referrer_label("https://ryanzegalia.com/platform",
                              {"ryanzegalia.com"}) is None

    def test_external_host_is_normalised(self):
        assert referrer_label("https://www.linkedin.com/feed/?x=1") == "linkedin.com"


class TestVisits:
    def test_gap_splits_a_visit(self):
        events = [
            event("/", minutes=0),
            event("/platform", minutes=5),
            event("/systems/gpu", minutes=90),  # past the 30 minute gap
        ]
        visits = build_visits(events)
        assert len(visits) == 2
        newest, older = visits  # sorted newest first
        assert newest.paths == ["/systems/gpu"]
        assert older.paths == ["/", "/platform"]
        assert older.duration_seconds == 300

    def test_repeat_path_counts_as_a_view_not_a_page(self):
        events = [event("/", minutes=0), event("/", minutes=1)]
        visit = build_visits(events)[0]
        assert visit.page_count == 1
        assert visit.views == 2
        assert visit.duration_label == "1m 00s"

    def test_single_beacon_reports_one_hit_not_zero_seconds(self):
        visit = build_visits([event("/")])[0]
        assert visit.duration_label == "one hit"

    def test_src_and_referrer_stick_to_the_visit(self):
        events = [
            event("/", minutes=0, src="canals", referrer="https://mail.google.com/"),
            event("/platform", minutes=2),
        ]
        visit = build_visits(events)[0]
        assert visit.src == "canals"
        assert visit.referrer == "mail.google.com"

    def test_two_visitors_do_not_merge(self):
        events = [event("/", visitor="a"), event("/", visitor="b", minutes=1)]
        assert len(build_visits(events)) == 2


class TestReport:
    def _mixed(self):
        return [
            event("/", visitor="human1", minutes=0, referrer="https://linkedin.com/x"),
            event("/platform", visitor="human1", minutes=2, hash_route="#/n/pricing"),
            event("/", visitor="bot1", minutes=3,
                  ua="Mozilla/5.0 (compatible; Googlebot/2.1; +http://x/bot.html)"),
        ]

    def test_humans_are_the_default_view(self):
        report = build_report(self._mixed())
        assert report["who"] == "humans"
        assert report["summary"]["human_views"] == 2
        assert report["summary"]["human_visitors"] == 1
        assert report["summary"]["bot_views"] == 1
        assert [row["key"] for row in report["by_page"]] == ["/", "/platform"]
        assert all(v.client.kind == HUMAN for v in report["visits"])

    def test_bots_view_shows_only_bots(self):
        report = build_report(self._mixed(), who="bots")
        assert [v.client.label for v in report["visits"]] == ["Googlebot"]
        assert report["by_page"] == [{"key": "/", "views": 1, "visitors": 1}]

    def test_by_day_always_carries_both_columns(self):
        report = build_report(self._mixed(), who="humans")
        day = report["by_day"][0]
        assert day["human_views"] == 2
        assert day["bot_views"] == 1

    def test_unknown_who_falls_back_to_humans(self):
        assert build_report(self._mixed(), who="nonsense")["who"] == "humans"

    def test_active_now_counts_only_recent_humans(self):
        base = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
        events = [
            event("/", visitor="stale", minutes=0, base=base),
            event("/", visitor="fresh", minutes=50, base=base),
        ]
        report = build_report(events, now=base + timedelta(minutes=55))
        assert report["summary"]["active_now"] == 1
        assert report["summary"]["last_human"] == base + timedelta(minutes=50)

    def test_referrer_is_the_arrival_not_every_page_after_it(self):
        """A three-page read from one LinkedIn click is one referral, not three."""
        events = [
            event("/", minutes=0, referrer="https://www.linkedin.com/in/x"),
            event("/platform", minutes=1, referrer="https://ryanzegalia.com/"),
            event("/systems/gpu", minutes=2, referrer="https://ryanzegalia.com/platform"),
        ]
        report = build_report(events, own_hosts={"ryanzegalia.com"})
        assert report["by_referrer"] == [
            {"key": "linkedin.com", "visits": 1, "views": 3, "visitors": 1}
        ]

    def test_src_tag_reports_depth_of_read(self):
        events = [
            event("/", minutes=0, src="canals"),
            event("/platform", minutes=1),
            event("/", visitor="other", minutes=2, src="canals"),
        ]
        report = build_report(events)
        assert report["by_src"] == [
            {"key": "canals", "visits": 2, "views": 3, "visitors": 2}
        ]

    def test_node_table_only_counts_platform_hash_routes(self):
        events = [
            event("/platform", hash_route="#/n/pricing"),
            event("/saas", minutes=1, hash_route="#/n/ignored"),
        ]
        report = build_report(events)
        assert [n["key"] for n in report["by_node"]] == ["#/n/pricing"]
