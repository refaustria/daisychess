"""Run: python3 deploy/stats/test_visitors.py   (also run by apps/site vitest when python3 exists)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visitors as v  # noqa: E402

BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/120.0 Safari/537.36")


def line(ip="1.2.3.4", path="/", status=200, origin="-", ua=BROWSER, method="GET"):
    return (f'{ip} [30/Oct/2026:00:31:40 +0100] "{method} {path} HTTP/1.1" {status} 100 '
            f'rt=0.000 urt=- origin="{origin}" ua="{ua}"')


def cls(*lines):
    return v.classify([v.parse_line(l, "daisychess.org") for l in lines])[0]


class Classifier(unittest.TestCase):
    def test_parse(self):
        r = v.parse_line(line(path="/a b"), "x")
        self.assertEqual((r["ip"], r["path"], r["status"], r["ts"]), ("1.2.3.4", "/a b", 200, "2026-10-30 00:31"))
        self.assertIsNone(v.parse_line("garbage"))

    def test_crawler(self):
        self.assertEqual(cls(line(ua="Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")), "crawler")
        self.assertEqual(cls(line(ua="curl/8.4.0")), "crawler")
        self.assertEqual(cls(line(ua="Go-http-client/1.1")), "crawler")
        self.assertEqual(cls(line(ua="-")), "crawler")

    def test_scanner(self):
        self.assertEqual(cls(line(path="/wp-login.php", status=404)), "scanner")
        self.assertEqual(cls(line(path="/.env", status=404)), "scanner")
        self.assertEqual(cls(line(ua="https://example.com/scan")), "scanner")
        self.assertEqual(cls(*[line(path=f"/x{i}", status=404) for i in range(6)]), "scanner")

    def test_human(self):
        self.assertEqual(cls(line(), line(path="/assets/index-abc.js")), "likely human")
        self.assertEqual(cls(line(path="/ws", status=101)), "likely human")

    def test_app_origin(self):
        self.assertEqual(cls(line(origin="capacitor://app.daisychess.org", ua="okhttp/4.12")), "likely human")
        self.assertEqual(cls(line(origin="https://app.daisychess.org", path="/api/x")), "likely human")
        self.assertEqual(cls(line(ua="okhttp/4.12")), "crawler")

    def test_unknown(self):
        self.assertEqual(cls(line(), line(path="/features/")), "unknown")
        self.assertEqual(cls(line(path="/missing.js", status=404), line()), "unknown")


class Rendering(unittest.TestCase):
    def test_escaping(self):
        evil = '<script>alert(1)</script>"'
        reqs = [v.parse_line(line(ua=evil, path="/<img src=x>"), "daisychess.org")]
        # the log regex needs the UA to end the line; quotes inside stay part of the UA
        self.assertIsNotNone(reqs[0])
        row = v.summarize("1.2.3.4", reqs, v.Geo("/nonexistent"))
        page = v.render([row], "<b>now</b>", False)
        self.assertNotIn("<script>alert", page)
        self.assertNotIn("<img src=x>", page)
        self.assertNotIn("<b>now</b>", page)
        self.assertIn("&lt;script&gt;", page)

    def test_no_geo(self):
        row = v.summarize("1.2.3.4", [v.parse_line(line(), "daisychess.org")], v.Geo("/nonexistent"))
        self.assertEqual(row["cc"], "??")


if __name__ == "__main__":
    unittest.main()
