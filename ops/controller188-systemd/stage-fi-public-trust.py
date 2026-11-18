#!/usr/bin/env python3
"""Operator-attested, root-only FI *public* trust stage on existing RU188.

No network, SSH login, private-key reads, database writes, enrollment, unit
activation, or subscriber publication. Unlike TOFU, require independent FI
provider-console inspection and a separate root-owned approval artifact.
"""
from __future__ import annotations
import base64
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys

ROOT=Path("/root/mnebyvpn-controller")
HOST="188.120.254.223"
NODE_ID="fi-test-01"
FI_HOST="fi.mnebyvpn.site"
FI_NODE_SHA="c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9"
CONTROLLER_SHA="e4c862bd0171e5be4ae64770a555029e090d3a8fcfa5ef2a82ffb0b798552844"
PREFIX=bytes.fromhex("302a300506032b6570032100")
SSH_FINGERPRINT=re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
DEST_HOST="fi-known_hosts"
DEST_NODE="fi-node-public.spki"

class FiTrustError(ValueError):
    pass

def sha(data:bytes)->str:
    return hashlib.sha256(data).hexdigest()

def root_ancestors(path:Path)->None:
    # Existing host system root path ownership and ancestry is part of trust.
    if not path.is_absolute() or '..' in path.parts:
        raise FiTrustError("Noncanonical protected path")
    at=path.parent
    while True:
        try:s=at.lstat()
        except OSError as exc:raise FiTrustError("Missing protected directory") from exc
        if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:
            raise FiTrustError("Writable or untrusted trust ancestor")
        if at==Path('/'):break
        at=at.parent

def protected_read(path:Path,limit:int)->bytes:
    root_ancestors(path)
    try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    except OSError as exc:raise FiTrustError("Missing or linked protected source") from exc
    try:
        s=os.fstat(fd)
        if (not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or
            s.st_mode&0o077 or not 1<=s.st_size<=limit):
            raise FiTrustError("Untrusted protected source permissions or size")
        data=os.read(fd,limit+1)
        if len(data)!=s.st_size:
            raise FiTrustError("Changed protected source")
        return data
    finally:os.close(fd)

def unique_pairs(pairs):
    out={}
    for k,v in pairs:
        if k in out:raise FiTrustError("Duplicate approval JSON field")
        out[k]=v
    return out

def ssh_host_public(source:bytes)->tuple[bytes,str,str]:
    try:line=source.decode("ascii").strip()
    except UnicodeError as exc:raise FiTrustError("Invalid SSH public encoding") from exc
    parts=line.split()
    if len(parts)<2 or len(parts)>4 or parts[0]!="ssh-ed25519":
        raise FiTrustError("Only provider-console Ed25519 public host key accepted")
    encoded=parts[1]
    if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}",encoded):
        raise FiTrustError("Noncanonical SSH host key")
    try:raw=base64.b64decode(encoded,validate=True)
    except (ValueError,base64.binascii.Error) as exc:
        raise FiTrustError("Invalid SSH host key encoding") from exc
    if (base64.b64encode(raw).decode()!=encoded or len(raw)!=51 or
        raw[:4]!=struct.pack(">I",11) or raw[4:15]!=b"ssh-ed25519" or
        raw[15:19]!=struct.pack(">I",32)):
        raise FiTrustError("Unexpected SSH Ed25519 public key blob")
    fingerprint="SHA256:"+base64.b64encode(
        hashlib.sha256(raw).digest()).decode().rstrip("=")
    return raw,encoded,fingerprint

def assessed_ipv4()->bool:
    for _,name in socket.if_nameindex():
        if len(name.encode())>15:continue
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            try:
                data=fcntl.ioctl(s.fileno(),0x8915,struct.pack("256s",name.encode()))
                if socket.inet_ntoa(data[20:24])==HOST:return True
            except OSError:pass
    return False

