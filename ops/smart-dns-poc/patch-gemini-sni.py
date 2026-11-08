#!/usr/bin/env python3
"""Add exactly one Gemini route to a copy of the existing 443 SNI map.

Does not write to a live Nginx file; the deploy workflow must independently
backup the original, validate nginx -t, check website/VPN canaries and rollback.
"""
from __future__ import annotations
import pathlib
import re
import sys

MAP = re.compile(
    r'(map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{)'
    r'([^{}]*)(\})', re.S
)
GEMINI = '    gemini.google.com 127.0.0.1:15443;'

def patch(source:str)->str:
    entries=list(MAP.finditer(source))
    if len(entries)!=1:
        raise ValueError('Expected exactly one original shared 443 SNI map')
    part=entries[0]
    body=part.group(2)
    old_lines=[
        line.strip() for line in body.splitlines()
        if line.strip() and not line.lstrip().startswith('#')
    ]
    if len(old_lines)<20:
        raise ValueError('Unexpectedly small existing SNI map')
    if not any(re.fullmatch(r'default\s+[^;]+;',line) for line in old_lines):
        raise ValueError('Existing default route is missing')
    if any('gemini.google.com' in line for line in old_lines):
        raise ValueError('Gemini route already exists; refusing to overwrite')
    if GEMINI.strip() in source:
        raise ValueError('Gemini route outside expected map')
    # Insert just after the opening brace; byte-for-byte keep all previous routes.
    replacement=part.group(1)+'\n'+GEMINI+part.group(2)+part.group(3)
    result=source[:part.start()]+replacement+source[part.end():]
    if result.replace('\n'+GEMINI,'',1)!=source:
        raise ValueError('Unexpected content change in shared map')
    return result

def main():
    if len(sys.argv)!=3:
        raise SystemExit('usage: patch-gemini-sni.py INPUT EXISTING_PARENT_NEW_FILE')
    src=pathlib.Path(sys.argv[1])
    dst=pathlib.Path(sys.argv[2])
    if not src.is_file() or dst.exists() or src.resolve()==dst.resolve():
        raise SystemExit('input missing or output already exists')
    value=patch(src.read_text(encoding='utf-8'))
    with dst.open('x',encoding='utf-8') as f:
        f.write(value)
    dst.chmod(src.stat().st_mode & 0o777)
    print('gemini_exact_443_map_staged=yes')
    print('all_existing_sni_routes_preserved=yes')

if __name__=='__main__':main()
