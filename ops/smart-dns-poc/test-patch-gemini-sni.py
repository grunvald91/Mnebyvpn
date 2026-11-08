#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest
p=pathlib.Path(__file__).with_name('patch-gemini-sni.py')
spec=importlib.util.spec_from_file_location('gemini_patch',p)
assert spec and spec.loader
lib=importlib.util.module_from_spec(spec)
spec.loader.exec_module(lib)
old='''stream {
  map $ssl_preread_server_name $direct_mtproxy_backend {
    default 127.0.0.1:9443;
''' + ''.join(f'    host{i}.example.test 127.0.0.1:{9000+i};\n' for i in range(26)) + '''  }
  server { listen 443; ssl_preread on; proxy_pass $direct_mtproxy_backend; }
}
'''
class PatchTests(unittest.TestCase):
  def test_legacy_entries_unchanged_and_exact_gemini(self):
    new=lib.patch(old)
    self.assertEqual(new.replace('\n    gemini.google.com 127.0.0.1:15443;', '',1),old)
    self.assertEqual(new.count('gemini.google.com'),1)
    self.assertIn('default 127.0.0.1:9443;',new)
    for i in range(26): self.assertIn(f'host{i}.example.test 127.0.0.1:{9000+i};',new)
  def test_refuse_unexpected_map(self):
    for source in [old.replace('direct_mtproxy_backend','somethingelse'),
                   old.replace('default 127.0.0.1:9443;',''),
                   old+old,
                   old.replace('host1.example.test','gemini.google.com')]:
      with self.subTest(source=source[:80]):
        with self.assertRaises(ValueError):lib.patch(source)
  def test_no_duplicate_changes(self):
    with self.assertRaises(ValueError):lib.patch(lib.patch(old))
if __name__=='__main__':unittest.main(verbosity=2)
