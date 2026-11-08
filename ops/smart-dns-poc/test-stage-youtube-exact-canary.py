#!/usr/bin/env python3
"""Offline safety tests: YouTube canary may be staged, never activated here."""
import importlib.util
import json
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def imported(name: str, module: str):
    spec = importlib.util.spec_from_file_location(module, HERE / name)
    assert spec and spec.loader
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


YT = imported("stage-youtube-exact-canary.py", "yt_canary")
DISCORD = imported("stage-ru-access-pilot.py", "discord_stager")
MANIFEST = json.loads((HERE / "ru-access-first-pilot.json").read_text())
DISCORD_HOSTS = DISCORD.domains(MANIFEST)
SOURCE_NGINX = """stream {
    map $ssl_preread_server_name $direct_mtproxy_backend {
        default 127.0.0.1:9443;
        gemini.google.com 127.0.0.1:15443;
""" + "".join(
    f"        existing{i}.example.test 127.0.0.1:{9000+i};\n"
    for i in range(26)
) + """    }
    server { listen 443; ssl_preread on; proxy_pass $direct_mtproxy_backend; }
}
"""
BASE_NGINX = DISCORD.render_sni(SOURCE_NGINX, DISCORD_HOSTS)
BASE_DNS = DISCORD.render_dns((HERE / "Corefile.gemini-canary").read_text(), DISCORD_HOSTS)


class YouTubeExactStagingTests(unittest.TestCase):
    def test_additive_sni_change_only_two_entries(self):
        staged = YT.staged_sni(BASE_NGINX)
        addition = "\n" + "".join(
            f"        {h} {YT.LISTENER};\n" for h in YT.HOSTS
        )
        self.assertEqual(staged.replace(addition, "", 1), BASE_NGINX)
        self.assertEqual(staged.count("gemini.google.com 127.0.0.1:15443;"), 1)
        for h in YT.EXISTING:
            self.assertEqual(staged.count(h), 1)
        for h in YT.HOSTS:
            self.assertEqual(staged.count(h + " " + YT.LISTENER + ";"), 1)
        for i in range(26):
            self.assertIn(f"existing{i}.example.test 127.0.0.1:{9000+i};", staged)
        with self.assertRaises(ValueError):
            YT.staged_sni(staged)

    def test_every_youtube_record_type_synthetic_without_wildcard(self):
        staged = YT.staged_dns(BASE_DNS, "9.9.9.9")
        for host in YT.HOSTS:
            for kind in YT.RECORD_TYPES:
                self.assertEqual(staged.count(f"template IN {kind} {host} {{"), 1)
        for host in YT.EXISTING:
            self.assertIn(f"template IN A {host} {{", staged)
        self.assertIn("tls_servername dns.quad9.net", staged)
        self.assertIn("forward . tls://9.9.9.9", staged)
        self.assertNotIn("template IN A www.instagram.com", staged)
        self.assertNotIn("template IN A gosuslugi.ru", staged)
        self.assertNotIn("template IN A googlevideo.com", staged)
        with self.assertRaises(ValueError):
            YT.staged_dns(staged, "9.9.9.9")

    def test_strict_requirements_reject_bad_known_live_state(self):
        for key in ("gemini.google.com", "discord.com",
                    "gateway.discord.gg", "cdn.discordapp.com"):
            with self.subTest(host=key), self.assertRaises(ValueError):
                YT.staged_sni(BASE_NGINX.replace(key, "deleted.example.test"))
            with self.subTest(host=key), self.assertRaises(ValueError):
                YT.staged_dns(BASE_DNS.replace(
                    "template IN A " + key, "template IN A deleted.example.test"
                ), "9.9.9.9")
        with self.assertRaises(ValueError):
            YT.staged_sni("unrecognized nginx")
        with self.assertRaises(ValueError):
            YT.staged_dns("unrecognized DNS", "9.9.9.9")

    def test_reject_private_or_non_ipv4_target(self):
        for target in ("127.0.0.1", "192.168.1.1", "10.1.1.1",
                       "2001:db8::1", "localhost", "0.0.0.0"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                YT.staged_dns(BASE_DNS, target)

    def test_local_loopback_sidecar_rejects_every_unknown_sni(self):
        conf = YT.sidecar()
        self.assertIn("listen 127.0.0.1:15448;", conf)
        self.assertIn("resolver 127.0.0.1:5355",conf)
        self.assertNotIn("resolver 9.9.9.9",conf)
        origin=YT.origin_dns()
        self.assertIn("bind 127.0.0.1",origin)
        self.assertIn("tls://9.9.9.9 tls://149.112.112.112",origin)
        self.assertIn("tls_servername dns.quad9.net",origin)
        self.assertNotIn("forward . 9.9.9.9",origin)
        self.assertIn("default 127.0.0.1:1;", conf)
        self.assertIn("ssl_preread on;", conf)
        self.assertIn("access_log off;", conf)
        self.assertNotIn("listen 443;", conf)
        self.assertNotIn("ssl_certificate", conf)
        self.assertNotIn("proxy_pass $ssl_preread_server_name;", conf)
        self.assertNotIn("*.youtube", conf)
        self.assertNotIn("googlevideo.com", conf)
        for h in YT.HOSTS:
            self.assertIn(h + " " + h + ":443;", conf)

    def test_no_prod_mutation_capabilities(self):
        source = (HERE / "stage-youtube-exact-canary.py").read_text()
        for token in ("systemctl", "sshpass", "curl ", "/etc/nginx/nginx.conf",
                      "/opt/mnebydns-dot/Corefile", "sudo ", "iptables"):
            self.assertNotIn(token, source)
        self.assertIn("staging_only_no_network_changes=yes", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
