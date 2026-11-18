import importlib.util
import hashlib
import io
import os
import shutil
import uuid
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack

BASE=Path(__file__).resolve().parents[1]
SCRIPT=BASE/"ops/controller188-systemd/install-runtime.py"
spec=importlib.util.spec_from_file_location("controller188_host_systemd_install",SCRIPT)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class HostSystemdInstaller(unittest.TestCase):
    def test_reject_path_escape_and_special_files(self):
        for name in (
            "/etc/passwd","../etc/passwd","apps/service/src/../../etc/passwd",
            "scripts/worker.sh","/root/secret","-options",
            "ops/controller188-systemd/../secret",
        ):
            with self.subTest(name=name):
                info=tarfile.TarInfo(name)
                info.size=1
                with self.assertRaises(m.RuntimeInstallError):
                    m.safe_member(info)
        for type_ in (tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.DIRTYPE):
            info=tarfile.TarInfo("bin/node")
            info.type=type_
            with self.assertRaises(m.RuntimeInstallError):
                m.safe_member(info)

    def test_only_signed_release_tree_files_allowed(self):
        for name in (
            "package.json","bin/node","node_modules/pg/package.json",
            "apps/service/src/fi-enrollment-controller.ts",
            "packages/provisioning/src/node-enrollment.ts",
            "ops/controller188-systemd/mnebyvpn-fi-enrollment.service",
        ):
            info=tarfile.TarInfo(name)
            info.size=5
            self.assertIsNone(m.safe_member(info))

    def test_cannot_run_on_non188_or_untrusted_controller(self):
        with patch.object(m.os,"geteuid",return_value=0), \
             patch.object(m,"has_assigned_ip",return_value=False):
            with self.assertRaisesRegex(m.RuntimeInstallError,"188"):
                m.require_real_188()
        with patch.object(m.os,"geteuid",return_value=1000), \
             patch.object(m,"has_assigned_ip",return_value=True):
            with self.assertRaisesRegex(m.RuntimeInstallError,"root"):
                m.require_real_188()

    def test_unapproved_units_are_permanently_gated(self):
        directory=BASE/"ops/controller188-systemd"
        fi=(directory/"mnebyvpn-fi-enrollment.service").read_text()
        awg=(directory/"mnebyvpn-awg-delivery.service").read_text()
        smoke=(directory/"mnebyvpn-controller-runtime-check.service").read_text()
        for unit in (fi,awg):
            self.assertIn("User=root",unit)
            self.assertIn("ProtectSystem=strict",unit)
            self.assertIn("NoNewPrivileges=yes",unit)
            self.assertIn("CapabilityBoundingSet=",unit)
            self.assertIn("IPAddressDeny=any",unit)
            self.assertIn("IPAddressAllow=217.11.167.91/32",unit)
            self.assertNotIn("[Install]",unit)
            self.assertNotIn("ExecStartPre=/bin/sh",unit)
        self.assertIn("fi-enrollment.enable",fi)
        self.assertIn("fi-enrollment.env",fi)
        self.assertIn("awg-delivery.enable",awg)
        self.assertIn("awg-delivery.env",awg)
        self.assertIn("PrivateNetwork=yes",smoke)
        self.assertNotIn("IPAddressAllow=217.11.167.91",smoke)
        self.assertNotIn("[Install]",smoke)

    def test_installer_never_restarts_production_or_generates_keys(self):
        content=SCRIPT.read_text()
        self.assertNotIn("docker restart",content)
        self.assertNotIn("systemctl enable",content)
        self.assertNotIn("genpkey",content)
        self.assertNotIn("ssh-keygen",content)
        self.assertIn('"mnebyvpn-controller-runtime-check.service"',content)
        self.assertIn('"fi_enrollment_enabled":False',content)
        self.assertIn('"awg_delivery_enabled":False',content)