def inspect(root:Path=ROOT,*,expected_controller_sha:str=CONTROLLER_SHA,
            expected_fi_node_sha:str=FI_NODE_SHA)->dict:
    # Only public keys; neither controller signer nor enrollment SSH private
    # key is opened by this function.
    manifest=json.loads(protected_read(root/"bootstrap-manifest.json",4096),
                        object_pairs_hook=unique_pairs)
    controller=protected_read(root/"controller-public.spki",100)
    if (len(controller)!=44 or controller[:12]!=PREFIX or
        sha(controller)!=expected_controller_sha or
        manifest.get("controller_public_sha256")!=expected_controller_sha or
        manifest.get("state")!="awaiting_independent_approval" or
        manifest.get("client_publication") is not False):
        raise FiTrustError("Controller root is not the reviewed identity")
    approval=json.loads(protected_read(root/"approvals/fi-trust-reviewed.json",4096),
                        object_pairs_hook=unique_pairs)
    expected_keys={"schema_version","node_id","controller_public_sha256",
                   "fi_identity_spki_sha256","fi_ssh_host_sha256",
                   "reviewed_via","operator_approved"}
    if (set(approval)!=expected_keys or approval["schema_version"]!=1 or
        approval["node_id"]!=NODE_ID or
        approval["controller_public_sha256"]!=expected_controller_sha or
        approval["fi_identity_spki_sha256"]!=expected_fi_node_sha or
        approval["reviewed_via"]!="provider_console" or
        approval["operator_approved"] is not True):
        raise FiTrustError("FI independent provider-console approval required")
    expected_host=approval["fi_ssh_host_sha256"]
    if not isinstance(expected_host,str) or not SSH_FINGERPRINT.fullmatch(expected_host):
        raise FiTrustError("Missing independent FI host fingerprint")
    _,encoded,actual_host=ssh_host_public(protected_read(root/"inbox/fi-host-ed25519.pub",512))
    if actual_host!=expected_host:
        raise FiTrustError("SSH host key does not match independent provider-console approval")
    fi_public=protected_read(root/"inbox/fi-node-public.spki",100)
    if (len(fi_public)!=44 or fi_public[:12]!=PREFIX or
        sha(fi_public)!=expected_fi_node_sha):
        raise FiTrustError("FI public node identity does not match existing approved pin")
    return {
        "known_hosts":(FI_HOST+" ssh-ed25519 "+encoded+"\n").encode("ascii"),
        "node_public_spki":fi_public,
        "fi_node_sha256":sha(fi_public),
        "fi_host_fingerprint":actual_host,
        "controller_public_sha256":sha(controller),
    }

def stage(root:Path=ROOT,*,expected_controller_sha:str=CONTROLLER_SHA,
          expected_fi_node_sha:str=FI_NODE_SHA)->dict:
    approved=inspect(root,expected_controller_sha=expected_controller_sha,
                     expected_fi_node_sha=expected_fi_node_sha)
    if root==ROOT:
        if os.geteuid()!=0 or not assessed_ipv4():
            raise FiTrustError("Only existing RU188 can stage public trust")
    for target in (root/DEST_HOST,root/DEST_NODE):
        root_ancestors(target)
        if target.exists() or target.is_symlink():
            raise FiTrustError("Existing trust must never be replaced")
    completed=[]
    try:
        for name,data in ((DEST_HOST,approved["known_hosts"]),
                          (DEST_NODE,approved["node_public_spki"])):
            target=root/name
            fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            completed.append(target)
            try:
                os.write(fd,data)
                os.fsync(fd)
            finally:os.close(fd)
        return {"node_id":NODE_ID,"controller_host":HOST,
                "fi_public_trust_staged":True,"node_enrolled":False,
                "db_modified":False,"services_started":False,
                "subscriber_publication":False}
    except Exception:
        for target in completed:
            try:target.unlink()
            except OSError:pass
        raise

def main()->int:
    import argparse
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("command",choices=("check","stage"))
    args=p.parse_args()
    try:
        if os.geteuid()!=0 or not assessed_ipv4():
            raise FiTrustError("Only trusted existing controller188 may inspect FI approval")
        if args.command=="check":
            out=inspect()
            print(json.dumps({"fi_identity_matches_pin":True,
                "fi_host_fingerprint_matches_operator_approval":True,
                "public_files_will_be_staged_only":True,"db_modified":False,
                "enrollment_executed":False},sort_keys=True))
        else:
            print(json.dumps(stage(),sort_keys=True))
        return 0
    except (OSError,TypeError,ValueError) as exc:
        # All sensitive details stay local; never print full approver artifacts.
        print("FI_PUBLIC_TRUST_STAGE_STOPPED",file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
