#!/usr/bin/env python3
"""Offline acceptance tests for the single-client public DoT configuration."""
import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).with_name("render-android-pilot.py")
spec = importlib.util.spec_from_file_location("pilot_render", path)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PilotConfigTests(unittest.TestCase):
    def test_allow_one_source_and_deny_everyone_else(self):
        config = mod.render("9.9.9.9", "8.8.4.4")
        self.assertIn("tls://.:853", config)
        self.assertIn("bind 9.9.9.9", config)
        self.assertIn("allow net 8.8.4.4/32\n        block", config)
        self.assertIn("tls /etc/mnebydns/certs/fullchain.pem /etc/mnebydns/certs/privkey.pem", config)
        self.assertIn("tls_servername dns.quad9.net", config)
        self.assertNotIn("0.0.0.0/0", config)
        self.assertNotIn("::/0", config)
        self.assertNotIn("rewrite", config)

    def test_invalid_or_nonpublic_client_ips_fail_closed(self):
        for client in (
            "0.0.0.0", "127.0.0.1", "10.1.1.1", "192.168.0.9",
            "172.20.1.1", "100.64.0.10", "169.254.10.1",
            "::1", "2001:db8::1", "8.8.4.4/32",
            "bad.invalid", "198.51.100.0/24",
        ):
            with self.subTest(client=client):
                with self.assertRaises(ValueError):
                    mod.render("9.9.9.9", client)

    def test_invalid_binding_fails_closed(self):
        for bind in ("0.0.0.0", "127.0.0.1", "192.168.0.1", "::", "9.9.9.9/32"):
            with self.subTest(bind=bind):
                with self.assertRaises(ValueError):
                    mod.render(bind, "8.8.4.4")

    def test_bind_is_not_client(self):
        with self.assertRaisesRegex(ValueError, "must not equal"):
            mod.render("9.9.9.9", "9.9.9.9")


if __name__ == "__main__":
    unittest.main(verbosity=2)
