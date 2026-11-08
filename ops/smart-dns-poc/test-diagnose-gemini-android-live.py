#!/usr/bin/env python3
"""Local-only unit tests for read-only Gemini/Android live policy audit."""
import importlib.util
import pathlib
import socket
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("android_diagnose",HERE/"diagnose-gemini-android-live.py")
assert spec and spec.loader
AUDIT=importlib.util.module_from_spec(spec)
spec.loader.exec_module(AUDIT)

def a(name):
    return (0, 1, [(1, 20, socket.inet_aton(name))])

def aaaa(name):
    return (0, 1, [(28, 20, socket.inet_pton(socket.AF_INET6, name))])

NODATA=(0,0,[])


class GeminiAndroidRouteTests(unittest.TestCase):
    def test_controlled_HTTPS_ingress(self):
        self.assertEqual(
            AUDIT.classify(a(AUDIT.FOREIGN_INGRESS),NODATA),
            "FOREIGN_HTTPS_INGRESS"
        )
        self.assertEqual(
            AUDIT.classify(a(AUDIT.FOREIGN_INGRESS),aaaa("2001:4860:4860::8888")),
            "MIXED_INGRESS_UNSAFE"
        )
        self.assertEqual(
            AUDIT.classify((0,2,[(1,20,socket.inet_aton(AUDIT.FOREIGN_INGRESS)),
                                 (1,20,socket.inet_aton("8.8.8.8"))]),NODATA),
            "MIXED_INGRESS_UNSAFE"
        )

    def test_direct_private_errors_never_called_successful_foreign_proxy(self):
        self.assertEqual(AUDIT.classify(a("8.8.8.8"),NODATA),"NON_SYNTHETIC_OR_IPV6")
        self.assertEqual(AUDIT.classify(NODATA,aaaa("2001:4860:4860::8888")),"NON_SYNTHETIC_OR_IPV6")
        self.assertEqual(AUDIT.classify(NODATA,NODATA),"NO_ADDRESS")
        self.assertEqual(AUDIT.classify((2,0,[]),NODATA),"DNS_ERROR_OR_NONEXISTENT")
        self.assertEqual(AUDIT.classify((3,0,[]),NODATA),"DNS_ERROR_OR_NONEXISTENT")
        self.assertEqual(AUDIT.classify((0,1,[(1,20,b"xx")]),NODATA),"INVALID_A")
        self.assertEqual(AUDIT.classify(NODATA,(0,1,[(28,20,b"xx")])),"INVALID_AAAA")

    def test_google_official_host_list_and_android_system_coverage(self):
        self.assertEqual(len(AUDIT.GEMINI_HOSTS),34)
        self.assertEqual(len(set(AUDIT.GEMINI_HOSTS)),34)
        self.assertIn("jnn-pa.googleapis.com",AUDIT.GEMINI_HOSTS)
        self.assertIn("waa-pa.clients6.google.com",AUDIT.GEMINI_HOSTS)
        self.assertIn("optimizationguide-pa.googleapis.com",AUDIT.GEMINI_HOSTS)
        self.assertIn("play.google.com",AUDIT.GEMINI_HOSTS)
        self.assertIn("mtalk.google.com",AUDIT.ANDROID_SYSTEM_HOSTS)
        self.assertIn("fcm.googleapis.com",AUDIT.ANDROID_SYSTEM_HOSTS)
        self.assertIn("time.google.com",AUDIT.ANDROID_SYSTEM_HOSTS)
        self.assertTrue(set(AUDIT.EXISTING_CONTROLS).isdisjoint(set(AUDIT.GEMINI_HOSTS)))

    def test_ssl_hostname_validation_is_not_disabled_and_no_mutations(self):
        source=(HERE/"diagnose-gemini-android-live.py").read_text()
        for forbidden in (
            "CERT_NONE","check_hostname = False","systemctl","sshpass",
            "/etc/nginx/nginx.conf", "sudo ", "subprocess",
            "POST", "authorization", "requests.post", "cookies",
        ):
            self.assertNotIn(forbidden,source)
        self.assertIn("PRIVATE_DNS_NAME",source)
        self.assertIn("read_only_no_production_changes=yes",source)

    def test_bad_live_transport_explicit_not_silent(self):
        with patch.object(AUDIT.PROBE,"query",side_effect=TimeoutError):
            self.assertEqual(AUDIT.inspect("apis.google.com"),"TRANSPORT_FAILURE")
        with patch.object(AUDIT.PROBE,"query",side_effect=[
            a(AUDIT.FOREIGN_INGRESS),NODATA,
        ]) as mocked:
            self.assertEqual(AUDIT.inspect("gemini.google.com"),
                             "FOREIGN_HTTPS_INGRESS")
            self.assertEqual(mocked.call_count,2)
            self.assertEqual(mocked.call_args_list[0].args[3],853)


if __name__=="__main__":
    unittest.main(verbosity=2)
