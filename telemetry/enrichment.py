"""Local geo/ASN reads only. Downloads and maintenance live on a worker thread."""
import gzip
import logging
import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

import httpx
import maxminddb
import netinfo

log = logging.getLogger(__name__)
DATA = Path(os.getenv('DATA_DIR', '/data'))
_reader = None
_lock = threading.Lock()
_month = ''


def geo(ip):
    try:
        with _lock:
            record = _reader.get(ip) if _reader else {}
        record = record or {}
        subdivisions = record.get('subdivisions') or [{}]
        return dict(country=record.get('country', {}).get('names', {}).get('en', ''),
                    region=subdivisions[0].get('names', {}).get('en', ''),
                    city=record.get('city', {}).get('names', {}).get('en', ''))
    except Exception:
        return dict(country='', region='', city='')


def refresh_geo():
    global _reader, _month
    DATA.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).strftime('%Y-%m')
    path = DATA / 'city.mmdb'
    # Load the last good database even when offline or a refresh fails.
    if _reader is None and path.exists():
        with _lock:
            _reader = maxminddb.open_database(str(path))
    if netinfo.OFFLINE or _month == now:
        return
    stamp = DATA / 'city.month'
    if path.exists() and stamp.exists() and stamp.read_text() == now:
        _month = now
        return
    compressed = DATA / 'city.download.gz'
    pending = DATA / 'city.pending.mmdb'
    try:
        with httpx.stream('GET', f'https://download.db-ip.com/free/dbip-city-lite-{now}.mmdb.gz', timeout=120, follow_redirects=True) as response:
            response.raise_for_status()
            size = 0
            with compressed.open('wb') as out:
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 150_000_000:
                        raise ValueError('Geo download too large')
                    out.write(chunk)
        with gzip.open(compressed, 'rb') as src, pending.open('wb') as out:
            shutil.copyfileobj(src, out)
        with maxminddb.open_database(str(pending)) as test:
            test.metadata()
        pending.replace(path)
        reader = maxminddb.open_database(str(path))
        with _lock:
            old, _reader = _reader, reader
            if old:
                old.close()
        stamp.write_text(now)
        _month = now
    except Exception:
        log.warning('Geo refresh failed; keeping last good city database')
    finally:
        compressed.unlink(missing_ok=True)
        pending.unlink(missing_ok=True)


def maintenance(stop, prune):
    n = 0
    while not stop.is_set():
        try:
            ips = os.getenv('OWN_IPS', '')
            if ips:
                netinfo.set_own_ips(ips.split(','))
            else:
                netinfo.refresh_own_ip()
            if n % 48 == 0:
                prune()
                refresh_geo()
            if n % 336 == 0:
                netinfo.refresh_tables()
        except Exception:
            log.exception('Background maintenance failed; beacon remains available')
        n += 1
        stop.wait(1800)