class HostSystemdRollback(unittest.TestCase):
    """Disposable root-owned /run tar and /root targets, never the real host."""
    def setUp(self):
        if os.geteuid()!=0:
            self.skipTest("root required for protected production-like fixtures")
        self.home=Path(tempfile.mkdtemp(prefix="mnebyvpn-install-test-",dir="/root"))
        self.units=self.home/"systemd"
        self.units.mkdir(mode=0o700)
        self.base=self.home/"new-runtime"
        self.releases=self.base/"releases"
        self.current=self.base/"current"
        self.commit="1"*40
        self.archive=Path("/run/mnebyvpn-controller-release-"+uuid.uuid4().hex+".tar.gz")
        required=["bin/node","package.json",
                  "apps/service/src/fi-enrollment-controller.ts",
                  "apps/service/src/awg-controller-delivery-worker.ts",
                  "ops/controller188-systemd/runtime-smoke.mjs",
                  *("ops/controller188-systemd/"+x for x in m.UNITS)]
        with tarfile.open(self.archive,"w:gz") as out:
            for name in required:
                data=b"reviewed test runtime asset"
                item=tarfile.TarInfo(name)
                item.size=len(data)
                with io.BytesIO(data) as source:out.addfile(item,source)
        os.chmod(self.archive,0o600)
        self.digest=hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.patchers=ExitStack()
        self.patchers.enter_context(patch.object(m,"BASE",self.base))
        self.patchers.enter_context(patch.object(m,"RELEASES",self.releases))
        self.patchers.enter_context(patch.object(m,"CURRENT",self.current))
        self.patchers.enter_context(patch.object(m,"UNITDIR",self.units))
        self.patchers.enter_context(patch.object(m,"UNIT_SEARCH_DIRS",(self.units,)))
        self.addCleanup(self.clean)

    def clean(self):
        self.patchers.close()
        self.archive.unlink(missing_ok=True)
        shutil.rmtree(self.home,ignore_errors=True)

    def fake_run(self,*args):
        if args[-1]=="-v":return "v22.23.5"
        if "start" in args:raise m.RuntimeInstallError("injected systemd failure")
        return ""

    def test_symlink_creation_failure_does_not_leave_orphan_release(self):
        with patch.object(m,"run",side_effect=self.fake_run), \
             patch.object(Path,"symlink_to",side_effect=OSError("test symlink failure")):
            with self.assertRaises(OSError):
                m.stage(self.archive,self.digest,self.commit)
        self.assertFalse((self.releases/self.commit).exists())
        self.assertFalse(self.current.is_symlink())
        self.assertTrue(all(not (self.units/u).exists() for u in m.UNITS))

    def test_systemd_smoke_failure_removes_only_new_units_and_runtime(self):
        with patch.object(m,"run",side_effect=self.fake_run):
            with self.assertRaises(m.RuntimeInstallError):
                m.stage(self.archive,self.digest,self.commit)
        self.assertFalse((self.releases/self.commit).exists())
        self.assertFalse(self.current.is_symlink())
        self.assertTrue(all(not (self.units/u).exists() for u in m.UNITS))

    def test_existing_drop_in_is_not_overwritten_or_ignored(self):
        (self.units/(m.UNITS[1]+".d")).mkdir()
        with patch.object(m,"run",side_effect=self.fake_run):
            with self.assertRaisesRegex(m.RuntimeInstallError,"drop-in"):
                m.stage(self.archive,self.digest,self.commit)
        self.assertTrue((self.units/(m.UNITS[1]+".d")).is_dir())
        self.assertFalse(self.current.is_symlink())
        self.assertFalse((self.releases/self.commit).exists())

    def test_runtime_bundle_rejects_extra_parent_or_symlink_path(self):
        good_digest=self.digest
        with patch.object(m,"run",side_effect=self.fake_run):
            with self.assertRaises(m.RuntimeInstallError):
                m.stage(self.archive.parent/".." / self.archive.name,good_digest,self.commit)
        link=self.home/"linked-artifact.tar.gz"
        link.symlink_to(self.archive)
        with patch.object(m,"run",side_effect=self.fake_run):
            with self.assertRaises(m.RuntimeInstallError):
                m.stage(link,good_digest,self.commit)

if __name__=="__main__":
    unittest.main()
