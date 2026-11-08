#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import socket
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("ru_probe", HERE/"compare-priority-ru-tls.py")
assert SPEC and SPEC.loader
RU = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RU)
MANIFEST=json.loads((HERE/"priority-service-hosts.json").read_text())


class TransportComparisonTests(unittest.TestCase):
    def test_exact_host_admission_and_nonprivate_ingress(self):
        names=RU.validate_inputs(MANIFEST,"89.125.90.101")
        self.assertEqual(len(names),15)
        self.assertTrue(set(RU.LIVE_CONTROLS).isdisjoint(names))
        for ip in ("127.0.0.1","10.1.1.1","192.168.0.9",
                   "2001:db8::1","not-an-ip"):
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                RU.validate_inputs(MANIFEST,ip)

    def test_never_report_tls_success_from_tcp_only(self):
        with patch.object(RU.socket,"create_connection",side_effect=ConnectionRefusedError):
            x=RU.tls_connect("www.youtube.com","89.125.90.101")
        self.assertEqual(x["status"],"CONNECTION_CLOSED")
        self.assertFalse(x["tcp_connected"])
        with patch.object(RU.socket,"getaddrinfo",side_effect=socket.gaierror):
            x=RU.tls_connect("www.instagram.com",None)
        self.assertEqual(x["status"],"DNS_ERROR")

    def test_candidates_never_automatically_admitted(self):
        fake={
            "status":"ORIGIN_CERT_VALID","tcp_connected":True,
            "tls":"TLSv1.3","elapsed_ms":20,
        }
        with patch.object(RU,"tls_connect",return_value=fake) as mocked:
            result=RU.compare(MANIFEST["hosts"][0],"89.125.90.101")
        self.assertEqual(result["scope"],"TLS_HANDSHAKE_ONLY")
        self.assertEqual(result["direct_ipv4"]["status"],"ORIGIN_CERT_VALID")
        self.assertEqual(result["via_foreign_public_443"]["status"],"ORIGIN_CERT_VALID")
        self.assertEqual(mocked.call_count,2)
        self.assertEqual(mocked.call_args_list[0].args[1],None)
        self.assertEqual(mocked.call_args_list[1].args[1],"89.125.90.101")

    def test_no_tls_certificate_validation_bypass_and_no_live_mutation(self):
        source=(HERE/"compare-priority-ru-tls.py").read_text()
        self.assertIn("ssl.create_default_context()",source)
        self.assertIn("server_hostname=host",source)
        self.assertNotIn("CERT_NONE",source)
        self.assertNotIn("check_hostname = False",source)
        self.assertNotIn("subprocess",source)
        self.assertNotIn("systemctl",source)
        self.assertNotIn("POST",source)
        self.assertNotIn("cookies",source.lower().replace("cookies or client",""))

if __name__=="__main__":
    unittest.main(verbosity=2)
