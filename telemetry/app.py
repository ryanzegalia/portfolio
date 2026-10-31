"""Standalone Shelf telemetry. Only /api/t is public; never trusts arbitrary XFF."""
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, Response
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import create_engine, MetaData, Table, Column, String, Integer, Boolean, Float, Text, select, insert, update, delete, inspect
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool
import alerts
import enrichment
import netinfo
from investigation import arrival, mail_candidate, scanner_bursts, eastern_time, EASTERN
from graphics import clean_report, summarize
from traffic import classify_user_agent

log = logging.getLogger(__name__)
BASE = Path(__file__).resolve().parent
TITLES = json.loads((BASE / 'cases.json').read_text())
ENV = Environment(loader=FileSystemLoader(BASE), autoescape=select_autoescape(['html']))
URL = os.getenv('DATABASE_URL', 'sqlite:///./telemetry.sqlite')
if URL.startswith('postgresql://'):
    URL = URL.replace('postgresql://', 'postgresql+psycopg://', 1)
engine = create_engine(URL, **({'connect_args': {'check_same_thread': False}} if URL.startswith('sqlite') else {'pool_pre_ping': True, 'pool_size': 4, 'max_overflow': 2, 'connect_args': {'connect_timeout': 5, 'options': '-c statement_timeout=5000'}}))
meta = MetaData()
visits = Table('shelf_visits', meta,
    Column('id', String(36), primary_key=True), Column('started', Float, index=True), Column('last_seen', Float),
    Column('ip', String(45)), Column('ua', String(500)), Column('src', String(120)), Column('referrer', String(250)),
    Column('utm_source', String(120)), Column('utm_medium', String(120)), Column('utm_campaign', String(120)),
    Column('screen', String(30)), Column('visible_ms', Integer), Column('seq', Integer),
    Column('asn', Integer), Column('org', String(250)), Column('own', Boolean),
    Column('country', String(100)), Column('region', String(100)), Column('city', String(100)))
events = Table('shelf_events', meta,
    Column('id', String(80), primary_key=True), Column('visit', String(36), index=True),
    Column('received', Float), Column('event', String(40)), Column('slug', String(100)),
    Column('page', Integer), Column('pages', Integer), Column('aisle', String(100)), Column('at', Integer))
graphics = Table('shelf_graphics', meta, Column('id', String(80), primary_key=True), Column('visit', String(36), index=True), Column('received', Float), Column('data', Text))
ledger = Table('shelf_alerts', meta, Column('id', String(64), primary_key=True), Column('created', Float), Column('sent', Boolean))
ALLOWED_EVENTS = {'gfx', 'landing', 'shelf_viewed', 'case_pulled', 'insert_opened', 'page_viewed', 'case_turned', 'next', 'previous', 'staff_picks', 'store_directory', 'contact_opened', 'email_clicked', 'github_clicked', 'linkedin_clicked', 'read_as_text'}
PROXIES = [ipaddress.ip_network(x.strip()) for x in os.getenv('TRUSTED_PROXIES', '').split(',') if x.strip()]
ORIGINS = set(os.getenv('ALLOWED_ORIGINS', 'https://ryanzegalia.com,https://www.ryanzegalia.com').split(','))
TOKEN = os.getenv('TRAFFIC_TOKEN', '')
_buckets = OrderedDict()
_rate_lock = threading.Lock()
_db_lock = threading.Lock()  # One worker, serialized short writes; not held during enrichment/downloads.


def client_ip(request):
    peer = request.client.host if request.client else ''
    try:
        addr = ipaddress.ip_address(peer)
        if any(addr in net for net in PROXIES):
            # Caddy overwrites this field with its direct socket peer, not user XFF.
            peer = str(ipaddress.ip_address(request.headers.get('x-shelf-client-ip', '')))
        return str(ipaddress.ip_address(peer))
    except ValueError:
        return ''


