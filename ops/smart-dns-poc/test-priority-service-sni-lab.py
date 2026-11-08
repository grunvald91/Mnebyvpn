#!/usr/bin/env python3
"""Test that a priority-service discovery lab cannot silently turn into a VPN proxy."""
import copy
import importlib.util
import json
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "priority_lab", HERE / "priority-service-sni-lab.py"
)
assert SPEC and SPEC.loader
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)
MANIFEST = json.loads((HERE / "priority-service-hosts.json").read_text())


class PriorityServiceLabTests(unittest.TestCase):
    def test_complete_exact_multi_product_manifest(self):
        names = LAB.validate(MANIFEST)
        self.assertEqual(len(names), 15)
        self.assertEqual(len(set(names)), 15)
        for name in (
            "accounts.google.com", "aistudio.google.com", "www.youtube.com",
            "youtubei.googleapis.com", "www.instagram.com",
            "api.instagram.com", "static.cdninstagram.com",
        ):
            self.assertIn(name, names)
        self.assertNotIn("google.com", names)
        self.assertNotIn("youtube.com", names)
        self.assertNotIn("instagram.com", names)

    def test_lab_only_fail_closed_and_original_tls(self):
        rendered = LAB.render(MANIFEST, "/tmp/mnebydns-ci-123/priority-nginx.pid")
        self.assertEqual(rendered.count("listen 127.0.0.1:15447;"), 1)
        self.assertIn("default 127.0.0.1:1;", rendered)
        self.assertIn("ssl_preread on;", rendered)
        self.assertIn("proxy_pass $priority_origin;", rendered)
        self.assertIn("access_log off;", rendered)
        self.assertNotIn("listen 443;", rendered)
        self.assertNotIn("listen 0.0.0.0", rendered)
        self.assertNotIn("ssl_certificate", rendered)
        self.assertNotIn("proxy_ssl_verify off", rendered)
        self.assertNotIn("proxy_pass $ssl_preread_server_name;", rendered)
        self.assertNotIn("*.google", rendered)
        self.assertNotIn("*.instagram", rendered)
        self.assertNotIn("~", rendered)
        for host in LAB.validate(MANIFEST):
            self.assertEqual(rendered.count(f"{host} {host}:443;"), 1, host)
        self.assertEqual(
            len(re.findall(r"(?m)^        [a-z0-9.-]+ [a-z0-9.-]+:443;$", rendered)),
            15,
        )

    def test_no_dns_or_production_nginx_mutation_in_stager(self):
        source = (HERE / "priority-service-sni-lab.py").read_text()
        self.assertNotIn("/etc/nginx/nginx.conf", source)
        self.assertNotIn("/opt/mnebydns-dot/Corefile", source)
        self.assertNotIn("systemctl", source)
        self.assertNotIn("nginx -s reload", source)
        self.assertNotIn("iptables", source)

    def test_bogus_host_or_origin_is_not_accepted(self):
        for name in (
            "*.youtube.com", "youtube.com.evil.test", "private.local",
            "gosuslugi.ru", "sberbank.ru", "random.googlevideo.com",
        ):
            with self.subTest(host=name):
                invalid = copy.deepcopy(MANIFEST)
                invalid["hosts"][0]["host"] = name
                with self.assertRaises(ValueError):
                    LAB.validate(invalid)

    def test_duplicate_source_and_cross_product_rejected(self):
        for edit in (
            lambda x: x["hosts"].append(x["hosts"][0]),
            lambda x: x["hosts"][0].update(service="Instagram"),
            lambda x: x["hosts"][0].update(source="http://example.org/a"),
            lambda x: x["hosts"][0].update(source="https://bad.test/\nheader"),
            lambda x: x["hosts"][0].update(status="verified"),
            lambda x: x["hosts"][0].update(role="*"),
        ):
            invalid = copy.deepcopy(MANIFEST)
            edit(invalid)
            with self.assertRaises(ValueError):
                LAB.validate(invalid)

    def test_public_route_and_unapproved_schema_fail_closed(self):
        for field, value in (
            ("publicDnsRewrite", True),
            ("publicIngressChange", True),
            ("listener", "0.0.0.0:443"),
            ("mode", "PRODUCTION"),
            ("schemaVersion", 2),
        ):
            invalid = copy.deepcopy(MANIFEST)
            invalid[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                LAB.validate(invalid)

    def test_output_path_guard(self):
        for path in (
            "/etc/nginx/nginx.pid",
            "/tmp/mnebydns-ci-123/../../nginx.pid",
            "/tmp/mnebydns-ci-1/x.pid",
            "/tmp/mnebydns-ci-1/priority-nginx.pid; touch /tmp/x",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                LAB.render(MANIFEST, path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
