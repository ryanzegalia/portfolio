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
