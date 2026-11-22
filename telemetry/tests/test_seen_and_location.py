import json
import os
import threading
import time
from unittest.mock import Mock
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, insert, select
from sqlalchemy.pool import StaticPool

os.environ['NETINFO_OFFLINE'] = 'true'
os.environ['TRUSTED_PROXIES'] = '192.0.2.8/32'
os.environ['TRAFFIC_LAN_HOST'] = 'traffic.example.test'
os.environ['HOME_IP'] = '8.8.4.4,8.8.4.5'
os.environ['TRAFFIC_TOKEN'] = 'local-test-token'  # same as test_service: whichever file imports app first fixes the token
import app
import iplocate
from investigation import seen_before

ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36'
ANDROID_OLD = ANDROID.replace('157', '156')
MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/157.0.8103.37 Mobile/15E148 Safari/604.1'
MALI, APPLE = 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)', 'Apple GPU'
OCT30, NOV09, NOV10 = 1793382833.0, 1794263040.0, 1794324768.0
REAL_WORKER = iplocate.worker


@pytest.fixture(autouse=True)
def db(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    monkeypatch.setattr(app, 'engine', engine)
    monkeypatch.setattr(app.enrichment, 'maintenance', lambda stop, prune: None)
    monkeypatch.setattr(iplocate, 'worker', lambda stop, store: None)
    iplocate._cache.clear(); iplocate._pending.clear()
    while not iplocate._queue.empty():
        iplocate._queue.get_nowait()
    app.meta.create_all(engine)
    yield engine
    engine.dispose()


def visit(ip, ua, screen, started, org='Charter'):
    return dict(id=str(uuid4()), ip=ip, ua=ua, screen=screen, started=started, org=org, own=False)


# --- seen before -----------------------------------------------------------------------------

def test_launch_day_phone_is_same_device_same_address():
    launch = visit('8.8.184.147', ANDROID_OLD, '427x952', OCT30)
    today = visit('8.8.184.147', ANDROID, '427x952', NOV10)
    lines = seen_before(today, [launch, today], {launch['id']: MALI, today['id']: MALI})
    assert len(lines) == 1 and lines[0].startswith('Same Android phone, same address seen before: Oct 30')


def test_household_other_device_is_not_called_the_same_device():
    mac = visit('8.8.186.152', MAC, '1920x1080', NOV09)
    phone = visit('8.8.186.152', IPHONE, '430x932', NOV10)
    lines = seen_before(phone, [mac, phone], {phone['id']: APPLE})
    assert lines == [f"Same address, another device or browser (Mac): Nov 09 5:24 PM"]


def test_apple_lookalike_elsewhere_is_not_matched_but_distinctive_chip_is():
    a = visit('8.8.186.152', IPHONE, '430x932', NOV09)
    b = visit('174.197.194.94', IPHONE, '430x932', NOV10, org='CELLCO-PART - Verizon')
    assert seen_before(b, [a, b], {a['id']: APPLE, b['id']: APPLE}) == []
    c = visit('8.8.184.147', ANDROID, '427x952', NOV09)
    d = visit('174.197.194.94', ANDROID, '427x952', NOV10, org='CELLCO-PART - Verizon')
    lines = seen_before(d, [c, d], {c['id']: MALI, d['id']: MALI})
    assert lines and lines[0].startswith('Possibly the same Android phone from another address')


def test_later_visits_and_conflicting_chip_do_not_count():
    early = visit('1.2.3.4', ANDROID, '427x952', NOV09)
    later = visit('1.2.3.4', ANDROID, '427x952', NOV10)
    assert seen_before(early, [early, later], {}) == []
    assert seen_before(later, [early, later], {early['id']: 'Adreno 740', later['id']: MALI})[0].startswith('Same address, another device')


def test_viewer_shows_seen_before_and_zip(db):
    old_id, new_id = str(uuid4()), str(uuid4())
    with db.begin() as conn:
        for vid, started, ua in ((old_id, OCT30, ANDROID_OLD), (new_id, time.time() - 60, ANDROID)):
            conn.execute(insert(app.visits).values(id=vid, started=started, last_seen=started, ip='8.8.184.147', ua=ua, screen='427x952', visible_ms=60000, seq=1, own=False, city='Saratoga Springs', region='New York', country='United States', org='Charter'))
            conn.execute(insert(app.graphics).values(id=f'{vid}:1:0', visit=vid, received=started, data=json.dumps({'gpu': MALI})))
        conn.execute(insert(app.geo_cache).values(ip='8.8.184.147', zip='12866', city='Saratoga Springs', region='New York', country='United States', looked_up=time.time()))
    with TestClient(app.app, client=('8.8.8.8', 1)) as c:
        page = c.get('/traffic?k=local-test-token&days=1').text
    assert 'Same Android phone, same address seen before: Oct 30 1:53 PM' in page
    assert 'Saratoga Springs, New York 12866' in page


# --- location ---------------------------------------------------------------------------------

def test_want_never_sends_private_or_own_addresses(monkeypatch):
    monkeypatch.setattr(app.netinfo, 'is_own', lambda ip: ip == '8.8.4.4')
    assert not iplocate.want('192.0.2.20')
    assert not iplocate.want('8.8.4.4')
    assert iplocate.want('8.8.184.147')
    assert not iplocate.want('8.8.184.147')  # already waiting


def test_fetch_parses_answer_and_handles_failure(monkeypatch):
    ok = httpx.Response(200, json={'status': 'success', 'country': 'United States', 'regionName': 'New York', 'city': 'Springfield', 'zip': '00000'}, request=httpx.Request('GET', 'http://x'))
    monkeypatch.setattr(iplocate.httpx, 'get', Mock(return_value=ok))
    rec = iplocate.fetch('8.8.4.5')
    assert (rec['city'], rec['zip'], rec['region']) == ('Springfield', '00000', 'New York')
    bad = httpx.Response(200, json={'status': 'fail', 'message': 'reserved range'}, request=httpx.Request('GET', 'http://x'))
    monkeypatch.setattr(iplocate.httpx, 'get', Mock(return_value=bad))
    assert iplocate.fetch('8.8.4.5') is None


def test_location_prefers_ip_api_then_falls_back(monkeypatch):
    monkeypatch.setattr(app.enrichment, 'geo', lambda ip: dict(country='United States', region='New York', city='Shelbyville'))
    assert app.location('8.8.186.152')['city'] == 'Shelbyville'
    assert '8.8.186.152' in iplocate._pending
    iplocate.remember('8.8.186.152', dict(country='United States', region='New York', city='Springfield', zip='00000', looked_up=time.time()))
    assert app.location('8.8.186.152')['city'] == 'Springfield'
    iplocate.remember('8.8.186.152', dict(country='United States', region='New York', city='Springfield', zip='00000', looked_up=time.time() - 31 * 86400))
    assert app.location('8.8.186.152')['city'] == 'Shelbyville'  # stale answers are asked again


def test_store_relabels_stored_visits(db):
    vid = str(uuid4())
    with db.begin() as conn:
        conn.execute(insert(app.visits).values(id=vid, started=time.time(), last_seen=time.time(), ip='8.8.4.5', city='Shelbyville', region='New York', country='United States', own=False))
    app.store_better_geo('8.8.4.5', dict(country='United States', region='New York', city='Springfield', zip='00000', looked_up=time.time()))
    app.store_better_geo('8.8.4.5', dict(country='United States', region='New York', city='Springfield', zip='00000', looked_up=time.time()))  # re-store is fine
    with db.connect() as conn:
        assert conn.execute(select(app.visits.c.city)).scalar() == 'Springfield'
        assert conn.execute(select(app.geo_cache.c.zip)).scalar() == '00000'


def test_worker_stores_and_backs_off_on_rate_limit(monkeypatch):
    monkeypatch.setattr(iplocate.netinfo, 'OFFLINE', False)
    monkeypatch.setattr(iplocate, 'GAP', 0.01)
    monkeypatch.setattr(iplocate, 'BACKOFF', 0.01)
    limited = httpx.Response(429, request=httpx.Request('GET', 'http://x'))
    answers = [httpx.HTTPStatusError('429', request=limited.request, response=limited),
               dict(country='United States', region='New York', city='Saratoga Springs', zip='12866', looked_up=time.time())]
    def fake_fetch(ip):
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    monkeypatch.setattr(iplocate, 'fetch', fake_fetch)
    stored, stop = [], threading.Event()
    def store(ip, rec):
        stored.append((ip, rec['city'])); stop.set()
    iplocate.want('8.8.184.147')
    t = threading.Thread(target=REAL_WORKER, args=(stop, store)); t.start(); t.join(5)
    assert stored == [('8.8.184.147', 'Saratoga Springs')] and not answers
    assert iplocate.cached('8.8.184.147')['zip'] == '12866'
