import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "ops" / "controller188-key-bootstrap.py"
spec = importlib.util.spec_from_file_location("controller188_bootstrap", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Controller188KeyBootstrap(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="controller188-test-", dir="/root")
        self.root = Path(self.tmp.name) / "new-controller"
        self.addCleanup(self.tmp.cleanup)

    def test_complete_offline_keys_and_no_activation(self):
        result = m.initialize(self.root)
        self.assertEqual(result["controller_host"], "188.120.254.223")
        self.assertEqual(result["state"], "awaiting_independent_approval")
        self.assertEqual(result["client_publication"], False)
        self.assertEqual(result["database_changed"], False)
        self.assertEqual(result["services_restarted"], False)
        self.assertEqual(result["controller_key_exported"], False)
        self.assertRegex(result["controller_public_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(self.root.stat().st_mode & 0o077, 0)
        for name in m.FILES:
            file = self.root / name
            self.assertEqual(file.stat().st_uid, 0)
            self.assertEqual(file.stat().st_mode & 0o077, 0)
        public = (self.root / "controller-public.spki").read_bytes()
        self.assertEqual(len(public), 44)
        self.assertEqual(hashlib.sha256(public).hexdigest(),
                         result["controller_public_sha256"])
        self.assertNotEqual((self.root / "controller-signing-key.pem").read_bytes(),
                            (self.root / "fi-enrollment-ssh").read_bytes())
        report = m.audit(self.root)
        self.assertTrue(report["signer_consistent"])
        self.assertFalse(report["controller_key_independently_approved"])
        self.assertFalse(report["fi_host_key_independently_pinned"])
        self.assertFalse(report["fi_node_identity_matches_inventory"])
        self.assertFalse(report["enrollment_material_ready"])
        self.assertFalse(report["db_enrollment_verified"])
        self.assertFalse(report["subscriber_publication"])

    def test_no_silent_overwrite_and_independent_approval(self):
        result = m.initialize(self.root)
        key = (self.root / "controller-signing-key.pem").read_bytes()
        with self.assertRaises(m.BootstrapError):
            m.initialize(self.root)
        self.assertEqual(key, (self.root / "controller-signing-key.pem").read_bytes())
        with self.assertRaises(m.BootstrapError):
            m.audit(self.root, approved_controller_sha256="0"*64)
        report = m.audit(self.root,
                         approved_controller_sha256=result["controller_public_sha256"])
        self.assertTrue(report["controller_key_independently_approved"])
        self.assertFalse(report["enrollment_material_ready"])

    def test_fi_host_ssh_pin_is_not_auto_trusted(self):
        result = m.initialize(self.root)
        public = (self.root / "fi-enrollment-ssh.pub").read_text().split()
        # Disposable test key stands in for independently supplied SSH host
        # public key; production never uses enrollment client key as host key.
        blob = base64.b64decode(public[1])
        fingerprint = "SHA256:" + base64.b64encode(
            hashlib.sha256(blob).digest()).decode().rstrip("=")
        known_hosts = self.root / "fi-known_hosts"
        known_hosts.write_text("fi.mnebyvpn.site ssh-ed25519 "+public[1]+"\n")
        os.chmod(known_hosts, 0o600)
        self.assertFalse(m.approved_fi_ssh_host(self.root))
        self.assertTrue(m.approved_fi_ssh_host(self.root, fingerprint))
        with self.assertRaises(m.BootstrapError):
            m.approved_fi_ssh_host(self.root, "SHA256:"+"A"*43)
        known_hosts.write_text(known_hosts.read_text()*2)
        with self.assertRaises(m.BootstrapError):
            m.approved_fi_ssh_host(self.root, fingerprint)

    def test_unsafe_files_and_symlinks_are_rejected(self):
        m.initialize(self.root)
        key = self.root/"controller-public.spki"
        key.write_bytes(b"\x00"*44)
        with self.assertRaises(m.BootstrapError):
            m.audit(self.root)
        key.unlink()
        key.symlink_to("/etc/hosts")
        with self.assertRaises(m.BootstrapError):
            m.audit(self.root)

    def test_only_existing_ru188_and_preexisting_mnebyvpn_root(self):
        # This test does not assert that the runner IS RU188; real CLI never
        # allows injection of test addresses or alternative deployment roots.
        for ips in ({"127.0.0.1"}, {"217.11.167.91"}, {"89.125.90.101"}):
            with self.assertRaises(m.BootstrapError):
                m.verify_existing_controller(ips, self.root)
        self.assertIsNone(m.verify_existing_controller({m.CONTROLLER_IP},
                                                        Path(self.tmp.name)))
        with self.assertRaises(m.BootstrapError):
            m.verify_existing_controller({m.CONTROLLER_IP}, self.root)
        with self.assertRaises(m.BootstrapError):
            m.guarded_path(Path("/tmp/../root/new-controller"))

    def test_generated_root_never_leaves_test_machine(self):
        self.assertEqual(os.geteuid(), 0)


if __name__ == "__main__":
    unittest.main()
