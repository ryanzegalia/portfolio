"""Offline ASN lookup and home-traffic detection, ported from the old portfolio.

The iptoasn IPv4/IPv6 tables (PDDL v1.0) are downloaded on a background thread and refreshed weekly. Lookups are an in-memory binary search; missing tables yield unknown, never a request-time download.

The Shelf service stores raw IP separately in shelf_visits with its documented 365-day retention. This module returns only ASN/owner and an own-traffic flag. LAN and the known home IPv4 are own traffic; the background echo adds the current home WAN address. Explicit IPv6 addresses retain the old /56 home-prefix behavior.
"""

from __future__ import annotations

import bisect
import gzip
import io
import ipaddress
import logging
import os
import socket
import threading
from array import array
from dataclasses import dataclass
from datetime import datetime

import httpx

logger = logging.getLogger(__name__)

TABLE_URLS = {
    4: "https://iptoasn.com/data/ip2asn-v4.tsv.gz",
    6: "https://iptoasn.com/data/ip2asn-v6.tsv.gz",
}
# Plain-text "what is my IP" echoes, tried in order.
ECHO_URLS = (
    "https://api.ipify.org",
    "https://icanhazip.com",
    "https://ifconfig.me/ip",
)
# Set in tests so a TestClient lifespan never reaches the internet.
OFFLINE = os.environ.get("NETINFO_OFFLINE", "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Net:
    asn: int
    org: str


class _Keys:
    """Fixed-width big-endian records viewed as a sequence, so `bisect` can
    search a bytes blob directly. Byte order equals numeric order at a fixed
    width, which keeps 180k IPv6 ranges at 16 bytes each instead of a list of
    Python ints several times that size."""

    __slots__ = ("buf", "width")

    def __init__(self, buf: bytes, width: int):
        self.buf = buf
        self.width = width

    def __len__(self) -> int:
        return len(self.buf) // self.width

    def __getitem__(self, i: int) -> bytes:
        w = self.width
        return self.buf[i * w:(i + 1) * w]


class AsnTable:
    """Sorted, non-overlapping address ranges for one IP version, held as
    packed network-order addresses (what socket.inet_pton returns)."""

    def __init__(self, version: int):
        self.version = version
        self.width = 4 if version == 4 else 16
        self._starts = bytearray()
        self._ends = bytearray()
        self._asns = array("I")
        self._last_end = b""

    def add(self, start: bytes, end: bytes, asn: int) -> bool:
        """Append one range. Ranges must arrive in ascending order; a range
        that overlaps the previous one is dropped rather than trusted."""
        if start <= self._last_end or end < start:
            return False
        self._starts += start
        self._ends += end
        self._asns.append(asn)
        self._last_end = end
        return True

    def __len__(self) -> int:
        return len(self._asns)

    def find(self, packed: bytes) -> int | None:
        """ASN of the range holding a packed address. Call freeze() first."""
        i = bisect.bisect_right(self._keys, packed) - 1
        if i < 0:
            return None
        if packed > self._ends[i * self.width:(i + 1) * self.width]:
            return None
        return self._asns[i]

    def freeze(self) -> "AsnTable":
        self._starts = bytes(self._starts)
        self._ends = bytes(self._ends)
        self._keys = _Keys(self._starts, self.width)
        return self


def parse_table(lines, version: int) -> tuple[AsnTable, dict[int, str]]:
    """Parse ip2asn TSV lines: range_start, range_end, AS_number, country,
    AS_description. ASN 0 means "not routed" and is skipped."""
    family = socket.AF_INET if version == 4 else socket.AF_INET6
    table = AsnTable(version)
    names: dict[int, str] = {}
    dropped = 0
    for line in lines:
        parts = line.rstrip("\r\n").split("\t")
        if len(parts) < 5:
            continue
        try:
            asn = int(parts[2])
            if asn == 0:
                continue
            start = socket.inet_pton(family, parts[0])
            end = socket.inet_pton(family, parts[1])
        except (ValueError, OSError):
            continue
        if table.add(start, end, asn):
            if asn not in names:
                names[asn] = parts[4].strip()
        else:
            dropped += 1
    if dropped:
        logger.warning("netinfo: dropped %d out-of-order IPv%d ranges", dropped, version)
    return table.freeze(), names


# ---------------------------------------------------------------------------
# Process-wide state, swapped whole so a lookup never sees a half-built table.
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_tables: dict[int, AsnTable] = {}
_names: dict[int, str] = {}
_own_ips: frozenset[str] = frozenset()
_own_v6_nets: tuple = ()


def install(tables: dict[int, AsnTable], names: dict[int, str]) -> None:
    global _tables, _names
    with _lock:
        _tables, _names = tables, names


def set_own_ips(ips) -> None:
    """Record this server's public address(es). IPv6 matches on the /56 a
    home connection is delegated, because every device behind it picks its
    own address inside that prefix."""
    global _own_ips, _own_v6_nets
    v4, v6 = set(), []
    for ip in ips:
        try:
            addr = ipaddress.ip_address(ip.strip())
        except ValueError:
            continue
        if addr.version == 4:
            v4.add(str(addr))
        else:
            v6.append(ipaddress.ip_network(f"{addr}/56", strict=False))
    with _lock:
        _own_ips, _own_v6_nets = frozenset(v4), tuple(v6)


def lookup(ip: str | None) -> Net | None:
    """ASN and registered name for an address, or None when unknown."""
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return None
    if not addr.is_global:
        return None
    table = _tables.get(addr.version)
    if table is None:
        return None
    asn = table.find(addr.packed)
    if asn is None:
        return None
    return Net(asn=asn, org=_names.get(asn, ""))


def is_own(ip: str | None) -> bool:
    """True when the request came from the LAN or from this server's own
    public address, i.e. the site owner at home."""
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return False
    if addr.is_private or addr.is_loopback or addr.is_link_local:
        return True
    if addr.version == 4:
        return str(addr) in _own_ips or str(addr) == os.environ.get("HOME_IP")
    return any(addr in net for net in _own_v6_nets)


def ready() -> bool:
    return bool(_tables)


# ---------------------------------------------------------------------------
# Refresh jobs
# ---------------------------------------------------------------------------
def refresh_tables(timeout: float = 60.0) -> bool:
    """Download both tables and swap them in. Keeps the old ones on failure."""
    if OFFLINE:
        return False
    tables: dict[int, AsnTable] = {}
    names: dict[int, str] = {}
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            for version, url in TABLE_URLS.items():
                resp = client.get(url)
                resp.raise_for_status()
                with gzip.open(io.BytesIO(resp.content), "rt", encoding="utf-8",
                               errors="replace") as fh:
                    table, table_names = parse_table(fh, version)
                tables[version] = table
                names.update(table_names)
    except Exception as exc:
        logger.warning("netinfo: table refresh failed, keeping previous: %s", exc)
        return False
    install(tables, names)
    logger.info(
        "netinfo: loaded %d IPv4 + %d IPv6 ranges, %d networks",
        len(tables.get(4, ())), len(tables.get(6, ())), len(names),
    )
    return True


def refresh_own_ip(timeout: float = 10.0) -> bool:
    """Learn this server's public IPv4 from the first echo that answers."""
    if OFFLINE:
        return False
    for url in ECHO_URLS:
        try:
            resp = httpx.get(url, timeout=timeout)
            resp.raise_for_status()
            ip = resp.text.strip()
            ipaddress.ip_address(ip)
        except Exception:
            continue
        set_own_ips([ip])
        return True
    logger.warning("netinfo: no echo service answered; own-traffic check is LAN-only")
    return False


def schedule(scheduler) -> None:
    """Weekly table refresh and a 30-minute own-IP check, both run once
    immediately. They run on the scheduler's worker threads, so startup
    never waits on a download."""
    now = datetime.now()
    scheduler.add_job(refresh_tables, "interval", days=7, next_run_time=now,
                      id="netinfo_tables", replace_existing=True)
    scheduler.add_job(refresh_own_ip, "interval", minutes=30, next_run_time=now,
                      id="netinfo_own_ip", replace_existing=True)
