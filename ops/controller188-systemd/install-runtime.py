#!/usr/bin/env python3
"""Stage an independently checked, nonnetworked controller188 host runtime.

One-shot: install a private Node 22 runtime and systemd unit files on EXISTING
188 only. Never start FI enrollment or AWG delivery, never install OS packages,
never read private signing material, never touch the website or Telegram proxy.
"""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import os
from pathlib import Path, PurePosixPath
import socket
import fcntl
import struct
import stat
import subprocess
import sys
import tarfile
import tempfile
import shutil

HOST="188.120.254.223"
BASE=Path("/opt/mnebyvpn-controller")
RELEASES=BASE/"releases"
CURRENT=BASE/"current"
KEYROOT=Path("/root/mnebyvpn-controller")
UNITS=("mnebyvpn-controller-runtime-check.service",
       "mnebyvpn-fi-enrollment.service",
       "mnebyvpn-awg-delivery.service")
UNITDIR=Path("/etc/systemd/system")
SOURCE=Path("/opt/mnebyvpn")
MAX_FILES=5000
MAX_BYTES=300*1024*1024

class RuntimeInstallError(ValueError):
    pass

def run(*cmd):
    p=subprocess.run(cmd,capture_output=True,text=True,timeout=40)
    if p.returncode!=0:
        raise RuntimeInstallError("Verified runtime command failed")
    return p.stdout.strip()

def has_assigned_ip():
    for _,name in socket.if_nameindex():
        if len(name.encode())>15:continue
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            try:
                data=fcntl.ioctl(s.fileno(),0x8915,struct.pack("256s",name.encode()))
                if socket.inet_ntoa(data[20:24])==HOST:return True
            except OSError:pass
    return False

def root_dir(path,private=False):
    try:meta=path.lstat()
    except OSError as e:raise RuntimeInstallError("Required root-only directory missing") from e
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid!=0 or meta.st_mode&(0o077 if private else 0o022):
        raise RuntimeInstallError("Untrusted host directory")

def require_real_188():
    if os.geteuid()!=0 or not has_assigned_ip():
        raise RuntimeInstallError("Refusing new controller: must run as root on 188")
    root_dir(SOURCE)
    root_dir(KEYROOT,private=True)
    if not (KEYROOT/"bootstrap-manifest.json").is_file():
        raise RuntimeInstallError("Existing protected controller key stage absent")
    if os.uname().machine!="x86_64":
        raise RuntimeInstallError("Unsupported controller architecture")
    for name in UNITS:
        if (UNITDIR/name).exists() or (UNITDIR/name).is_symlink():
            raise RuntimeInstallError("Refusing to replace any existing systemd unit")

def safe_member(member):
    p=PurePosixPath(member.name)
    if (not member.isfile() or member.issym() or member.islnk() or
        not member.name or p.is_absolute() or any(x in (".","..") for x in p.parts) or
        member.name.startswith("-") or "\x00" in member.name):
        raise RuntimeInstallError("Unsafe runtime archive entry")
    if not (member.name=="package.json" or member.name=="bin/node" or
            member.name.startswith("node_modules/") or
            member.name.startswith("apps/service/src/") or
            member.name.startswith("packages/provisioning/src/") or
            member.name.startswith("ops/controller188-systemd/")):
        raise RuntimeInstallError("Unexpected runtime artifact path")

