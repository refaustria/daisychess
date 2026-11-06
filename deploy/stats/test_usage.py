"""Run: python3 deploy/stats/test_usage.py   (or python3 -m unittest discover -s deploy/stats)."""
import gzip
import os
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage as u  # noqa: E402

BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/120.0 Safari/537.36")
ENTRY = "/assets/index-AbCd1234.js"


def line(ip="1.2.3.4", path=ENTRY, status=200, origin="-", ua=BROWSER, day="30/Oct/2026", hm="10:31", ref=None):
    """ref=None writes the old format (no ref= field)."""
    r = "" if ref is None else f'ref="{ref}" '
    return (f'{ip} [{day}:{hm}:40 +0100] "GET {path} HTTP/1.1" {status} 100 '
            f'rt=0.000 urt=- origin="{origin}" {r}ua="{ua}"')


def run(lines_by_file, excluded=(), now=datetime(2026, 10, 31, 12, 0)):
    with tempfile.TemporaryDirectory() as d:
        for name, lines in lines_by_file.items():
            p = os.path.join(d, name)
            if name.endswith(".gz"):
                with gzip.open(p, "wt", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
            else:
                with open(p, "w", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
        ips = u.collect(d, set(excluded), u.ROOK_TABLES)
    return ips, u.analyze(ips, now)


LOG = "play.daisychess.org.access.log"


class Usage(unittest.TestCase):
    def test_active_requires_entry_script_or_app_origin(self):
        ips, s = run({LOG: [line(path="/"), line(ip="2.2.2.2"), line(ip="3.3.3.3", path="/x", origin="capacitor://app.daisychess.org")]})
        self.assertEqual(set(ips), {"2.2.2.2", "3.3.3.3"})
        self.assertEqual(s["active14"], 2)
        self.assertEqual(s["app_users"], 1)

    def test_features_only_count_for_active_browsers(self):
        ips, _ = run({LOG: [line(ip="9.9.9.9", path="/assets/PuzzlesPanel-AbCd1234.js")]})
        self.assertEqual(ips, {})

    def test_bots_ua_and_status(self):
        ips, _ = run({LOG: [
            line(ip="1.1.1.1", ua="Mozilla/5.0 (compatible; Googlebot/2.1)"),
            line(ip="2.2.2.2", ua="curl/8.0"),
            line(ip="3.3.3.3", status=404),
            line(ip="4.4.4.4", status=304),
        ]})
        self.assertEqual(set(ips), {"4.4.4.4"})

    def test_returning_and_per_day(self):
        _, s = run({LOG: [
            line(ip="1.1.1.1", day="29/Oct/2026"), line(ip="1.1.1.1", day="30/Oct/2026"),
            line(ip="1.1.1.1", day="31/Oct/2026"), line(ip="1.1.1.1", day="28/Oct/2026"),
            line(ip="2.2.2.2", day="30/Oct/2026"),
            line(ip="3.3.3.3", day="31/Oct/2026", origin="https://app.daisychess.org"),
        ]})
        self.assertEqual((s["active14"], s["ret2"], s["ret4"], s["today"]), (3, 1, 1, 2))
        by = {r["day"]: r for r in s["per_day"]}
        self.assertEqual((by["2026-10-30"]["new"], by["2026-10-30"]["returning"]), (1, 1))
        self.assertEqual((by["2026-10-31"]["app"], by["2026-10-31"]["web"]), (1, 1))

    def test_feature_mapping(self):
        rook = u.ROOK_TABLES
        f = lambda path, status=200: u.feature_of({"path": path, "status": status}, rook)  # noqa: E731
        self.assertEqual(f("/assets/ReviewPanel-AbCd1234.js"), "Review")
        self.assertEqual(f("/assets/LivePanel-AbCd1234.js"), "Live on lichess")
        self.assertEqual(f("/assets/MistakesPanel-AbCd_-12.js"), "Mistake puzzles")
        self.assertIsNone(f("/assets/openings-AbCd1234.js"))
        self.assertIsNone(f("/assets/PuzzlesPanel-AbCd1234.css"))
        self.assertIsNone(f("/assets/UnknownPanel-AbCd1234.js"))
        self.assertEqual(f("/puzzles/v1/shards/1700-15dd2b14338eb1aa.json"), u.F_SHARDS)
        self.assertEqual(f("/endgames/v1/KRPvKR.rtbw"), u.F_ROOK)
        self.assertIsNone(f("/endgames/v1/KQvK.rtbw"))
        self.assertEqual(f("/ws", 101), u.F_ONLINE)
        self.assertIsNone(f("/ws", 400))

    def test_feature_windows_and_ws_sessions(self):
        ips, s = run({LOG: [
            line(), line(path="/ws", status=101, hm="11:00"), line(path="/ws", status=101, hm="11:05"),
            line(path="/assets/PlayPanel-AbCd1234.js", day="20/Oct/2026"),
        ]}, now=datetime(2026, 10, 30, 12, 0))
        self.assertEqual(s["windows"]["14 days"]["features"]["Play"], 1)
        self.assertEqual(s["windows"]["7 days"]["features"]["Play"], 0)
        self.assertEqual(s["windows"]["24 hours"]["features"][u.F_ONLINE], 1)
        self.assertEqual((s["ws_ips"], s["ws_sessions"]), (1, 2))

    def test_gz_and_rotated_files(self):
        ips, _ = run({LOG: [line(ip="1.1.1.1")], LOG + ".1": [line(ip="2.2.2.2")],
                      LOG + ".2.gz": [line(ip="3.3.3.3")], "daisychess.org.access.log": [line(ip="4.4.4.4")]})
        self.assertEqual(set(ips), {"1.1.1.1", "2.2.2.2", "3.3.3.3"})

    def test_ref_source(self):
        f = u.ref_source
        self.assertEqual(f("-"), u.DIRECT)
        self.assertIsNone(f("https://play.daisychess.org"))
        self.assertIsNone(f("https://daisychess.org"))
        for h in ("www.reddit.com", "old.reddit.com", "out.reddit.com"):
            self.assertEqual(f(f"https://{h}"), "reddit")
        self.assertEqual(f("https://www.google.de"), "google")
        self.assertEqual(f("https://www.google.co.uk"), "google")
        self.assertEqual(f("https://lichess.org"), "lichess.org")
        self.assertEqual(f("https://t.co"), "X (Twitter)")
        self.assertEqual(f("android-app://com.google.android.googlequicksearchbox"), "Android app (Play)")
        self.assertEqual(f("https://www.example.org"), "example.org")
        self.assertEqual(f("https://notreddit.com"), "notreddit.com")

    def test_both_formats_and_sources(self):
        ips, s = run({LOG: [
            line(ip="1.1.1.1", path="/", ref="https://old.reddit.com"),
            line(ip="1.1.1.1", ref="https://play.daisychess.org"),
            line(ip="2.2.2.2", path="/", ref="-"), line(ip="2.2.2.2"),
            line(ip="3.3.3.3"),  # old format, no ref= field
            line(ip="4.4.4.4", path="/", ref="https://www.reddit.com", day="20/Oct/2026"),
            line(ip="4.4.4.4", day="20/Oct/2026"),
        ]})
        self.assertEqual(len(ips), 4)
        src = s["sources"]
        self.assertEqual(src["14 days"]["reddit"], 2)
        self.assertEqual(src["7 days"]["reddit"], 1)
        self.assertEqual(src["14 days"][u.DIRECT], 2)

    def test_exclude_ip(self):
        ips, _ = run({LOG: [line(ip="1.1.1.1"), line(ip="2.2.2.2")]}, excluded={"1.1.1.1"})
        self.assertEqual(set(ips), {"2.2.2.2"})

    def test_read_excludes(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "ex")
            with open(p, "w") as f:
                f.write("# me\n5.5.5.5\n\n6.6.6.6 # laptop\n")
            self.assertEqual(u.read_excludes(["7.7.7.7"], p), {"5.5.5.5", "6.6.6.6", "7.7.7.7"})
            self.assertEqual(u.read_excludes([], os.path.join(d, "missing")), set())

    def test_html_escaping(self):
        hostile = '<script>alert(1)</script> Mozilla'
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, LOG), "w", encoding="utf-8") as f:
                f.write(line(ip="<img src=x>", ua=hostile) + "\n")
                f.write(line(ip="1.1.1.1", ua=hostile) + "\n")
            out = os.path.join(d, "usage.html")
            ips = u.collect(d, set(), u.ROOK_TABLES)
            ips["<b>x</b>"] = ips["1.1.1.1"]
            html_text = u.render(ips, u.analyze(ips, datetime(2026, 10, 31)), u.v.Geo("/nonexistent"), "<gen>")
            self.assertNotIn("<script>alert", html_text)
            self.assertNotIn("<b>x</b>", html_text)
            self.assertNotIn("<gen>", html_text)
            self.assertIn("&lt;b&gt;x&lt;/b&gt;", html_text)
            self.assertEqual(u.main(["--log-dir", d, "--out", out, "--mmdb", "/nonexistent",
                                     "--exclude-file", os.path.join(d, "none"), "--exclude-ip", "1.1.1.1"]), 0)
            with open(out, encoding="utf-8") as f:
                self.assertIn("DaisyChess usage", f.read())
            self.assertFalse(os.path.exists(out + ".tmp"))


if __name__ == "__main__":
    unittest.main()
