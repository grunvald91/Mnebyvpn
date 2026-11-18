#!/usr/bin/env python3
"""Assemble the allowlisted, immutable native-controller188 Node bundle on CI.

Downloads happen outside this script. No private keys, DB credentials,
payment/bot app or broad site build context are included in the bundle.
"""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import os
import tarfile
import tempfile

NODE_SHA="cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8"
NODE_FILE="node-v22.23.5-linux-x64.tar.xz"
MAX_ASSET=200*1024*1024

def bundle(node_archive:Path,root:Path,target:Path)->dict:
    if not node_archive.is_file() or node_archive.name!=NODE_FILE:
        raise ValueError("Wrong pinned Node source")
    if hashlib.sha256(node_archive.read_bytes()).hexdigest()!=NODE_SHA:
        raise ValueError("Official Node 22.23.5 checksum mismatch")
    runtime_files={
      "package.json":root/"package.json",
      "apps/service/src/fi-enrollment-controller.ts":
        root/"apps/service/src/fi-enrollment-controller.ts",
      "apps/service/src/awg-controller-delivery-worker.ts":
        root/"apps/service/src/awg-controller-delivery-worker.ts",
    }
    for folder in ("packages/provisioning/src","node_modules"):
        for file in (root/folder).rglob("*"):
            if file.is_file() and not file.is_symlink():
                runtime_files[file.relative_to(root).as_posix()]=file
    for name in ("runtime-smoke.mjs",
                 "mnebyvpn-controller-runtime-check.service",
                 "mnebyvpn-fi-enrollment.service",
                 "mnebyvpn-awg-delivery.service"):
        runtime_files["ops/controller188-systemd/"+name]=(
            root/"ops/controller188-systemd"/name)
    with tarfile.open(node_archive,"r:xz") as upstream:
        member=upstream.extractfile("node-v22.23.5-linux-x64/bin/node")
        if member is None:raise ValueError("Verified Node ELF missing")
        node=member.read(MAX_ASSET+1)
        if not 0<len(node)<=MAX_ASSET:raise ValueError("Node ELF oversized")
    with tarfile.open(target,"w:gz") as output:
        filedata={"bin/node":node}
        for key,path in runtime_files.items():
            if not path.is_file() or path.is_symlink():
                raise ValueError("Unreviewed build file or symlink")
            if path.stat().st_size>MAX_ASSET:raise ValueError("Oversized build file")
            filedata[key]=path.read_bytes()
        for name,data in sorted(filedata.items()):
            info=tarfile.TarInfo(name)
            info.size=len(data)
            info.mode=0o700 if name=="bin/node" else 0o600
            info.uid=0;info.gid=0;info.uname="root";info.gname="root";info.mtime=0
            from io import BytesIO
            output.addfile(info,BytesIO(data))
    return {"files":len(runtime_files)+1,"archive_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--node-archive",type=Path,required=True)
    ap.add_argument("--source",type=Path,required=True)
    ap.add_argument("--output",type=Path,required=True)
    args=ap.parse_args()
    report=bundle(args.node_archive,args.source,args.output)
    print("CONTROLLER188_BUNDLE_FILES="+str(report["files"]))
    print("CONTROLLER188_BUNDLE_SHA256="+report["archive_sha256"])

if __name__=="__main__":main()