def stage(archive:Path,digest:str,commit:str):
    if (len(digest)!=64 or any(c not in "0123456789abcdef" for c in digest) or
        len(commit)!=40 or any(c not in "0123456789abcdef" for c in commit)):
        raise RuntimeInstallError("Immutable commit and bundle digest required")
    if (not str(archive).startswith("/run/mnebyvpn-controller-release-") or
        archive.suffix!=".gz"):
        raise RuntimeInstallError("Only protected /run bundle accepted")
    root_dir(archive.parent)
    meta=archive.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid!=0 or meta.st_mode&0o077:
        raise RuntimeInstallError("Unprotected runtime bundle")
    h=hashlib.sha256()
    with archive.open("rb") as f:
        while chunk:=f.read(1024*1024):h.update(chunk)
    if h.hexdigest()!=digest:
        raise RuntimeInstallError("Runtime artifact digest mismatch")
    if BASE.exists() or BASE.is_symlink():
        root_dir(BASE,private=True)
    else:
        os.mkdir(BASE,0o700)
    if RELEASES.exists() or RELEASES.is_symlink():
        root_dir(RELEASES,private=True)
    else:
        os.mkdir(RELEASES,0o700)
    if CURRENT.exists() or CURRENT.is_symlink() or (RELEASES/commit).exists():
        raise RuntimeInstallError("Existing controller runtime cannot be overwritten")
    stagepath=Path(tempfile.mkdtemp(prefix=".stage-",dir=str(RELEASES)))
    try:
        names=set()
        size=0
        with tarfile.open(archive,"r:gz") as tar:
            for member in tar:
                safe_member(member)
                if member.name in names or len(names)>=MAX_FILES:
                    raise RuntimeInstallError("Duplicate/oversized runtime archive")
                names.add(member.name)
                size+=member.size
                if size>MAX_BYTES:raise RuntimeInstallError("Runtime unpack limit exceeded")
                dest=stagepath.joinpath(*PurePosixPath(member.name).parts)
                dest.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                f=tar.extractfile(member)
                if f is None:raise RuntimeInstallError("Unreadable runtime archive")
                fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                try:
                    with os.fdopen(fd,"wb") as out:shutil.copyfileobj(f,out)
                finally:f.close()
        for required in ("bin/node","package.json",
            "apps/service/src/fi-enrollment-controller.ts",
            "apps/service/src/awg-controller-delivery-worker.ts",
            "ops/controller188-systemd/runtime-smoke.mjs",
            *("ops/controller188-systemd/"+name for name in UNITS)):
            if required not in names:
                raise RuntimeInstallError("Controller runtime module or unit missing")
        (stagepath/"bin/node").chmod(0o700)
        if run(str(stagepath/"bin/node"),"-v")!="v22.16.0":
            raise RuntimeInstallError("Node runtime version mismatch")
        # No production DB/keys, no service start during module validation.
        run(str(stagepath/"bin/node"),"--experimental-strip-types",
            "--check",str(stagepath/"ops/controller188-systemd/runtime-smoke.mjs"))
        target=RELEASES/commit
        if target.exists() or target.is_symlink():
            raise RuntimeInstallError("Runtime commit already present")
        os.rename(stagepath,target)
        stagepath=None
        # The initial deployment never retargets an existing symlink.
        CURRENT.symlink_to(target,target_is_directory=True)
        for name in UNITS:
            src=target/"ops/controller188-systemd"/name
            fd=os.open(UNITDIR/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
            with os.fdopen(fd,"wb") as out:out.write(src.read_bytes())
        run("/usr/bin/systemctl","daemon-reload")
        run("/usr/bin/systemctl","start","mnebyvpn-controller-runtime-check.service")
        # The two production units remain disabled, inactive and unapproved.
        for name in UNITS[1:]:
            result=subprocess.run(["/usr/bin/systemctl","is-active","--quiet",name],
                                  timeout=8)
            if result.returncode==0:
                raise RuntimeInstallError("Unexpected active production controller worker")
        return {"controller":"188.120.254.223","runtime":"v22.16.0",
                "runtime_smoke":"passed","fi_enrollment_enabled":False,
                "awg_delivery_enabled":False,"existing_services_restarted":False,
                "subscriber_publication":False}
    finally:
        if stagepath and stagepath.exists():shutil.rmtree(stagepath)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bundle",type=Path,required=True)
    p.add_argument("--sha256",required=True)
    p.add_argument("--commit",required=True)
    a=p.parse_args()
    try:
        require_real_188()
        os.umask(0o077)
        result=stage(a.bundle,a.sha256,a.commit)
        import json
        print("CONTROLLER188_SYSTEMD_STAGE="+json.dumps(result,sort_keys=True))
        return 0
    except (OSError,ValueError,subprocess.SubprocessError,tarfile.TarError):
        print("CONTROLLER188_SYSTEMD_STAGE_STOPPED",file=sys.stderr)
        return 2

if __name__=="__main__":raise SystemExit(main())
