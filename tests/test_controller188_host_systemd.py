import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

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


if __name__=="__main__":
    unittest.main()
