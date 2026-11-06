#!/usr/bin/env python3
"""Write a self-contained usage.html (active browsers, returning visitors, feature use) from the
play.daisychess.org nginx access logs. Python 3 standard library only (plus the optional maxminddb country
lookup shared with visitors.py, which must sit next to this file). Everything taken from the logs is
attacker-controlled, so every such string goes through html.escape().

An "active browser" is an IP that loaded the web app entry script /assets/index-<hash>.js or made a request
with an app Origin (Android/iOS app). Feature use is read from lazily loaded chunks, which the browser caches:
a feature shows up on first use per browser per deploy, not on every use.

Usage: usage.py [--log-dir /var/log/nginx] [--out usage.html] [--mmdb PATH] [--generated TEXT]
                [--exclude-ip IP ...] [--exclude-file /etc/daisychess-stats/exclude-ips] [--manifest PATH]
See deploy/README.md "Traffic stats".
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import Counter
from urllib.parse import urlsplit
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visitors as v  # noqa: E402

SITE = "play.daisychess.org"
DEFAULT_EXCLUDE_FILE = "/etc/daisychess-stats/exclude-ips"
OK_STATUS = (200, 206, 304, 101)

# Lazy chunk name (apps/web/src/App.tsx, components/Puzzles/PuzzleModes.tsx) -> feature label.
CHUNK_FEATURES = {
    "PlayPanel": "Play",
    "OpeningsPanel": "Openings",
    "PuzzlesPanel": "Puzzles",
    "EndgamesPanel": "Endgames",
    "LivePanel": "Live on lichess",
    "FriendPanel": "Friend game",
    "ReviewPanel": "Review",
    "ExplorerPanel": "Explorer",
    "SettingsPanel": "Settings",
    "MistakesPanel": "Mistake puzzles",
}
F_SHARDS = "Puzzle shards downloaded"
F_ROOK = "Rook endgame tables downloaded"
F_ONLINE = "Server engine / online play (WebSocket)"
FEATURE_ORDER = tuple(CHUNK_FEATURES.values()) + (F_SHARDS, F_ROOK, F_ONLINE)

# Non-core (downloadable) tables of packages/endgames/tables.manifest.json; --manifest overrides.
ROOK_TABLES = frozenset((
    "KQRvK", "KQRvKR", "KRBvK", "KRBvKR", "KRNvK", "KRNvKR", "KRPvK", "KRPvKR", "KRRvK", "KRRvKR",
    "KRvKB", "KRvKN", "KRvKP", "KRvKR"))

ENTRY_RE = re.compile(r'^/assets/index-[A-Za-z0-9_-]{8}\.js$')
CHUNK_RE = re.compile(r'^/assets/([A-Za-z]+)-[A-Za-z0-9_-]{8}\.js$')
SHARD_RE = re.compile(r'^/puzzles/v1/shards/')
TABLE_RE = re.compile(r'^/endgames/v1/([A-Za-z]+)\.rtb[wz]$')
WS_RE = re.compile(r'^/ws(/|$)')

OWN_HOSTS = ("daisychess.org", "play.daisychess.org", "hub.daisychess.org", "www.daisychess.org",
             "app.daisychess.org")
DIRECT = "Direct / unknown"
# Referrer host (or scheme for android-app://) -> source label; checked by exact host or suffix.
REF_ALIASES = (
    (("reddit.com", "redd.it"), "reddit"),
    (("google.",), "google"),
    (("lichess.org",), "lichess.org"),
    (("chess.com",), "chess.com"),
    (("t.co", "twitter.com", "x.com"), "X (Twitter)"),
    (("facebook.com", "fb.com", "l.facebook.com"), "facebook"),
    (("news.ycombinator.com",), "Hacker News"),
    (("bing.com",), "bing"),
    (("duckduckgo.com",), "duckduckgo"),
    (("github.com",), "github"),
)


def ref_source(ref: str) -> str | None:
    """Label for a referrer origin; None for own hosts. "-" or garbage is Direct / unknown."""
    if not ref or ref == "-":
        return DIRECT
    if ref.lower().startswith("android-app://"):
        return "Android app (Play)"
    try:
        host = (urlsplit(ref).hostname or "").lower().rstrip(".")
    except ValueError:
        return DIRECT
    if not host:
        return DIRECT
    if host in OWN_HOSTS or host.endswith(".daisychess.org"):
        return None
    for keys, label in REF_ALIASES:
        for k in keys:
            if k.endswith("."):  # google.* (google.com, google.de, www.google.co.uk)
                if host.startswith(k) or f".{k}" in host:
                    return label
            elif host == k or host.endswith("." + k):
                return label
    return host[4:] if host.startswith("www.") else host


def load_rook_tables(manifest: str | None) -> frozenset[str]:
    if not manifest:
        return ROOK_TABLES
    try:
        with open(manifest, encoding="utf-8") as f:
            names = {t["name"] for t in json.load(f)["tables"] if t.get("pack") != "core"}
        return frozenset(names) or ROOK_TABLES
    except (OSError, ValueError, KeyError, TypeError) as err:
        print(f"manifest ignored: {err}", file=sys.stderr)
        return ROOK_TABLES


def read_excludes(cli: list[str], path: str) -> set[str]:
    ips = {s.strip() for s in cli if s.strip()}
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                s = raw.split("#", 1)[0].strip()
                if s:
                    ips.add(s)
    except OSError:
        pass
    return ips


def feature_of(r: dict, rook: frozenset[str]) -> str | None:
    path = r["path"]
    m = CHUNK_RE.match(path)
    if m and m[1] in CHUNK_FEATURES:
        return CHUNK_FEATURES[m[1]]
    if SHARD_RE.match(path):
        return F_SHARDS
    t = TABLE_RE.match(path)
    if t and t[1] in rook:
        return F_ROOK
    if r["status"] == 101 and WS_RE.match(path):
        return F_ONLINE
    return None


def is_human_ua(ua: str) -> bool:
    return "Mozilla" in ua and not v.KNOWN_BOT_RE.search(ua.lower())


def collect(log_dir: str, excluded: set[str], rook: frozenset[str]) -> dict[str, dict]:
    """ip -> {"active": {day: {"web"|"app"}}, "events": [(datetime, feature)], "ws": set(minute stamps)}."""
    ips: dict[str, dict] = {}
    for path in glob.glob(os.path.join(log_dir, f"{SITE}.access.log*")):
        for ln in v.read_lines(path):
            r = v.parse_line(ln, SITE)
            if not r or r["ip"] in excluded or r["status"] not in OK_STATUS or not is_human_ua(r["ua"]):
                continue
            try:
                when = datetime.strptime(r["ts"], "%Y-%m-%d %H:%M")
            except ValueError:
                continue
            app = r["origin"] in v.APP_ORIGINS
            web = bool(ENTRY_RE.match(r["path"]))
            feat = feature_of(r, rook)
            day = r["ts"][:10]
            d = ips.setdefault(r["ip"], {"active": {}, "events": [], "refs": {}})
            src = ref_source(r["ref"])  # earliest request of the day with a non-own referrer
            if src is not None and (day not in d["refs"] or when < d["refs"][day][0]):
                d["refs"][day] = (when, src)
            if not (app or web or feat):
                continue
            if app or web:
                d["active"].setdefault(day, set()).add("app" if app else "web")
            if feat:
                d["events"].append((when, feat))
                if feat == F_ONLINE:
                    d.setdefault("ws", set()).add(r["ts"])
    return {ip: d for ip, d in ips.items() if d["active"]}


def analyze(ips: dict[str, dict], now: datetime) -> dict:
    days = sorted({day for d in ips.values() for day in d["active"]})
    today = now.strftime("%Y-%m-%d")
    per_day = []
    for day in days:
        act = [d for d in ips.values() if day in d["active"]]
        returning = sum(1 for d in act if min(d["active"]) < day)
        app = sum(1 for d in act if "app" in d["active"][day])
        per_day.append({"day": day, "active": len(act), "new": len(act) - returning,
                        "returning": returning, "app": app, "web": len(act) - app})

    def windowed(since: datetime) -> dict:
        s = since.strftime("%Y-%m-%d")
        act = {ip for ip, d in ips.items() if any(day >= s for day in d["active"])}
        feats: Counter = Counter()
        for ip in act:
            for f in {f for (t, f) in ips[ip]["events"] if t >= since}:
                feats[f] += 1
        return {"active": len(act), "features": feats}

    def sources(since: datetime) -> Counter:
        s = since.strftime("%Y-%m-%d")
        c: Counter = Counter()
        for d in ips.values():
            for day, (when, src) in d["refs"].items():
                if day >= s and day in d["active"] and when >= since:
                    c[src] += 1
        return c

    return {
        "sources": {"14 days": sources(datetime(2000, 1, 1)), "7 days": sources(now - timedelta(days=7)),
                    "24 hours": sources(now - timedelta(hours=24))},
        "per_day": per_day,
        "today": sum(1 for d in ips.values() if today in d["active"]),
        "active14": len(ips),
        "ret2": sum(1 for d in ips.values() if len(d["active"]) >= 2),
        "ret4": sum(1 for d in ips.values() if len(d["active"]) >= 4),
        "app_users": sum(1 for d in ips.values() if any("app" in s for s in d["active"].values())),
        "windows": {"14 days": windowed(datetime(2000, 1, 1)), "7 days": windowed(now - timedelta(days=7)),
                    "24 hours": windowed(now - timedelta(hours=24))},
        "ws_ips": sum(1 for d in ips.values() if d.get("ws")),
        "ws_sessions": sum(len(d.get("ws", ())) for d in ips.values()),
    }


def e(s: object) -> str:
    return v.e(s)


def render(ips: dict[str, dict], stats: dict, geo: "v.Geo", generated: str) -> str:
    out = [
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="color-scheme" content="light dark">',
        '<meta name="robots" content="noindex, nofollow"><title>DaisyChess usage</title>',
        '<style>:root{--bg:#fff;--fg:#1a1a1a;--line:#ccc;--head:#eee;--bar:#3b82c4;--bar2:#9ec5ea;--tile:#f4f6f8}'
        '@media (prefers-color-scheme:dark){:root{--bg:#16181b;--fg:#e6e6e6;--line:#444;--head:#262a2f;'
        '--bar:#6cb0ee;--bar2:#2f5f8f;--tile:#1f2328}a{color:#8ab4f8}}'
        'body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:1.5rem auto;'
        'max-width:90rem;padding:0 1rem}'
        'table{border-collapse:collapse;margin:.5rem 0 1.5rem}th,td{border:1px solid var(--line);'
        'padding:.2rem .5rem;text-align:left;vertical-align:top}th{background:var(--head)}td.n{text-align:right}'
        '.tiles{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0}.tile{background:var(--tile);'
        'border:1px solid var(--line);border-radius:6px;padding:.5rem 1rem;min-width:8rem}'
        '.tile b{display:block;font-size:1.8rem;line-height:1.2}'
        '.bar{display:inline-block;height:.8rem;background:var(--bar);vertical-align:middle}'
        '.bar.r{background:var(--bar2)}.ft{min-width:16rem;white-space:nowrap}'
        '</style></head><body>',
        '<h1>DaisyChess usage</h1>',
        f'<p><a href="index.html">Back to stats</a> &middot; generated {e(generated)} from the last 14 days of '
        f'the access log of {e(SITE)} (known bots and non-browser clients excluded).</p>',
        '<p><strong>Caveats.</strong> Browsers are counted by IP address, so several people behind one address '
        'count once and one person on several networks counts more than once (a phone moving between Wi-Fi and '
        'mobile data looks like two browsers). Feature use is read from lazily loaded code chunks, and the browser '
        'caches those: a feature appears on its <em>first use per browser per deploy</em>, not on every use, so '
        'repeat use is invisible and a new deploy resets it. &quot;New&quot; on the first day of the log window '
        'includes everyone who was already a visitor earlier.</p>',
    ]
    if geo.reader is None:
        out.append('<p><strong>Countries unavailable</strong> (GeoIP database or python3-maxminddb missing).</p>')
    tiles = [("Active browsers (14 days)", stats["active14"]), ("Active today", stats["today"]),
             ("Returning (2+ days)", stats["ret2"]), ("Returning (4+ days)", stats["ret4"]),
             ("App users (Android/iOS)", stats["app_users"]),
             ("Online-play browsers (WebSocket)", stats["ws_ips"])]
    out.append('<div class="tiles">' + "".join(
        f'<div class="tile"><b>{n}</b>{e(label)}</div>' for label, n in tiles) + '</div>')

    pd = stats["per_day"]
    peak = max((r["active"] for r in pd), default=1) or 1
    out.append('<h2>Per day</h2><table><tr><th>Date</th><th>Active browsers</th><th>New</th><th>Returning</th>'
               '<th>App</th><th>Web</th><th>New / returning</th></tr>')
    for r in reversed(pd):
        nw, rt = 100 * r["new"] / peak, 100 * r["returning"] / peak
        out.append(
            f'<tr><td>{e(r["day"])}</td><td class="n">{r["active"]}</td><td class="n">{r["new"]}</td>'
            f'<td class="n">{r["returning"]}</td><td class="n">{r["app"]}</td><td class="n">{r["web"]}</td>'
            f'<td class="ft"><span class="bar" style="width:{nw:.1f}%"></span>'
            f'<span class="bar r" style="width:{rt:.1f}%"></span></td></tr>')
    out.append('</table>')

    wins = stats["windows"]
    out.append('<h2>Feature use (first use per browser per deploy)</h2><table><tr><th rowspan="2">Feature</th>')
    out.extend(f'<th colspan="2">{e(w)}</th>' for w in wins)
    out.append('</tr><tr>' + '<th>Browsers</th><th>% of active</th>' * len(wins) + '</tr>')
    out.append('<tr><td><em>Active browsers</em></td>' + "".join(
        f'<td class="n">{w["active"]}</td><td class="n">100%</td>' for w in wins.values()) + '</tr>')
    for f in FEATURE_ORDER:
        cells = ""
        for w in wins.values():
            n = w["features"][f]
            pct = f'{100 * n / w["active"]:.0f}%' if w["active"] else "-"
            cells += f'<td class="n">{n}</td><td class="n">{pct}</td>'
        out.append(f'<tr><td>{e(f)}</td>{cells}</tr>')
    out.append('</table>')
    out.append(f'<p>WebSocket sessions (distinct minutes with an upgrade, approximate): '
               f'{stats["ws_sessions"]} from {stats["ws_ips"]} browsers.</p>')

    srcs = stats["sources"]
    out.append('<h2>Where visitors come from</h2><p>Referrer origin (site only, never a path) of the first '
               'request of each active browser per day, own hosts ignored. Counts are browser-days. '
               '<code>?ref=</code> tags in links are not visible: the access log stores the path without query '
               'string.</p><table><tr><th>Source</th>' + "".join(f'<th>{e(w)}</th>' for w in srcs) + '</tr>')
    names = sorted({k for c in srcs.values() for k in c},
                   key=lambda k: (-srcs["14 days"][k], k))
    for k in names:
        out.append(f'<tr><td>{e(k)}</td>' + "".join(f'<td class="n">{c[k]}</td>' for c in srcs.values()) + '</tr>')
    out.append('</table>')

    rows = []
    for ip, d in ips.items():
        days = sorted(d["active"])
        kinds = {k for s in d["active"].values() for k in s}
        used = {f for _, f in d["events"]}
        code, name = geo.lookup(ip)
        rows.append({"ip": ip, "cc": code, "country": name, "first": days[0], "last": days[-1], "days": len(days),
                     "kind": "+".join(k for k in ("web", "app") if k in kinds),
                     "features": [f for f in FEATURE_ORDER if f in used]})
    rows.sort(key=lambda r: (-r["days"], r["ip"]))
    out.append(f'<h2>Browsers ({min(len(rows), v.MAX_ROWS)} of {len(rows)}; most days active first)</h2>')
    out.append('<table><tr><th>IP</th><th>Country</th><th>First seen</th><th>Last seen</th><th>Days active</th>'
               '<th>Web / app</th><th>Features used</th></tr>')
    for r in rows[:v.MAX_ROWS]:
        out.append(
            f'<tr><td>{e(r["ip"])}</td><td>{e(r["cc"])} {e(r["country"])}</td><td>{e(r["first"])}</td>'
            f'<td>{e(r["last"])}</td><td class="n">{r["days"]}</td><td>{e(r["kind"])}</td>'
            f'<td>{e(", ".join(r["features"]))}</td></tr>')
    out.append('</table><p>IP geolocation by <a href="https://db-ip.com">DB-IP</a>.</p></body></html>\n')
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log-dir", default="/var/log/nginx")
    ap.add_argument("--out", default="usage.html")
    ap.add_argument("--mmdb", default=v.DEFAULT_MMDB)
    ap.add_argument("--generated", default="")
    ap.add_argument("--exclude-ip", action="append", default=[], help="own IP to leave out (repeatable)")
    ap.add_argument("--exclude-file", default=DEFAULT_EXCLUDE_FILE, help="one IP per line, # comments; optional")
    ap.add_argument("--manifest", default=None, help="packages/endgames/tables.manifest.json (rook pack names)")
    a = ap.parse_args(argv)
    geo = v.Geo(a.mmdb)
    ips = collect(a.log_dir, read_excludes(a.exclude_ip, a.exclude_file), load_rook_tables(a.manifest))
    stats = analyze(ips, datetime.now())
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(render(ips, stats, geo, a.generated))
    os.replace(tmp, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