def allowed(ip):
    with _rate_lock:
        now = time.monotonic()
        count, start = _buckets.pop(ip, (0, now))
        if now - start > 60:
            count, start = 0, now
        _buckets[ip] = (count + 1, start)
        while len(_buckets) > 4096:
            _buckets.popitem(last=False)
        return count < 120


def prune():
    cutoff = time.time() - int(os.getenv('RETENTION_DAYS', '365')) * 86400
    with _db_lock, engine.begin() as db:
        db.execute(delete(events).where(events.c.received < cutoff))
        db.execute(delete(graphics).where(graphics.c.received < cutoff))
        db.execute(delete(visits).where(visits.c.last_seen < cutoff))
        db.execute(delete(ledger).where(ledger.c.created < time.time() - 3 * 86400))


@asynccontextmanager
async def lifespan(app):
    meta.create_all(engine)
    stop = threading.Event()
    thread = threading.Thread(target=enrichment.maintenance, args=(stop, prune), daemon=True)
    thread.start()
    yield
    stop.set()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def privacy_headers(request, call_next):
    response = await call_next(request)
    response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"})
    return response


def clip(v, length):
    return v[:length] if isinstance(v, str) else ''


def number(v, maximum):
    return max(0, min(v, maximum)) if isinstance(v, int) and not isinstance(v, bool) else 0


def record(body, ip, ua):
    try:
        ident = str(UUID(body.get('id', '')))
    except (ValueError, TypeError, AttributeError):
        return None
    seq = number(body.get('seq'), 2_000_000_000)
    if not seq or not isinstance(body.get('events'), list) or len(body['events']) > 40:
        return None
    now = time.time()
    net = netinfo.lookup(ip)
    geo = enrichment.geo(ip)
    src = clip(body.get('src'), 120)
    ref = clip(body.get('referrer'), 250)
    try:
        parsed = urlsplit(ref)
        ref = f'{parsed.scheme}://{parsed.hostname}' if parsed.scheme in ('http', 'https') and parsed.hostname else ''
    except ValueError:
        ref = ''
    with _db_lock, engine.begin() as db:
        old = db.execute(select(visits).where(visits.c.id == ident)).mappings().first()
        if old and old['ip'] != ip:
            return None
        # Visible cumulative time is capped by server wall time (+2s scheduling tolerance).
        duration = number(body.get('visible_ms'), 604800000)
        duration = min(duration, int((now - old['started']) * 1000 + 2000)) if old else min(duration, 2000)
        if old:
            db.execute(update(visits).where(visits.c.id == ident).values(last_seen=now, seq=max(seq, old['seq']), visible_ms=max(old['visible_ms'], duration), own=netinfo.is_own(ip), **({'asn': net.asn, 'org': net.org} if net else {}), **{k:v for k,v in geo.items() if v}))
        else:
            db.execute(insert(visits).values(id=ident, started=now - duration / 1000, last_seen=now, ip=ip, ua=ua, src=src, referrer=ref, **{k:clip(body.get(k),120) for k in ('utm_source','utm_medium','utm_campaign')}, screen=clip(body.get('screen'), 30), seq=seq, visible_ms=duration, asn=net.asn if net else None, org=net.org if net else '', own=netinfo.is_own(ip), **geo))
        for i, e in enumerate(body['events']):
            if not isinstance(e, dict) or e.get('event') not in ALLOWED_EVENTS:
                continue
            snapshot = clean_report(e.get('gfx')) if e['event'] == 'gfx' else {}
            if e['event'] == 'gfx' and not snapshot:
                continue
            slug = clip(e.get('slug'), 100)
            event_id = f'{ident}:{seq}:{i}'
            if db.execute(select(events.c.id).where(events.c.id == event_id)).first():
                continue
            if snapshot:
                count = len(db.execute(select(graphics.c.id).where(graphics.c.visit == ident).limit(3)).all())
                if count >= 3:
                    continue
                db.execute(insert(graphics).values(id=event_id, visit=ident, received=now, data=json.dumps(snapshot)))
            db.execute(insert(events).values(id=event_id, visit=ident, received=now, event=e['event'], slug=slug if slug in TITLES else '', page=number(e.get('page'), 1000), pages=number(e.get('pages'), 1000), aisle=clip(e.get('aisle'), 100), at=min(number(e.get('at'), 604800000), duration)))
    return ident


