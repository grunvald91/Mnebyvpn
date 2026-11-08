#!/usr/bin/env python3
"""Unit and safety regression tests for broad Google suffix-only routing."""
from __future__ import annotations
import importlib.util
import json
import pathlib
import re
import unittest

HERE=pathlib.Path(__file__).resolve().parent


def import_file(path,name):
    spec=importlib.util.spec_from_file_location(name,HERE/path)
    assert spec and spec.loader
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


POLICY=import_file("stage-google-ecosystem-suffix.py","ecosystem")
DISCORD=import_file("stage-ru-access-pilot.py","discord")
manifest=json.loads((HERE/"ru-access-first-pilot.json").read_text())
hosts=DISCORD.domains(manifest)
base_nginx = (
    "stream {\n    map $ssl_preread_server_name $direct_mtproxy_backend {\n"
    "        default 127.0.0.1:9443;\n"
    "        gemini.google.com 127.0.0.1:15443;\n"
    "        ~^special[.]googlevideo[.]com$ 127.0.0.1:16444;\n"
    "    }\n    server { listen 443; ssl_preread on;\n"
    "       proxy_pass $direct_mtproxy_backend; }\n}\n"
)
NGINX=DISCORD.render_sni(base_nginx,hosts)
CORE=DISCORD.render_dns((HERE/"Corefile.gemini-canary").read_text(),hosts)


