#!/usr/bin/env python3
"""Local-only key bootstrap for EXISTING MNEBYVPN controller RU188.

No network API, SSH login, DB update, service restart, customer publication or
key export. Requires root, locally assigned 188.120.254.223 and existing
/opt/mnebyvpn. Designed for the production host where node(1) is NOT installed.

Cryptography: OpenSSL Ed25519 PKCS8 PEM signer + separate OpenSSH Ed25519
enrollment key. All private material is generated on RU188, root-only.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile

CONTROLLER_IP = "188.120.254.223"
CONTROL_PLANE = Path("/opt/mnebyvpn")
ROOT = Path("/root/mnebyvpn-controller")
IDENTITY = "fi-test-01"
NODE_PIN = "c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9"
ED25519_SPKI_HEADER = bytes.fromhex("302a300506032b6570032100")
SHA = re.compile(r"[0-9a-f]{64}\Z")
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
FILES = (
    "controller-signing-key.pem",
    "controller-public.spki",
    "fi-enrollment-ssh",
    "fi-enrollment-ssh.pub",
    "bootstrap-manifest.json",
)


class BootstrapError(ValueError):
    pass


def command(argv: list[str], timeout: int = 15) -> bytes:
    # Never let OpenSSL/SSH stderr or private key bytes enter CI/job output.
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=timeout,
                                check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BootstrapError("Required local cryptographic utility unavailable") from exc
    if result.returncode:
        raise BootstrapError("Local key generation or verification failed")
    return result.stdout


def root_directory(path: Path, private: bool = False) -> None:
    try:
        st = path.lstat()
    except OSError as exc:
        raise BootstrapError("Missing trusted controller directory") from exc
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or
            st.st_mode & (0o077 if private else 0o022)):
        raise BootstrapError("Untrusted controller directory permissions")


def guarded_path(path: Path, existing: bool = False) -> None:
    value = str(path)
    if (not value.startswith("/") or "\x00" in value or "\n" in value or
            os.path.normpath(value) != value or value == "/" or len(value) > 1024):
        raise BootstrapError("Invalid absolute trust root")
    parent = path.parent
    while True:
        root_directory(parent)
        if parent == Path("/"):
            break
        parent = parent.parent
    if existing:
        root_directory(path, private=True)
    elif path.exists() or path.is_symlink():
        raise BootstrapError("Existing signing material cannot be overwritten")


def protected_read(path: Path, maximum: int) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as exc:
        raise BootstrapError("Missing protected controller asset") from exc
    try:
        meta = os.fstat(fd)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or
                meta.st_mode & 0o077 or not 1 <= meta.st_size <= maximum):
            raise BootstrapError("Unsafe protected controller asset")
        out = os.read(fd, maximum + 1)
        if len(out) != meta.st_size:
            raise BootstrapError("Controller asset changed during read")
        return out
    finally:
        os.close(fd)


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def ssh_key_blob(public_line: str) -> bytes:
    fields = public_line.strip().split()
    if len(fields) < 2 or fields[0] != "ssh-ed25519":
        raise BootstrapError("Not an Ed25519 SSH public key")
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise BootstrapError("Noncanonical SSH public key") from exc
    if base64.b64encode(blob).decode() != fields[1]:
        raise BootstrapError("Noncanonical SSH public key")
    if (len(blob) != 51 or blob[:4] != struct.pack(">I", 11) or
            blob[4:15] != b"ssh-ed25519" or
            blob[15:19] != struct.pack(">I", 32)):
        raise BootstrapError("Invalid Ed25519 SSH key structure")
    return blob


def inspect_keys(root: Path) -> str:
    guarded_path(root, existing=True)
    for name in FILES:
        protected_read(root / name, 8192)
    public = protected_read(root / "controller-public.spki", 100)
    if len(public) != 44 or not public.startswith(ED25519_SPKI_HEADER):
        raise BootstrapError("Invalid controller Ed25519 SPKI")
    # Extract public DER from the protected private PEM without exposing it.
    actual = command(["/usr/bin/openssl", "pkey",
                      "-in", str(root / "controller-signing-key.pem"),
                      "-pubout", "-outform", "DER"])
    if public != actual:
        raise BootstrapError("Private signer and public SPKI disagree")
    ssh_private = protected_read(root / "fi-enrollment-ssh", 8192)
    if b"BEGIN OPENSSH PRIVATE KEY" not in ssh_private:
        raise BootstrapError("Invalid private enrollment SSH key")
    ssh_public = protected_read(root / "fi-enrollment-ssh.pub", 512)
    ssh_verified = command(["/usr/bin/ssh-keygen", "-y", "-P", "",
                            "-f", str(root / "fi-enrollment-ssh")])
    if ssh_key_blob(ssh_public.decode()) != ssh_key_blob(ssh_verified.decode()):
        raise BootstrapError("Enrollment SSH public/private key mismatch")
    data = json.loads(protected_read(root / "bootstrap-manifest.json", 4096))
    expected = {
        "schema_version": 1,
        "state": "awaiting_independent_approval",
        "controller_public_sha256": sha(public),
        "fi_node_id": IDENTITY,
        "client_publication": False,
    }
    if data != expected:
        raise BootstrapError("Unexpected bootstrap manifest/approval")
    return sha(public)


def assigned_ipv4_addresses() -> set[str]:
    # Linux SIOCGIFADDR reads assigned interface addresses without reaching
    # an external 'what is my IP' service or trusting an environment override.
    ips = set()
    for _, name in socket.if_nameindex():
        if len(name.encode()) > 15:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            try:
                raw = fcntl.ioctl(s.fileno(), 0x8915,
                                  struct.pack("256s", name.encode()))
                ips.add(socket.inet_ntoa(raw[20:24]))
            except OSError:
                pass
    return ips


def verify_existing_controller(addresses: set[str] | None = None,
                               deployment_root: Path = CONTROL_PLANE) -> None:
    if os.geteuid() != 0:
        raise BootstrapError("RU188 controller must be operated by root")
    if CONTROLLER_IP not in (assigned_ipv4_addresses() if addresses is None else addresses):
        raise BootstrapError("Refusing second controller: RU188 IPv4 is not assigned")
    try:
        st = deployment_root.lstat()
    except OSError as exc:
        raise BootstrapError("Existing MNEBYVPN deployment is missing") from exc
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0:
        raise BootstrapError("Existing RU188 MNEBYVPN deployment is untrusted")


def promote_without_replacement(source: Path, destination: Path) -> None:
    # Linux renameat2 RENAME_NOREPLACE: no TOCTOU replacement of trust roots.
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        func = libc.renameat2
    except AttributeError as exc:
        raise BootstrapError("Atomic no-replace promotion unavailable") from exc
    func.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                     ctypes.c_char_p, ctypes.c_uint)
    func.restype = ctypes.c_int
    if func(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        raise BootstrapError("Controller trust root cannot be replaced")


def initialize(root: Path = ROOT) -> dict:
    # The public CLI calls verify_existing_controller BEFORE initialize.
    guarded_path(root)
    old_umask = os.umask(0o077)
    stage: Path | None = None
    try:
        stage = Path(tempfile.mkdtemp(prefix=".mnebyvpn-controller-stage-",
                                      dir=str(root.parent)))
        os.chmod(stage, 0o700)
        command(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519",
                 "-out", str(stage / "controller-signing-key.pem")])
        command(["/usr/bin/openssl", "pkey",
                 "-in", str(stage / "controller-signing-key.pem"),
                 "-pubout", "-outform", "DER",
                 "-out", str(stage / "controller-public.spki")])
        public = (stage / "controller-public.spki").read_bytes()
        if len(public) != 44 or not public.startswith(ED25519_SPKI_HEADER):
            raise BootstrapError("OpenSSL did not generate Ed25519 identity")
        command(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "",
                 "-C", "nodekit-fi-enrollment-only",
                 "-f", str(stage / "fi-enrollment-ssh")])
        for name in ("controller-signing-key.pem", "controller-public.spki",
                     "fi-enrollment-ssh", "fi-enrollment-ssh.pub"):
            os.chmod(stage / name, 0o600)
        with (stage / "bootstrap-manifest.json").open("x", encoding="utf8") as out:
            json.dump({
                "schema_version": 1,
                "state": "awaiting_independent_approval",
                "controller_public_sha256": sha(public),
                "fi_node_id": IDENTITY,
                "client_publication": False,
            }, out, separators=(",", ":"))
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        if inspect_keys(stage) != sha(public):
            raise BootstrapError("Controller signing key self-check failed")
        guarded_path(root)  # refuse any concurrent bootstrap
        promote_without_replacement(stage, root)
        stage = None
        return {
            "controller_host": CONTROLLER_IP,
            "state": "awaiting_independent_approval",
            "controller_public_sha256": sha(public),
            "controller_key_exported": False,
            "private_key_exported": False,
            "client_publication": False,
            "database_changed": False,
            "services_restarted": False,
        }
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        os.umask(old_umask)


def audit(root: Path = ROOT, approved_controller_sha256: str = "") -> dict:
    actual = inspect_keys(root)
    if approved_controller_sha256:
        if not SHA.fullmatch(approved_controller_sha256) or actual != approved_controller_sha256:
            raise BootstrapError("Controller key differs from independently approved SPKI hash")
    return {
        "controller_host": CONTROLLER_IP,
        "signer_consistent": True,
        "controller_key_independently_approved": bool(approved_controller_sha256),
        "fi_host_key_pinned": (root / "fi-known_hosts").is_file(),
        "fi_node_identity_pinned": (root / "fi-node-public.spki").is_file(),
        "db_enrollment_verified": False,
        "subscriber_publication": False,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("operation", choices=("init", "audit"))
    p.add_argument("--approved-controller-sha256", default="")
    args = p.parse_args()
    try:
        verify_existing_controller()
        if args.operation == "init":
            if args.approved_controller_sha256:
                raise BootstrapError("Cannot approve a signing identity during generation")
            result = initialize()
        else:
            result = audit(approved_controller_sha256=args.approved_controller_sha256)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
        # Fail closed: no private PEM, SSH credentials, DB URLs, env or stdout.
        print("CONTROLLER188_BOOTSTRAP_ERROR=" + type(exc).__name__, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
