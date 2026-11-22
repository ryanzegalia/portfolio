"""Conservative evidence labels, never a claimed person's identity."""
from datetime import datetime, timezone
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")

def eastern_time(value):
    if isinstance(value, (int, float)):
        value = datetime.fromtimestamp(value, timezone.utc)
    elif isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(EASTERN).strftime("%b %d %-I:%M %p ET")

from traffic import classify_user_agent

REFERRERS = {
    'linkedin.com': 'LinkedIn', 'google.com': 'Google search', 'bing.com': 'Bing search',
    'indeed.com': 'Indeed', 'greenhouse.io': 'ATS · Greenhouse', 'lever.co': 'ATS · Lever',
    'myworkdayjobs.com': 'ATS · Workday', 'workday.com': 'ATS · Workday', 'ashbyhq.com': 'ATS · Ashby',
    'icims.com': 'ATS · iCIMS', 'mail.google.com': 'Webmail · Gmail', 'outlook.live.com': 'Webmail · Outlook',
    'outlook.office.com': 'Webmail · Outlook', 'outlook.office365.com': 'Webmail · Outlook',
    'slack.com': 'Slack', 'teams.live.com': 'Teams', 'teams.microsoft.com': 'Teams', 'discord.com': 'Discord', 'github.com': 'GitHub',
}
CLOUD_ASNS = {8075, 16509, 14618, 15169, 396982, 19527}


def arrival(v):
    tag = v.get('src', '')
    utm = ' / '.join(v[k] for k in ('utm_source', 'utm_medium', 'utm_campaign') if v.get(k))
    if tag or utm:
        return 'Tagged link · ' + (tag or utm) + (f' ({utm})' if tag and utm else '')
    try:
        host = (urlsplit(v.get('referrer') or '').hostname or '').lower()
    except ValueError:
        host = ''
    for domain in sorted(REFERRERS, key=len, reverse=True):
        if host == domain or host.endswith('.' + domain):
            return REFERRERS[domain]
    return host or 'Direct / unknown'


def mail_candidate(v):
    # ASN is evidence of a hosting network, NOT proof of a scanner. Label it suspected.
    # No application-send timestamp exists here: never invent timing relative to applications.
    cloud = v.get('asn') in CLOUD_ASNS or any(x in (v.get('org') or '').upper() for x in ('AMAZON', 'MICROSOFT', 'GOOGLE-CLOUD'))
    return bool(cloud and v.get('src') and v.get('visible_ms', 0) < 15000)


def scanner_bursts(rows):
    """Group same source/network arrivals in fixed two-minute windows; no IP-merging of people."""
    groups = []
    for v in sorted((v for v in rows if mail_candidate(v) and not v['own']), key=lambda v: v['started']):
        group = next((g for g in reversed(groups) if g['src'] == v['src'] and g['asn'] == v['asn'] and v['started'] - g['start'] <= 120), None)
        if group is None:
            group = dict(src=v['src'], asn=v['asn'], org=v['org'], start=v['started'], end=v['started'], ips=set(), count=0)
            groups.append(group)
        group['ips'].add(v['ip']); group['count'] += 1; group['end'] = v['started']
    for g in groups:
        g['when'] = eastern_time(g['start'])
    return list(reversed(groups))


# --- Seen before: same device / same address, worded as evidence, never as a named person ---------

_DEVICE_WORDS = {('iOS', 'mobile'): 'iPhone', ('iOS', 'tablet'): 'iPad', ('macOS', 'desktop'): 'Mac',
                 ('Android', 'mobile'): 'Android phone', ('Android', 'tablet'): 'Android tablet',
                 ('Windows', 'desktop'): 'Windows PC', ('Linux', 'desktop'): 'Linux PC', ('ChromeOS', 'desktop'): 'Chromebook'}


def device_word(v):
    c = classify_user_agent(v.get('ua'))
    os_name = c.label.split(' on ', 1)[1] if ' on ' in c.label else ''
    return _DEVICE_WORDS.get((os_name, c.device), 'device')


def _same_device(a, b, gpu_a, gpu_b):
    """Same screen size, same browser and OS, and no conflicting graphics chip."""
    ca, cb = classify_user_agent(a.get('ua')), classify_user_agent(b.get('ua'))
    if not a.get('screen') or a.get('screen') != b.get('screen') or ca.label != cb.label or ca.device != cb.device:
        return False
    return not (gpu_a and gpu_b and gpu_a != gpu_b)


def _distinctive(gpu):
    # Every iPhone and Mac reports "Apple GPU" and iPhones share a handful of screen sizes,
    # so an Apple match across two addresses says nothing. Android/PC chips narrow it a lot.
    return bool(gpu) and not gpu.startswith('Apple')


def _when_list(rows):
    rows = sorted(rows, key=lambda p: p['started'])
    first = eastern_time(rows[0]['started']).replace(' ET', '')
    if len(rows) == 1:
        return first
    return f"{len(rows)} visits, first {first}, last {eastern_time(rows[-1]['started']).replace(' ET', '')}"


def seen_before(v, others, gpu_of):
    """Plain lines saying where this visit matches earlier ones.

    others  -- candidate earlier visits (dicts with id, ip, started, screen, ua, org)
    gpu_of  -- visit id -> graphics chip string ('' when the visit sent no report)
    Same address + same device is strong; same address + other device is a household or office;
    same distinctive device from another address is only 'possibly' the same device.
    """
    gpu = gpu_of.get(v['id'], '')
    word = device_word(v)
    both, other_device, elsewhere = [], {}, []
    for p in others:
        if p['id'] == v['id'] or p['started'] >= v['started']:
            continue
        pgpu = gpu_of.get(p['id'], '')
        same = _same_device(v, p, gpu, pgpu)
        if p['ip'] == v['ip']:
            (both.append(p) if same else other_device.setdefault(device_word(p), []).append(p))
        elif same and _distinctive(gpu) and gpu == pgpu:
            elsewhere.append(p)
    lines = []
    if both:
        lines.append(f"Same {word}, same address seen before: {_when_list(both)}")
    for other_word, rows in sorted(other_device.items()):
        lines.append(f"Same address, another device or browser ({other_word}): {_when_list(rows)}")
    if elsewhere:
        nets = sorted({(p.get('org') or 'unknown network').split(' - ')[-1][:40] for p in elsewhere})
        lines.append(f"Possibly the same {word} from another address ({', '.join(nets)}): {_when_list(elsewhere)}")
    return lines