class GoogleEcosystemTests(unittest.TestCase):
    def test_every_selected_google_family_exactly_one_suffix(self):
        self.assertEqual(len(POLICY.SUFFIXES),len(set(POLICY.SUFFIXES)))
        self.assertIn("googlevideo.com",POLICY.SUFFIXES)
        self.assertIn("googleapis.com",POLICY.SUFFIXES)
        self.assertIn("ytimg.com",POLICY.SUFFIXES)
        self.assertIn("ggpht.com",POLICY.SUFFIXES)
        self.assertIn("gstatic.com",POLICY.SUFFIXES)
        self.assertIn("googleusercontent.com",POLICY.SUFFIXES)
        self.assertIn("youtube.com",POLICY.SUFFIXES)

    def test_regex_does_not_capture_unrelated_domains_or_substrings(self):
        urls=(
            "gemini.google.com","jnn-pa.googleapis.com","waa-pa.clients6.google.com",
            "yt3.ggpht.com","r1---sn-abc.googlevideo.com",
            "i.ytimg.com","www.youtube.com","play.google.com",
            "storage.googleapis.com","www.google.com",
            "www.gstatic.com","accounts.youtube.com",
            "googlevideo.com","www.google.ru","www.google.co.uk",
        )
        rejected=(
            "google.com.evil.example","notgoogle.com","youryoutube.com",
            "fake-googlevideo.com","youtube.com.attacker.ru",
            "youtube.com.local","gosuslugi.ru","mnebyvpn.site",
            "discord.com","example.com","mygoogleapis.com",
            "google.com.evil.googleapis.org","googleusercontent.com.evil",
        )
        for host in urls:
            with self.subTest(host=host):
                self.assertIsNotNone(re.fullmatch(POLICY.suffix_pattern(nginx=True),host))
                self.assertIsNotNone(re.fullmatch(POLICY.suffix_pattern(nginx=False),host+"."))
        for host in rejected:
            with self.subTest(host=host):
                self.assertIsNone(re.fullmatch(POLICY.suffix_pattern(nginx=True),host))
                self.assertIsNone(re.fullmatch(POLICY.suffix_pattern(nginx=False),host+"."))

    def test_every_official_gemini_firewall_host_is_covered(self):
        # https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/gemini-app-firewall-settings
        documented=(
            "lh5.googleusercontent.com", "www.googleapis.com", "ssl.gstatic.com",
            "fonts.googleapis.com", "play.google.com", "ogs.google.com",
            "www.google.com", "apis.google.com", "jnn-pa.googleapis.com",
            "waa-pa.clients6.google.com", "i.ytimg.com", "yt3.ggpht.com",
            "lh3.googleusercontent.com", "maps.gstatic.com", "lh3.google.com",
            "ogads-pa.clients6.google.com", "csp.withgoogle.com",
            "www.googletagmanager.com", "www.youtube.com", "fonts.gstatic.com",
            "maps.googleapis.com", "static.doubleclick.net", "www.gstatic.com",
            "gemini.google.com", "td.doubleclick.net",
            "googleads.g.doubleclick.net", "www.google-analytics.com",
            "optimizationguide-pa.googleapis.com", "encrypted-tbn0.gstatic.com",
            "encrypted-tbn1.gstatic.com", "encrypted-tbn2.gstatic.com",
            "encrypted-tbn3.gstatic.com", "streetviewpixels-pa.googleapis.com",
            "content-autofill.googleapis.com",
        )
        self.assertEqual(len(documented),34)
        for host in documented:
            with self.subTest(host=host):
                self.assertIsNotNone(re.fullmatch(
                    POLICY.suffix_pattern(nginx=True),host))

    def test_append_only_without_overwriting_legacy(self):
        a=POLICY.shared_sni(NGINX)
        self.assertEqual(a.count("gemini.google.com 127.0.0.1:15443;"),1)
        self.assertEqual(
            a.count("~^special[.]googlevideo[.]com$ 127.0.0.1:16444;"),1
        )
        self.assertIn("~*"+POLICY.suffix_pattern(nginx=True),a)
        self.assertLess(
            a.index("~^special[.]googlevideo[.]com$"),
            a.index("~*"+POLICY.suffix_pattern(nginx=True)),
            "Existing regex precedence must survive the suffix insertion",
        )
        for h in POLICY.PRESERVED:
            self.assertIn(h, a)
        self.assertEqual(a.count(POLICY.LOCAL_SNI+";"),1)
        self.assertIn("default 127.0.0.1:9443;",a)
        with self.assertRaises(ValueError):
            POLICY.shared_sni(a)
        d=POLICY.public_dot(CORE)
        for h in POLICY.PRESERVED:
            self.assertIn("template IN A "+h+" {",d)
        for kind in POLICY.RR:
            self.assertIn("template IN "+kind+" . {",d)
        self.assertEqual(d.count("forward . tls://9.9.9.9 {"),1)
        with self.assertRaises(ValueError):
            POLICY.public_dot(d)

    def test_conflicting_exact_google_sni_must_be_reviewed(self):
        dangerous=NGINX.replace(
            "        ~^special[.]googlevideo[.]com$ 127.0.0.1:16444;",
            "        www.google.com 127.0.0.1:16444;",
        )
        with self.assertRaisesRegex(ValueError, "shadow"):
            POLICY.shared_sni(dangerous)
        # An unapproved exact route to the local proxy itself would recurse.
        dangerous=NGINX.replace(
            "        ~^special[.]googlevideo[.]com$ 127.0.0.1:16444;",
            "        youtubei.googleapis.com 127.0.0.1:15449;",
        )
        with self.assertRaises(ValueError):
            POLICY.shared_sni(dangerous)

    def test_dns_and_sni_case_insensitive(self):
        regex=POLICY.suffix_pattern(nginx=True)
        for name in ("WWW.YouTube.COM","R1---Sn-Video.GoogleVideo.Com",
                     "JNN-PA.GOOGLEAPIS.COM","GEMINI.GOOGLE.COM"):
            with self.subTest(name=name):
                self.assertIsNotNone(re.fullmatch(regex,name,re.IGNORECASE))
                self.assertIsNotNone(re.fullmatch(
                    "(?i)"+POLICY.suffix_pattern(nginx=False),name+"."))
        n=POLICY.shared_sni(NGINX)
        s=POLICY.proxy_config("/tmp/mnebydns-ci-123/nginx.pid")
        d=POLICY.public_dot(CORE)
        self.assertIn("~*"+regex,n)
        self.assertIn("~*"+regex,s)
        self.assertIn("match (?i)",d)

    def test_non_https_google_protocol_is_release_blocker(self):
        self.assertTrue(POLICY.LAB_ONLY)
        for hostname in POLICY.NON_HTTPS_BLOCKERS:
            with self.subTest(host=hostname):
                self.assertTrue(POLICY.matches_managed_suffix(hostname))
        # Non-443 transports CANNOT be handled by this TCP/443-only SNI proxy.
        self.assertNotIn("listen 5228;",POLICY.proxy_config(
            "/tmp/mnebydns-ci-123/nginx.pid"))
        self.assertNotIn("listen 123;",POLICY.proxy_config(
            "/tmp/mnebydns-ci-123/nginx.pid"))

    def test_fail_closed_and_original_tls(self):
        s=POLICY.proxy_config("/tmp/mnebydns-ci-123/nginx.pid")
        self.assertIn("listen 127.0.0.1:15449;",s)
        self.assertIn("default 127.0.0.1:1;",s)
        self.assertIn("proxy_pass $google_origin;",s)
        self.assertIn("ssl_preread on;",s)
        self.assertIn("resolver 127.0.0.1:5354",s)
        self.assertNotIn("listen 443;",s)
        self.assertNotIn("ssl_certificate",s)
        self.assertNotIn("resolver 9.9.9.9",s)
        self.assertNotIn("proxy_pass $ssl_preread_server_name;",s)
        with self.assertRaises(ValueError):
            POLICY.proxy_config("/etc/nginx/nginx.pid")
        d=POLICY.origin_dns()
        self.assertIn("bind 127.0.0.1",d)
        self.assertIn("tls_servername dns.quad9.net",d)
        self.assertIn("tls://9.9.9.9 tls://149.112.112.112",d)
        self.assertNotIn("forward . 8.8.8.8",d)

    def test_reject_stale_baseline(self):
        for name in POLICY.PRESERVED:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    POLICY.shared_sni(NGINX.replace(name,"deleted.example.test"))
                with self.assertRaises(ValueError):
                    POLICY.public_dot(CORE.replace("template IN A "+name,
                                                     "template IN A deleted.example.test"))
        with self.assertRaises(ValueError):
            POLICY.shared_sni("empty")
        with self.assertRaises(ValueError):
            POLICY.public_dot("empty")

    def test_stager_has_no_live_mutation(self):
        source=(HERE/"stage-google-ecosystem-suffix.py").read_text()
        for prohibited in (
            "systemctl", "sshpass", "iptables", "subprocess",
            "/etc/nginx/nginx.conf", "/opt/mnebydns-dot/Corefile",
            "curl -", "CERT_NONE", "create_connection",
        ):
            self.assertNotIn(prohibited,source)
        self.assertIn("no_public_or_production_changes=yes",source)


if __name__=="__main__":
    unittest.main(verbosity=2)
