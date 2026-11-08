#!/usr/bin/env python3
"""Offline safety invariants for an ISOLATED Google HTTPS SNI passthrough POC."""
import pathlib
import re
import unittest

CONF = pathlib.Path(__file__).with_name("Google-SNI-staging.nginx.conf")


class SNIPrototypeTests(unittest.TestCase):
    def test_no_public_binding_or_dynamic_proxy(self):
        s = CONF.read_text()
        self.assertIn("listen 127.0.0.1:15443;", s)
        self.assertIn("default 127.0.0.1:1;", s)
        self.assertIn("ssl_preread on;", s)
        self.assertIn("proxy_pass $mnebydns_origin;", s)
        self.assertNotIn("proxy_pass $ssl_preread_server_name", s)
        self.assertNotIn("listen 443;", s)
        self.assertNotIn("listen 0.0.0.0:", s)
        self.assertNotIn("ssl_certificate ", s)
        self.assertNotIn("proxy_ssl_verify off", s)

    def test_exact_google_host_rules_only(self):
        s = CONF.read_text()
        entries = re.findall(r"^\s+([a-z0-9.]+)\s+([a-z0-9.]+:443);$", s, re.M)
        self.assertGreaterEqual(len(entries), 4)
        self.assertEqual(len(entries), len(set(entries)))
        allowed_domains = {
            "gemini.google.com", "aistudio.google.com", "accounts.google.com",
            "generativelanguage.googleapis.com", "labs.google",
            "www.google.com", "www.youtube.com", "www.gstatic.com",
        }
        self.assertEqual({n for n, _ in entries}, allowed_domains)
        for name, backend in entries:
            self.assertEqual(backend, name + ":443")
        self.assertNotRegex(s, r"(?m)^\s+~")  # no regex matching external hostnames
        self.assertNotIn("*.google", s)

    def test_no_logging_of_user_requests(self):
        s = CONF.read_text()
        self.assertIn("access_log off;", s)
        self.assertNotIn("log_format", s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
