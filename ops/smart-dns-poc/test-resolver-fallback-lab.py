#!/usr/bin/env python3
"""Offline, exact-preservation tests for the staged fallback-only DoT resolver."""
import importlib.util
import pathlib
import unittest

HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location(
    "resolver_fallback_lab", HERE/"render-resolver-fallback-lab.py"
)
assert spec is not None and spec.loader is not None
lab=importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
source=(HERE/"Corefile.gemini-canary").read_text()


class FallbackTests(unittest.TestCase):
    def test_additive_and_only_on_servfail(self):
        result=lab.render(source)
        self.assertIn("next SERVFAIL",result)
        self.assertNotIn("next NXDOMAIN",result)
        self.assertNotIn("next REFUSED",result)
        self.assertNotIn("tls://9.9.9.9",result.replace(lab.NEW,""))
        self.assertIn("tls_servername dns.quad9.net",result)
        self.assertIn("tls://1.1.1.1",result)
        self.assertIn("tls_servername cloudflare-dns.com",result)
        self.assertEqual(result.replace(lab.NEW,lab.OLD,1),source)
        for field in ("template IN A gemini.google.com",
                      "template IN AAAA gemini.google.com",
                      "template IN HTTPS gemini.google.com",
                      "template IN SVCB gemini.google.com",
                      "cache 30"):
            self.assertIn(field,result)

    def test_reject_replay_and_foreign_forward_configuration(self):
        with self.assertRaises(ValueError):
            lab.render(lab.render(source))
        with self.assertRaises(ValueError):
            lab.render(source.replace("tls_servername dns.quad9.net",
                                      "tls_servername unsafe.example"))
        with self.assertRaises(ValueError):
            lab.render(source.replace("template IN A gemini.google.com",
                                      "template IN A fake.example.com"))

    def test_no_plaintext_fallback_or_dns_wildcard(self):
        result=lab.render(source)
        self.assertNotIn("forward . 1.1.1.1",result)
        self.assertNotIn("forward . 8.8.8.8",result)
        self.assertNotIn("proxy_pass",result)
        self.assertNotIn("*.google",result)
        self.assertNotIn("*.instagram",result)
        self.assertNotIn("tls_servername dns.quad9.net\n        health_check 5s\n        max_concurrent 16\n        max_connect_attempts 2\n    }\n    forward",result)


if __name__=="__main__":
    unittest.main(verbosity=2)