def maybe_alert(ident):
    if not alerts.ENABLED or not alerts.DISPATCHER_KEY or not TOKEN:
        return
    try:
        with engine.connect() as db:
            v = db.execute(select(visits).where(visits.c.id == ident)).mappings().first()
            trail = db.execute(select(events).where(events.c.visit == ident)).mappings().all()
        if not v or not v['src'] or v['own'] or mail_candidate(v) or classify_user_agent(v['ua']).kind != 'human':
            return
        opened = {e['slug'] for e in trail if e['event'] in ('insert_opened', 'read_as_text') and e['slug']}
        if v['visible_ms'] < alerts.MIN_DWELL_SEC * 1000 or len(opened) < alerts.MIN_EVENTS:
            return
        day = datetime.now(timezone.utc).date().isoformat()
        key = hmac.new(TOKEN.encode(), f"{day}|{v['ip']}|{v['ua']}|{v['src']}".encode(), hashlib.sha256).hexdigest()
        try:
            with engine.begin() as db:
                db.execute(insert(ledger).values(id=key, created=time.time(), sent=False))
        except IntegrityError:
            return  # Unique DB key, not an in-memory set: safe across restart/concurrency.
        decision = alerts.Decision(True, 'engaged reader', 'A reader opened your application link',
            'A likely person read at least two Shelf inserts; network ownership is not proof of employer.',
            {'Application': v['src'], 'Visible time': f"{v['visible_ms']//1000}s", 'Cases': ', '.join(TITLES[s] for s in sorted(opened))[:900], 'Network': v['org'] or 'Unknown'})
        sent = alerts.send(decision)
        with engine.begin() as db:
            if sent:
                db.execute(update(ledger).where(ledger.c.id == key).values(sent=True))
            else:
                db.execute(delete(ledger).where(ledger.c.id == key))  # retry on next heartbeat
    except Exception:
        log.exception('Alert failed, beacon unaffected')


@app.post('/api/t')
async def beacon(request: Request, background: BackgroundTasks):
    ip = client_ip(request)
    if not ip or request.headers.get('origin', '') not in ORIGINS or not allowed(ip):
        return Response(status_code=204)
    raw = bytearray()
    async for part in request.stream():
        raw.extend(part)
        if len(raw) > 24576:
            return Response(status_code=413)
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            return Response(status_code=204)
        ident = await run_in_threadpool(record, body, ip, clip(request.headers.get('user-agent'), 500))
        if ident:
            background.add_task(maybe_alert, ident)
    except (ValueError, TypeError):
        pass
    except Exception:
        log.error('Beacon storage unavailable (details suppressed to protect visitor data)')
        return Response(status_code=503)  # client circuit-breaks, site stays functional
    return Response(status_code=204)


@app.get('/health')
def health():
    with engine.connect() as db:
        db.execute(select(visits.c.id).limit(1)).first()
    return {'ok': True, 'asn_ready': netinfo.ready(), 'geo_ready': enrichment._reader is not None}


def authorized(request, token):
    ip = client_ip(request)
    lan = False
    try:
        addr = ipaddress.ip_address(ip)
        lan = addr.is_private and not addr.is_unspecified
    except ValueError:
        pass
    # Host alone is NOT authorization. Requires real LAN client from pinned proxy.
    return (bool(os.getenv('TRAFFIC_LAN_HOST')) and request.url.hostname == os.getenv('TRAFFIC_LAN_HOST') and lan) or bool(TOKEN and hmac.compare_digest(token.encode(), TOKEN.encode()))


