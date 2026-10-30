#!/usr/bin/env python3
"""Classify the visitor IPs of the nginx access logs and write a self-contained visitors.html.

Python 3 standard library plus (optional) python3-maxminddb for the country lookup. Without the module or
the mmdb file every country shows as "??" and the page still works. Everything taken from the logs is
attacker-controlled (UA, paths, origin), so every such string goes through html.escape().

Usage: visitors.py [--log-dir /var/log/nginx] [--out visitors.html] [--mmdb PATH] [--generated TEXT]
See deploy/README.md "Traffic stats".
"""
from __future__ import annotations

import argparse
import glob
import gzip
import html
import os
import re
import sys
from collections import Counter

SITES = ("daisychess.org", "play.daisychess.org", "hub.daisychess.org")
DEFAULT_MMDB = "/var/lib/daisychess-stats/dbip-country-lite.mmdb"
APP_ORIGINS = ("capacitor://app.daisychess.org", "https://app.daisychess.org")
MAX_ROWS = 3000
MONTHS = {m: i for i, m in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}

LINE_RE = re.compile(
    r'^(?P<ip>\S+) \[(?P<time>[^\]]+)\] "(?P<method>\S+) (?P<path>.*) (?P<proto>\S+)" '
    r'(?P<status>\d{3}) (?P<bytes>\d+|-) rt=\S+ urt=.*? origin="(?P<origin>.*?)" ua="(?P<ua>.*)"$')
TIME_RE = re.compile(r'^(\d\d)/(\w{3})/(\d{4}):(\d\d):(\d\d)')

KNOWN_BOT_RE = re.compile(
    r'googlebot|google-inspectiontool|googleother|adsbot|mediapartners|bingbot|bingpreview|msnbot|applebot|'
    r'duckduckbot|yandex|baiduspider|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|gptbot|chatgpt-user|'
    r'oai-searchbot|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|facebookexternalhit|'
    r'facebot|bytespider|bytedance|amazonbot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|'
    r'whatsapp|pinterest|seznambot|sogou|exabot|ia_archiver|archive\.org_bot|dataforseo|barkrowler|'
    r'blexbot|serpstatbot|zoominfo|censys|netcraft|expanse|internet-measurement|paloalto|'
    r'uptimerobot|pingdom|statuscake|datadog|zabbix|site24x7|headlesschrome|phantomjs|lighthouse|'
    r'bot\b|bot/|bots\b|crawl|spider|slurp|fetch|scrapy|scanner|monitor', re.I)
NON_BROWSER_RE = re.compile(
    r'^(curl|wget|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|okhttp|java/|apache-httpclient|'
    r'libwww|node-fetch|axios|undici|got\b|httpie|postman|insomnia|zgrab|masscan|nuclei|nmap|nikto|sqlmap|'
    r'dirbuster|gobuster|feroxbuster|wfuzz|hydra|libcurl|winhttp|powershell|ruby|perl|php|guzzle|'
    r'restsharp|dart:|scrapy|httpclient|jersey|mozilla/5\.0 zgrab)|'
    r'\b(curl|wget|python-requests|zgrab|masscan|nuclei|nmap|nikto|sqlmap)\b', re.I)
BROWSER_RE = re.compile(r'^mozilla/\d', re.I)
BROWSER_ENGINE_RE = re.compile(r'chrome|safari|firefox|gecko|applewebkit|edg|opr/|opera|crios|fxios', re.I)
URL_UA_RE = re.compile(r'^\W*(https?://|ftp://|www\.)', re.I)
PROBE_RE = re.compile(
    r'wp-admin|wp-login|wp-content|wp-includes|xmlrpc\.php|/\.env|/\.git|/\.svn|/\.ht|/\.aws|/\.ssh|'
    r'phpmyadmin|pma/|myadmin|cgi-bin|\.php($|/)|\.asp(x)?($|/)|\.jsp($|/)|\.cgi($|/)|/actuator|/boaform|'
    r'/vendor/phpunit|/solr/|/manager/html|/admin/config|/config\.json|/server-status|/shell|/eval-stdin|'
    r'/hudson|/jenkins|/owa/|/autodiscover|/\.well-known/security|/setup\.cgi|/HNAP1|/GponForm|/console/|'
    r'\.(sql|bak|old|zip|tar|gz|7z|rar|ini|yml|yaml|log|swp)$|/etc/passwd|\.\./', re.I)
ASSET_RE = re.compile(r'(^/assets/|\.(js|css|mjs)$)', re.I)

CLASS_ORDER = ("likely human", "unknown", "crawler", "scanner")


