import os
import time
from uuid import uuid4
from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, insert, update
from sqlalchemy.pool import StaticPool

os.environ['NETINFO_OFFLINE'] = 'true'
os.environ['TRUSTED_PROXIES'] = '192.0.2.8/32'
os.environ['TRAFFIC_LAN_HOST'] = 'traffic.example.test'
os.environ['HOME_IP'] = '8.8.4.4'
os.environ['TRAFFIC_TOKEN'] = 'local-test-token'
import app
import enrichment
from investigation import arrival, mail_candidate, scanner_bursts

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36'
SLUG = next(iter(app.TITLES))

@pytest.fixture(autouse=True)
def db(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread':False}, poolclass=StaticPool)
    monkeypatch.setattr(app, 'engine', engine)
    monkeypatch.setattr(enrichment, 'maintenance', lambda stop, prune: None)
    app.meta.create_all(engine)
    app._buckets.clear()
    yield engine
    engine.dispose()

def payload(**kwargs):
    return {'id':str(uuid4()), 'seq':1, 'visible_ms':1000, 'src':'test', 'events':[{'event':'case_pulled','slug':SLUG,'at':500}], **kwargs}

def put(client, body, **headers):
    return client.post('/api/t', json=body, headers={'Origin':'https://ryanzegalia.com','User-Agent':UA, **headers})

def test_beacon_idempotent_capped_and_viewer(db):
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        body=payload(referrer='https://google.com/private?q=secret', utm_medium='email')
        assert put(c,body).status_code==204
        assert put(c,body).status_code==204
        with db.connect() as conn:
            v=conn.execute(select(app.visits)).mappings().one()
            assert v['ip']=='8.8.8.8' and v['referrer']=='https://google.com'
            assert len(conn.execute(select(app.events)).all())==1
        assert c.get('/traffic').status_code==404
        assert c.get('/traffic?k=é').status_code==404
        page=c.get('/traffic?k=local-test-token')
        assert page.status_code==200 and app.TITLES[SLUG] in page.text
        assert 'Tagged link' in page.text and 'email' in page.text
        assert page.headers['cache-control']=='no-store'
        assert put(c,{**body,'seq':2,'visible_ms':999999}).status_code==204
        with db.connect() as conn:
            assert conn.execute(select(app.visits.c.visible_ms)).scalar()<4000

def test_proxy_and_token_boundary(db):
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        put(c,payload(), **{'X-Forwarded-For':'192.0.2.9','X-Shelf-Client-IP':'192.0.2.9'})
        assert c.get('/traffic',headers={'Host':'traffic.example.test'}).status_code==404
    with db.connect() as conn:
        assert conn.execute(select(app.visits.c.ip)).scalar()=='8.8.8.8'
    with TestClient(app.app, client=('192.0.2.8',1)) as c:
        assert c.get('/traffic', headers={'Host':'traffic.example.test','X-Shelf-Client-IP':'192.0.2.25'}).status_code==200
        assert c.get('/traffic', headers={'Host':'traffic.example.test','X-Shelf-Client-IP':'8.8.8.8'}).status_code==404

def test_bad_payload_origin_limits_and_xss(db):
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        assert c.post('/api/t',json=payload()).status_code==204
        assert put(c,payload(id='not-a-uuid')).status_code==204
        assert put(c,payload(events=[{}]*41)).status_code==204
        assert c.post('/api/t',content='x'*25000,headers={'Origin':'https://ryanzegalia.com'}).status_code==413
        with db.connect() as conn:
            assert not conn.execute(select(app.visits)).all()
        put(c,payload(src='<script>alert(1)</script>'))
        assert '<script>alert(1)</script>' not in c.get('/traffic?k=local-test-token').text

def test_alert_visible_dwell_real_inserts_and_dedup(db, monkeypatch):
    monkeypatch.setattr(app.alerts,'DISPATCHER_KEY','test')
    monkeypatch.setattr(app.alerts,'ENABLED',True)
    send=Mock(return_value=True); monkeypatch.setattr(app.alerts,'send',send)
    body=payload(events=[{'event':'insert_opened','slug':slug} for slug in list(app.TITLES)[:2]])
    app.record(body,'8.8.8.8',UA)
    app.maybe_alert(body['id']); assert not send.called
    with db.begin() as conn:
        conn.execute(update(app.visits).values(visible_ms=16000))
    app.maybe_alert(body['id']); app.maybe_alert(body['id'])
    assert send.call_count==1
    with db.begin() as conn:
        conn.execute(app.ledger.delete()); conn.execute(update(app.visits).values(own=True))
    app.maybe_alert(body['id']); assert send.call_count==1

def test_bots_never_alert(db, monkeypatch):
    monkeypatch.setattr(app.alerts,'DISPATCHER_KEY','test')
    send=Mock(); monkeypatch.setattr(app.alerts,'send',send)
    body=payload(events=[{'event':'insert_opened','slug':s} for s in list(app.TITLES)[:2]])
    app.record(body,'8.8.8.8','HeadlessChrome')
    with db.begin() as conn: conn.execute(update(app.visits).values(visible_ms=60000))
    app.maybe_alert(body['id']); assert not send.called

def test_investigation_sources_and_scanners():
    assert arrival({'referrer':'https://mail.google.com'})=='Webmail · Gmail'
    assert arrival({'referrer':'https://jobs.lever.co'})=='ATS · Lever'
    assert arrival({'referrer':'https://evilgoogle.com'})=='evilgoogle.com'
    assert arrival({'utm_source':'linkedin','utm_medium':'profile'})=='Tagged link · linkedin / profile'
    a=dict(src='company',asn=8075,org='MICROSOFT',visible_ms=5000,ip='1.1.1.1',own=False,started=10)
    b={**a,'ip':'8.8.8.8','started':90}
    assert mail_candidate(a) and not mail_candidate({**a,'visible_ms':30000})
    burst=scanner_bursts([a,b])[0]
    assert len(burst['ips'])==2 and burst['count']==2
    assert app.netinfo.is_own(os.environ['HOME_IP']) and app.netinfo.is_own('192.0.2.150')

def test_retention_and_return_history(db):
    now=time.time()
    first=payload(); app.record(first,'8.8.8.8',UA)
    with db.begin() as conn:
        conn.execute(update(app.visits).values(started=now-86400*2,last_seen=now-86400*2))
    app.record(payload(),'8.8.8.8',UA)
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        assert 'Return · visit 2' in c.get('/traffic?k=local-test-token').text
    with db.begin() as conn:
        conn.execute(update(app.visits).values(last_seen=now-86400*366))
        conn.execute(update(app.events).values(received=now-86400*366))
    app.prune()
    with db.connect() as conn:
        assert not conn.execute(select(app.visits)).all()
        assert not conn.execute(select(app.events)).all()

def test_geo_fails_open_and_uses_local_reader(monkeypatch):
    reader=Mock(); reader.get.return_value={'city':{'names':{'en':'Test City'}},'country':{'names':{'en':'Test Country'}},'subdivisions':[{'names':{'en':'Region'}}]}
    monkeypatch.setattr(enrichment,'_reader',reader)
    assert enrichment.geo('8.8.8.8')['city']=='Test City'
    reader.get.side_effect=ValueError('unavailable')
    assert enrichment.geo('8.8.8.8')['city']==''

def test_out_of_order_and_duplicate_batches_keep_trail_once(db):
    body=payload(seq=2,events=[{'event':'page_viewed','slug':SLUG,'page':2}])
    app.record(body,'8.8.8.8',UA)
    late={**body,'seq':1,'events':[{'event':'case_pulled','slug':SLUG}]}
    app.record(late,'8.8.8.8',UA); app.record(late,'8.8.8.8',UA)
    with db.connect() as conn:
        assert conn.execute(select(app.visits.c.seq)).scalar()==2
        assert len(conn.execute(select(app.events)).all())==2
    # A forged identifier from a different IP cannot append to this visit.
    app.record({**body,'seq':3},'1.1.1.1',UA)
    with db.connect() as conn: assert len(conn.execute(select(app.events)).all())==2

def test_geo_refresh_failure_retains_previous_reader(tmp_path, monkeypatch):
    monkeypatch.setattr(enrichment,'DATA',tmp_path)
    reader=Mock(); reader.get.return_value={'city':{'names':{'en':'Previous City'}}}
    monkeypatch.setattr(enrichment,'_reader',reader)
    monkeypatch.setattr(enrichment,'_month','')
    monkeypatch.setattr(enrichment.netinfo,'OFFLINE',False)
    monkeypatch.setattr(enrichment.httpx,'stream',Mock(side_effect=RuntimeError('offline')))
    enrichment.refresh_geo()
    assert enrichment.geo('8.8.8.8')['city']=='Previous City'
    reader.close.assert_not_called()

def test_legacy_events_readable_without_modification(db):
    from sqlalchemy import text
    with db.begin() as conn:
        conn.execute(text('CREATE TABLE page_events (id TEXT PRIMARY KEY, occurred_at TEXT, path TEXT, hash_route TEXT, referrer TEXT, src TEXT, user_agent TEXT, net_org TEXT, net_own BOOLEAN)'))
        conn.execute(text('INSERT INTO page_events VALUES (:id,:time,:path,NULL,NULL,:src,:ua,:org,0)'),dict(id='old-1',time='2026-08-10',path='/old-case',src='old-company',ua=UA,org='Old network'))
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        page=c.get('/traffic?k=local-test-token&legacy=1')
        assert page.status_code==200 and '/old-case' in page.text and 'old-company' in page.text
    with db.connect() as conn:
        assert conn.execute(text('SELECT COUNT(*) FROM page_events')).scalar()==1

def test_viewer_orders_late_batches_by_visible_event_time(db):
    body=payload(seq=2,events=[{'event':'page_viewed','slug':SLUG,'page':2,'at':900}])
    app.record(body,'8.8.8.8',UA)
    app.record({**body,'seq':1,'events':[{'event':'case_pulled','slug':SLUG,'at':100}]},'8.8.8.8',UA)
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        page=c.get('/traffic?k=local-test-token').text
        assert page.index('case pulled') < page.index('page viewed')

def test_graphics_bounded_and_flagged_in_viewer(db):
    body=payload(events=[{'event':'gfx','gfx':{'gpu':'Test GPU <script>', 'frames':0, 'triangles':0, 'lost':1, 'shaderErrors':['Shader failed'], 'secret':'must not persist', 'extensions':{'unknown':True}}}])
    for seq in range(1,6): app.record({**body,'seq':seq},'8.8.8.8',UA)
    with db.connect() as conn:
        rows=conn.execute(select(app.graphics)).mappings().all()
        assert len(rows)==3 and all('secret' not in r['data'] and 'must not persist' not in r['data'] for r in rows)
    with TestClient(app.app, client=('8.8.8.8',1)) as c:
        page=c.get('/traffic?k=local-test-token').text
        assert 'GRAPHICS ISSUE' in page and 'GPU context lost' in page and 'Shader error' in page and 'Zero triangles' in page
        assert 'Test GPU &lt;script&gt;' in page and 'Test GPU <script>' not in page
        assert 'US Eastern' in page

def test_graphics_flags_and_eastern_dst():
    from graphics import clean_report, summarize
    from investigation import eastern_time
    assert summarize([{'gpu':'Fine','frames':100,'triangles':200}])['flags']==[]
    assert 'No frames after 5 seconds' in summarize([{'frames':0,'triangles':0}])['flags']
    # UTC is retained in storage; display accounts for winter/summer offsets.
    assert eastern_time('2026-10-30T13:53:00+00:00')=='Oct 30 9:53 AM ET'
    assert eastern_time('2026-12-30T14:53:00+00:00')=='Dec 30 9:53 AM ET'
    assert 'frames' not in clean_report({'frames':float('nan')})
    assert len(clean_report({'errors':['x'*900]*20})['errors'])==6
