#!/usr/bin/env python3
"""Pure tests: exact additive routing, no wildcard, original Gemini retained."""
import importlib.util
import pathlib
import unittest

folder=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("extvoice",folder/"extend-gemini-voice-rr.py")
assert spec and spec.loader
ext=importlib.util.module_from_spec(spec)
spec.loader.exec_module(ext)

class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.dns=(folder/"Corefile.gemini-canary").read_text()
        self.nginx='''stream {
          map $ssl_preread_server_name $direct_mtproxy_backend {
            default 127.0.0.1:9443;
            gemini.google.com 127.0.0.1:15443;
          '''+''.join(f'  host{i}.example.test 127.0.0.1:{9500+i};\n' for i in range(26))+''' }
          server { listen 443; ssl_preread on; proxy_pass $direct_mtproxy_backend; }
        }'''
    def test_dns_additive_exact_hosts(self):
        new=ext.extend_dns(self.dns)
        self.assertIn('template IN A gemini.google.com {',new)
        self.assertIn('answer "{{ .Name }} 20 IN A 89.125.90.101"',new)
        self.assertIn('tls_servername dns.quad9.net',new)
        self.assertIn('cache 30',new)
        for domain in ext.TARGETS:
            self.assertEqual(new.count('template IN A '+domain+' {'),1)
            for rr in ('AAAA','HTTPS','SVCB'):
                self.assertEqual(new.count('template IN '+rr+' '+domain+' {'),1)
        self.assertNotIn('*.google',new)
        self.assertNotIn('template IN A www.google.com',new)
        with self.assertRaises(ValueError):ext.extend_dns(new)
    def test_shared_443_only_adds_two_target_sni_entries(self):
        new=ext.extend_nginx(self.nginx)
        self.assertEqual(new.count('gemini.google.com 127.0.0.1:15443;'),1)
        for h in ext.TARGETS:
            self.assertEqual(new.count(h+' 127.0.0.1:15444;'),1)
        for i in range(26):
            self.assertIn(f'host{i}.example.test 127.0.0.1:{9500+i};',new)
        self.assertEqual(new.count('default 127.0.0.1:9443;'),1)
        self.assertNotIn('proxy_pass $ssl_preread_server_name;',new)
        with self.assertRaises(ValueError):ext.extend_nginx(new)
    def test_invalid_live_state_is_rejected(self):
        with self.assertRaises(ValueError):ext.extend_nginx(self.nginx.replace('gemini.google.com','wrong.example'))
        with self.assertRaises(ValueError):ext.extend_nginx(self.nginx.replace('default ',''))
        with self.assertRaises(ValueError):ext.extend_dns(self.dns.replace('gemini.google.com','wrong.example'))
if __name__=='__main__':
    unittest.main(verbosity=2)