def parse_line(line: str, site: str = "") -> dict | None:
    m = LINE_RE.match(line.rstrip("\n"))
    if not m:
        return None
    t = TIME_RE.match(m["time"])
    if not t or t[2] not in MONTHS:
        return None
    return {
        "ip": m["ip"], "site": site, "method": m["method"], "path": m["path"],
        "status": int(m["status"]), "origin": m["origin"], "ua": m["ua"],
        "ts": f"{t[3]}-{MONTHS[t[2]]:02d}-{t[1]} {t[4]}:{t[5]}",
    }


def is_browser_ua(ua: str) -> bool:
    return bool(BROWSER_RE.match(ua)) and bool(BROWSER_ENGINE_RE.search(ua))


def classify(reqs: list[dict]) -> tuple[str, str]:
    """Return (class, reason) for all requests of one IP."""
    n = len(reqs)
    uas = Counter(r["ua"] for r in reqs)
    top_ua = uas.most_common(1)[0][0]
    app_origin = any(r["origin"] in APP_ORIGINS for r in reqs)
    probes = [r for r in reqs if PROBE_RE.search(r["path"])]
    ws = any(r["status"] == 101 and re.match(r'/(ws|link)(/|$)', r["path"]) for r in reqs)
    assets = any(ASSET_RE.search(r["path"]) and r["status"] < 400 for r in reqs)
    client_err = sum(1 for r in reqs if 400 <= r["status"] < 500)

    bot_ua = next((u for u in uas if KNOWN_BOT_RE.search(u)), None)
    if bot_ua and not app_origin:
        return "crawler", f"known bot user agent ({bot_ua[:60]})"
    if probes:
        return "scanner", f"probe path {probes[0]['path'][:60]} ({len(probes)} probe requests)"
    if URL_UA_RE.match(top_ua):
        return "scanner", "user agent is a URL"
    non_browser = [u for u in uas if u in ("", "-") or (NON_BROWSER_RE.search(u) and not is_browser_ua(u))]
    if non_browser and not app_origin:
        ua = non_browser[0]
        return "crawler", "no user agent" if ua in ("", "-") else f"non-browser client ({ua[:60]})"
    if n >= 5 and client_err / n > 0.6:
        return "scanner", f"mostly 4xx ({client_err} of {n})"
    if app_origin:
        return "likely human", "app origin (iOS/Android/web app)"
    if not is_browser_ua(top_ua):
        return "crawler", f"non-browser user agent ({top_ua[:60]})"
    if ws:
        return "likely human", "browser UA and WebSocket upgrade"
    if assets:
        return "likely human", "browser UA and loaded page assets"
    return "unknown", "browser UA but only HTML pages, no assets"


class Geo:
    def __init__(self, path: str) -> None:
        self.reader = None
        try:
            import maxminddb  # type: ignore[import-not-found]
            if os.path.isfile(path):
                self.reader = maxminddb.open_database(path)
        except Exception as e:  # missing module or unreadable db: countries become "??"
            print(f"geoip disabled: {e}", file=sys.stderr)

    def lookup(self, ip: str) -> tuple[str, str]:
        if self.reader is None:
            return "??", "unknown"
        try:
            rec = self.reader.get(ip) or {}
            c = rec.get("country") or {}
            code = c.get("iso_code") or "??"
            name = (c.get("names") or {}).get("en") or "unknown"
            return code, name
        except Exception:
            return "??", "unknown"


def read_lines(path: str):
    opener = gzip.open if path.endswith(".gz") else open
    try:
        with opener(path, "rt", encoding="utf-8", errors="replace") as f:
            yield from f
    except OSError:
        return


def collect(log_dir: str) -> dict[str, list[dict]]:
    by_ip: dict[str, list[dict]] = {}
    for site in SITES:
        files = glob.glob(os.path.join(log_dir, f"{site}.access.log*"))
        for path in files:
            for line in read_lines(path):
                r = parse_line(line, site)
                if r:
                    by_ip.setdefault(r["ip"], []).append(r)
    return by_ip


def summarize(ip: str, reqs: list[dict], geo: Geo) -> dict:
    cls, reason = classify(reqs)
    code, name = geo.lookup(ip)
    status = Counter(("101" if r["status"] == 101 else f"{r['status'] // 100}xx") for r in reqs)
    stamps = sorted(r["ts"] for r in reqs)
    return {
        "ip": ip, "cc": code, "country": name, "cls": cls, "reason": reason,
        "first": stamps[0], "last": stamps[-1], "n": len(reqs),
        "sites": sorted({r["site"] for r in reqs}),
        "ua": Counter(r["ua"] for r in reqs).most_common(1)[0][0],
        "status": status,
    }


