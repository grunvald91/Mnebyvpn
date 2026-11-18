import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BASE=Path(__file__).resolve().parents[1]
SCRIPT=BASE/"ops/controller188-systemd/stage-fi-public-trust.py"
spec=importlib.util.spec_from_file_location("fi_public_trust",SCRIPT)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def sha(v):
    return hashlib.sha256(v).hexdigest()

class FiIndependentTrustStage(unittest.TestCase):
    def setUp(self):
        if os.geteuid()!=0:self.skipTest("requires disposable root-only fixture")
        self.base=Path(tempfile.mkdtemp(prefix="fi-trust-unit-",dir="/root"))
        self.addCleanup(lambda:shutil.rmtree(self.base,ignore_errors=True))
        (self.base/"inbox").mkdir(mode=0o700)
        (self.base/"approvals").mkdir(mode=0o700)
        self.controller=m.PREFIX+os.urandom(32)
        self.fi_identity=m.PREFIX+os.urandom(32)
        self.controller_sha=sha(self.controller)
        self.fi_sha=sha(self.fi_identity)
        self.write("controller-public.spki",self.controller)
        self.write("inbox/fi-node-public.spki",self.fi_identity)
        self.write("bootstrap-manifest.json",json.dumps({
            "schema_version":1,"state":"awaiting_independent_approval",
            "controller_public_sha256":self.controller_sha,
            "fi_node_id":"fi-test-01","client_publication":False
        }).encode())
        key=self.base/"test_host_ssh"
        subprocess.run(["ssh-keygen","-q","-t","ed25519","-N","","-f",str(key)],
                       check=True,capture_output=True)
        ssh=key.with_suffix(".pub").read_bytes()
        self.write("inbox/fi-host-ed25519.pub",ssh)
        _,_,self.fingerprint=m.ssh_host_public(ssh)
        self.write_approval(True)

    def write(self,name,data):
        p=self.base/name
        p.write_bytes(data)
        os.chmod(p,0o600)

    def write_approval(self,approved):
        self.write("approvals/fi-trust-reviewed.json",json.dumps({
            "schema_version":1,"node_id":"fi-test-01",
            "controller_public_sha256":self.controller_sha,
            "fi_identity_spki_sha256":self.fi_sha,
            "fi_ssh_host_sha256":self.fingerprint,
            "reviewed_via":"provider_console",
            "operator_approved":approved
        }).encode())

    def check(self):
        return m.inspect(self.base,expected_controller_sha=self.controller_sha,
                         expected_fi_node_sha=self.fi_sha)

    def stage(self):
        return m.stage(self.base,expected_controller_sha=self.controller_sha,
                       expected_fi_node_sha=self.fi_sha)

    def test_valid_independent_approval_only_stages_public_files(self):
        x=self.check()
        self.assertEqual(x["fi_host_fingerprint"],self.fingerprint)
        report=self.stage()
        self.assertEqual(report["node_id"],"fi-test-01")
        self.assertFalse(report["node_enrolled"])
        self.assertFalse(report["db_modified"])
        self.assertFalse(report["services_started"])
        self.assertFalse(report["subscriber_publication"])
        known=(self.base/"fi-known_hosts").read_text()
        self.assertTrue(known.startswith("fi.mnebyvpn.site ssh-ed25519 "))
        self.assertEqual((self.base/"fi-node-public.spki").read_bytes(),self.fi_identity)
        for name in (m.DEST_HOST,m.DEST_NODE):
            p=self.base/name
            self.assertEqual(p.stat().st_mode&0o077,0)
            self.assertEqual(p.stat().st_uid,0)
        with self.assertRaisesRegex(m.FiTrustError,"never be replaced"):
            self.stage()

    def test_no_approval_or_wrong_provenance_or_mismatched_key_fail_closed(self):
        (self.base/"approvals/fi-trust-reviewed.json").unlink()
        with self.assertRaises(m.FiTrustError):
            self.check()
        self.write_approval(False)
        with self.assertRaisesRegex(m.FiTrustError,"approval required"):
            self.check()
        self.write_approval(True)
        with self.assertRaises(m.FiTrustError):
            m.inspect(self.base,expected_controller_sha="a"*64,
                      expected_fi_node_sha=self.fi_sha)
        self.write("inbox/fi-node-public.spki",m.PREFIX+os.urandom(32))
        with self.assertRaisesRegex(m.FiTrustError,"does not match"):
            self.check()
        self.assertFalse((self.base/"fi-known_hosts").exists())

    def test_rejects_symlink_and_duplicate_json_approval(self):
        approval=self.base/"approvals/fi-trust-reviewed.json"
        approval.unlink()
        approval.symlink_to("/etc/passwd")
        with self.assertRaises(m.FiTrustError):
            self.check()
        approval.unlink()
        self.write("approvals/fi-trust-reviewed.json",
                   b'{"schema_version":1,"schema_version":1}')
        with self.assertRaisesRegex(m.FiTrustError,"Duplicate"):
            self.check()

    def test_second_file_creation_failure_rolls_back_first(self):
        actual_open=m.os.open
        final_path=self.base/m.DEST_NODE
        def injection(path,*args,**kwargs):
            if Path(path)==final_path:raise OSError("injected second-file error")
            return actual_open(path,*args,**kwargs)
        with patch.object(m.os,"open",side_effect=injection):
            with self.assertRaises(OSError):
                self.stage()
        self.assertFalse((self.base/m.DEST_HOST).exists())
        self.assertFalse(final_path.exists())

    def test_rejects_ssh_key_type_swap(self):
        data=(self.base/"inbox/fi-host-ed25519.pub").read_bytes()
        self.write("inbox/fi-host-ed25519.pub",data.replace(b"ssh-ed25519",b"ssh-rsa"))
        with self.assertRaisesRegex(m.FiTrustError,"Ed25519"):
            self.check()

if __name__=="__main__":
    unittest.main()
