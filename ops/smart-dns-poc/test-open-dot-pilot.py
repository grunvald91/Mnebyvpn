#!/usr/bin/env python3
"""Offline static guardrails for an explicitly open, bounded DoT trial."""
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent


class PublicDoTPilotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = (HERE / "Corefile.open-pilot").read_text()
        cls.service = (HERE / "mnebydns-dot.service").read_text()

    def test_no_insecure_dns_or_interception(self):
        self.assertIn("tls://.:853", self.core)
        self.assertIn("bind 89.125.90.101", self.core)
        self.assertNotIn("0.0.0.0:53", self.core)
        self.assertNotIn("rewrite", self.core)
        self.assertNotIn("proxy_pass", self.core)
        self.assertIn("tls_servername dns.quad9.net", self.core)

    def test_open_dns_is_explicit_and_downstream_protected(self):
        self.assertNotIn("acl {", self.core)
        self.assertIn("max_concurrent 16", self.core)
        self.assertIn("max_connect_attempts 2", self.core)
        self.assertIn("cache 30", self.core)

    def test_service_resource_caps_and_no_global_service_conflicts(self):
        for required in (
            "CPUQuota=20%", "MemoryMax=160M", "MemoryHigh=112M",
            "TasksMax=48", "Restart=on-failure", "NoNewPrivileges=yes",
            "User=nobody", "ProtectSystem=strict",
            "LoadCredential=fullchain.pem:", "LoadCredential=privkey.pem:",
            "Environment=GOMEMLIMIT=96MiB",
            "LimitNOFILE=256",
        ):
            self.assertIn(required, self.service)
        self.assertNotIn("ExecStartPre=/usr/sbin/iptables", self.service)
        self.assertNotIn("ExecStartPre=/usr/sbin/nft", self.service)
        self.assertNotIn("nginx", self.service)
        self.assertNotIn("docker", self.service)


if __name__ == "__main__":
    unittest.main(verbosity=2)