def e(s: object) -> str:
    return html.escape(str(s), quote=True)


def render(rows: list[dict], generated: str, geo_enabled: bool) -> str:
    by_class = Counter(r["cls"] for r in rows)
    reqs_by_class = Counter()
    for r in rows:
        reqs_by_class[r["cls"]] += r["n"]
    countries: dict[tuple[str, str], Counter] = {}
    for r in rows:
        countries.setdefault((r["cc"], r["country"]), Counter())[r["cls"]] += 1
    country_rows = sorted(countries.items(), key=lambda kv: (-kv[1]["likely human"], -sum(kv[1].values())))

    out = [
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="robots" content="noindex, nofollow"><title>DaisyChess visitors</title>',
        '<style>body{font:14px/1.45 system-ui,sans-serif;margin:1.5rem auto;max-width:90rem;padding:0 1rem}'
        'table{border-collapse:collapse;margin:.5rem 0 1.5rem}th,td{border:1px solid #ccc;padding:.2rem .5rem;'
        'text-align:left;vertical-align:top}th{background:#eee}td.n{text-align:right}'
        '.ua{max-width:28rem;word-break:break-all;font-size:12px}'
        '.c-likely-human td:first-child{background:#d8f3dc}.c-crawler td:first-child{background:#e0e7ff}'
        '.c-scanner td:first-child{background:#ffd6d6}.c-unknown td:first-child{background:#fff3c4}'
        '</style></head><body>',
        '<h1>DaisyChess visitors</h1>',
        f'<p><a href="index.html">Back to stats</a> &middot; generated {e(generated)} from the last 14 days of '
        'access logs of all three sites. The class is a heuristic estimate, not proof.</p>',
    ]
    if not geo_enabled:
        out.append('<p><strong>Countries unavailable</strong> (GeoIP database or python3-maxminddb missing).</p>')
    out.append('<h2>Summary by class</h2><table><tr><th>Class</th><th>IPs</th><th>Requests</th></tr>')
    for c in CLASS_ORDER:
        out.append(f'<tr><td>{e(c)}</td><td class="n">{by_class[c]}</td><td class="n">{reqs_by_class[c]}</td></tr>')
    out.append('</table><h2>By country (likely humans first)</h2><table><tr><th>Country</th>')
    out.extend(f'<th>{e(c)}</th>' for c in CLASS_ORDER)
    out.append('<th>Total IPs</th></tr>')
    for (cc, name), cnt in country_rows:
        out.append(f'<tr><td>{e(cc)} {e(name)}</td>'
                   + "".join(f'<td class="n">{cnt[c]}</td>' for c in CLASS_ORDER)
                   + f'<td class="n">{sum(cnt.values())}</td></tr>')
    out.append('</table>')

    order = {c: i for i, c in enumerate(CLASS_ORDER)}
    rows = sorted(rows, key=lambda r: (order[r["cls"]], -r["n"], r["ip"]))
    out.append(f'<h2>IPs ({min(len(rows), MAX_ROWS)} of {len(rows)}; humans first, then by requests)</h2>')
    out.append('<table><tr><th>Class</th><th>Reason</th><th>IP</th><th>Country</th><th>First seen</th>'
               '<th>Last seen</th><th>Requests</th><th>Sites</th><th>Status mix</th><th>Top user agent</th></tr>')
    for r in rows[:MAX_ROWS]:
        mix = ", ".join(f"{k}: {v}" for k, v in sorted(r["status"].items()))
        css = "c-" + r["cls"].replace(" ", "-")
        out.append(
            f'<tr class="{e(css)}"><td>{e(r["cls"])}</td><td>{e(r["reason"])}</td><td>{e(r["ip"])}</td>'
            f'<td>{e(r["cc"])} {e(r["country"])}</td><td>{e(r["first"])}</td><td>{e(r["last"])}</td>'
            f'<td class="n">{r["n"]}</td><td>{e(", ".join(r["sites"]))}</td><td>{e(mix)}</td>'
            f'<td class="ua">{e(r["ua"][:200])}</td></tr>')
    out.append('</table><p>IP geolocation by <a href="https://db-ip.com">DB-IP</a>.</p></body></html>\n')
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log-dir", default="/var/log/nginx")
    ap.add_argument("--out", default="visitors.html")
    ap.add_argument("--mmdb", default=DEFAULT_MMDB)
    ap.add_argument("--generated", default="")
    a = ap.parse_args(argv)
    geo = Geo(a.mmdb)
    rows = [summarize(ip, reqs, geo) for ip, reqs in collect(a.log_dir).items()]
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(render(rows, a.generated, geo.reader is not None))
    os.replace(tmp, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