@app.get('/traffic', response_class=HTMLResponse)
def viewer(request: Request, k: str = '', bots: int = 0, own: int = 0, days: int = 14, legacy: int = 0):
    if not authorized(request, k):
        raise HTTPException(404)
    days = max(1, min(days, 365))
    since = time.time() - days * 86400
    with engine.connect() as db:
        rows = db.execute(select(visits).where(visits.c.last_seen >= since).order_by(visits.c.started.desc()).limit(2000)).mappings().all()
        candidates = [dict(v) for v in rows if own or not v['own']]
        bursts = scanner_bursts(candidates) if bots else []
        rows = [v for v in candidates if not mail_candidate(v) and (bots or classify_user_agent(v['ua']).kind == 'human')]
        history = db.execute(select(visits.c.id, visits.c.ip, visits.c.started).where(visits.c.ip.in_([v['ip'] for v in rows])).order_by(visits.c.started)).mappings().all() if rows else []
        trail = db.execute(select(events).where(events.c.visit.in_([v['id'] for v in rows])).order_by(events.c.at, events.c.received, events.c.id)).mappings().all() if rows else []
        gfx_rows = db.execute(select(graphics).where(graphics.c.visit.in_([v['id'] for v in rows])).order_by(graphics.c.received)).mappings().all() if rows else []
        historical = []
        if legacy and inspect(engine).has_table('page_events'):
            old = Table('page_events', MetaData(), autoload_with=engine)
            historical = [dict(v) for v in db.execute(select(old).order_by(old.c.occurred_at.desc()).limit(600)).mappings() if (bots or classify_user_agent(v['user_agent']).kind == 'human') and (own or not v.get('net_own'))]
    grouped = {}
    summary = {}
    for e in trail:
        item = dict(e)
        item['title'] = TITLES.get(e['slug'], '')
        grouped.setdefault(e['visit'], []).append(item)
        if not e['slug']:
            continue
        s = summary.setdefault(e['slug'], {'title': item['title'], 'opens': set(), 'readers': set(), 'page': 0, 'pages': 0})
        if e['event'] == 'case_pulled': s['opens'].add(e['visit'])
        if e['event'] in ('insert_opened', 'read_as_text'): s['readers'].add(e['visit'])
        s['page'] = max(s['page'], e['page'] or 0)
        s['pages'] = max(s['pages'], e['pages'] or 0)
    gfx_by_visit = {}
    for row in gfx_rows:
        gfx_by_visit.setdefault(row['visit'], []).append(json.loads(row['data']))
    for old in historical:
        old['occurred_at'] = eastern_time(old['occurred_at'])
    history_by_ip = {}
    for past in history:
        history_by_ip.setdefault(past['ip'], []).append(past)
    links = {}
    for v in candidates:
        tag = v['src'] or v.get('utm_campaign')
        if tag:
            item = links.setdefault(tag, {'tag':tag, 'visits':0, 'human':0, 'scanner':0})
            item['visits'] += 1
            item['scanner'] += int(mail_candidate(v))
            item['human'] += int(not mail_candidate(v) and classify_user_agent(v['ua']).kind == 'human')
    for v in rows:
        past = history_by_ip.get(v['ip'], [])
        v['return_number'] = next((i+1 for i,p in enumerate(past) if p['id'] == v['id']), 1)
        v['first_seen'] = datetime.fromtimestamp(past[0]['started'], EASTERN).strftime('%b %d') if past else ''
        v['returning'] = bool(past and datetime.fromtimestamp(past[0]['started'], EASTERN).date() < datetime.fromtimestamp(v['started'], EASTERN).date())
        v['arrival'] = arrival(v)
        v['client'] = classify_user_agent(v['ua'])
        v['when'] = eastern_time(v['started'])
        v['graphics'] = summarize(gfx_by_visit.get(v['id'], []))
        v['trail'] = grouped.get(v['id'], [])
    summaries = sorted(summary.values(), key=lambda x: len(x['opens']), reverse=True)
    return ENV.get_template('traffic.html').render(rows=rows, summaries=summaries, historical=historical, k=k, bots=bots, own=own, days=days, legacy=legacy, bursts=bursts, links=list(links.values()))
