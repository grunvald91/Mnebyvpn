#!/usr/bin/env python3
"""Read-only comparison of LIVE MNEBYDNS Google/Gemini/Android DNS policy.

This is NOT an Android-app test. It verifies only server-side DoT records
with strict TLS certificate validation and reports when a verified Google
host still resolves to its normal destination rather than foreign ingress.
No credentials, account identifiers, HTTP requests or client IPs are logged.
"""
from __future__ import annotations
import importlib.util
import pathlib
import socket
import sys

HERE = pathlib.Path(__file__).resolve().parent
probe_spec = importlib.util.spec_from_file_location(
    "dns_probe", HERE / "probe-gemini-canary.py"
)
assert probe_spec and probe_spec.loader
PROBE = importlib.util.module_from_spec(probe_spec)
probe_spec.loader.exec_module(PROBE)

# Official Google Workspace Gemini firewall list (2026-10-26).
# https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/gemini-app-firewall-settings
GEMINI_HOSTS = (
    "lh5.googleusercontent.com", "www.googleapis.com", "ssl.gstatic.com",
    "fonts.googleapis.com", "play.google.com", "ogs.google.com",
    "www.google.com", "apis.google.com", "jnn-pa.googleapis.com",
    "waa-pa.clients6.google.com", "i.ytimg.com", "yt3.ggpht.com",
    "lh3.googleusercontent.com", "maps.gstatic.com", "lh3.google.com",
    "ogads-pa.clients6.google.com", "csp.withgoogle.com",
    "www.googletagmanager.com", "www.youtube.com", "fonts.gstatic.com",
    "maps.googleapis.com", "static.doubleclick.net", "www.gstatic.com",
    "gemini.google.com", "td.doubleclick.net", "googleads.g.doubleclick.net",
    "www.google-analytics.com", "optimizationguide-pa.googleapis.com",
    "encrypted-tbn0.gstatic.com", "encrypted-tbn1.gstatic.com",
    "encrypted-tbn2.gstatic.com", "encrypted-tbn3.gstatic.com",
    "streetviewpixels-pa.googleapis.com", "content-autofill.googleapis.com",
)

# Android networking / push paths per Google's Android Enterprise/FCM docs.
# Some services use TCP 5228-5230, UDP, or their own transport instead of
# 443/TCP; DNS A rewriting alone cannot carry those connections.
# https://firebase.google.com/docs/cloud-messaging/network-configuration
# https://support.google.com/work/android/answer/10513641
ANDROID_SYSTEM_HOSTS = (
    "mtalk.google.com", "mtalk4.google.com", "time.google.com",
    "fcm.googleapis.com", "fcm-xmpp.googleapis.com",
    "firebaseinstallations.googleapis.com", "gcm-http.googleapis.com",
    "gcm-xmpp.googleapis.com", "android.googleapis.com",
    "pki.google.com", "clients1.google.com", "notifications.google.com",
)
# Google-owned entry points and representative subservices for three
# products the operator explicitly used during the 90-second VPN trace.
# These are read-only DNS hypotheses; no traffic identity is proven.
# YouTube: https://support.google.com/youtube/answer/171780
# Stitch: https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-gemini-3/
# AI Studio: https://ai.google.dev/aistudio
# Static / account services: https://docs.cloud.google.com/docs/get-started/required-domains
YOUTUBE_HOSTS = (
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "youtu.be", "youtubei.googleapis.com", "i.ytimg.com",
    "s.ytimg.com", "yt3.ggpht.com", "accounts.youtube.com",
    "www.youtube-nocookie.com",
)
STITCH_HOSTS = (
    "stitch.withgoogle.com", "accounts.google.com",
    "www.gstatic.com", "ssl.gstatic.com", "fonts.gstatic.com",
    "fonts.googleapis.com",
)
AI_STUDIO_HOSTS = (
    "aistudio.google.com", "generativelanguage.googleapis.com",
    "accounts.google.com", "oauth2.googleapis.com",
    "www.gstatic.com", "ssl.gstatic.com",
)
# Video CDN origins are dynamic; checking an arbitrary single googlevideo.com
# hostname would NOT audit *.googlevideo.com. Wildcard policy must be tested
# separately and is not enabled by this script.
DYNAMIC_VIDEO_SUFFIXES_NOT_VERIFIED = (
    "googlevideo.com", "ytimg.com", "ggpht.com",
)

EXISTING_CONTROLS = ("discord.com", "gateway.discord.gg", "cdn.discordapp.com")
PRIVATE_DNS_NAME = "dns.mnebyvpn.site"
FOREIGN_INGRESS = "89.125.90.101"
PORT = 853


def classify(answer_a: tuple, answer_aaaa: tuple) -> str:
    """Fail closed: neither SERVFAIL nor NXDOMAIN means 'direct'."""
    acode, _acount, arows = answer_a
    bcode, _bcount, brows = answer_aaaa
    if acode not in (0,) or bcode not in (0,):
        return "DNS_ERROR_OR_NONEXISTENT"
    ipv4 = []
    ipv6 = []
    for kind, _ttl, data in arows:
        if kind == 1:
            if len(data) != 4:
                return "INVALID_A"
            ipv4.append(socket.inet_ntoa(data))
    for kind, _ttl, data in brows:
        if kind == 28:
            if len(data) != 16:
                return "INVALID_AAAA"
            ipv6.append(socket.inet_ntop(socket.AF_INET6, data))
    if ipv4 == [FOREIGN_INGRESS] and not ipv6:
        return "FOREIGN_HTTPS_INGRESS"
    if FOREIGN_INGRESS in ipv4:
        return "MIXED_INGRESS_UNSAFE"
    if not ipv4 and not ipv6:
        return "NO_ADDRESS"
    return "NON_SYNTHETIC_OR_IPV6"


def inspect(name: str) -> str:
    try:
        answers = (
            PROBE.query(name, 1, FOREIGN_INGRESS, PORT, PRIVATE_DNS_NAME, None),
            PROBE.query(name, 28, FOREIGN_INGRESS, PORT, PRIVATE_DNS_NAME, None),
        )
        return classify(*answers)
    except (OSError, AssertionError, ValueError, TimeoutError):
        return "TRANSPORT_FAILURE"


def main() -> None:
    seen = {}
    for label, names in (
        ("gemini", GEMINI_HOSTS), ("android", ANDROID_SYSTEM_HOSTS),
        ("youtube", YOUTUBE_HOSTS), ("stitch", STITCH_HOSTS),
        ("aistudio", AI_STUDIO_HOSTS),
        ("existing_control", EXISTING_CONTROLS),
    ):
        for name in names:
            if name in seen:
                continue
            state = inspect(name)
            seen[name] = state
            print(f"live_DoT_{label}={name} route={state}", flush=True)
    root=seen["gemini.google.com"]
    if root != "FOREIGN_HTTPS_INGRESS":
        raise AssertionError("Previously active Gemini root synthetic A policy missing")
    for host in EXISTING_CONTROLS:
        if seen[host] != "FOREIGN_HTTPS_INGRESS":
            raise AssertionError("Existing Discord synthetic route missing: "+host)
    for service, hosts in (("youtube",YOUTUBE_HOSTS),
                           ("stitch",STITCH_HOSTS),
                           ("aistudio",AI_STUDIO_HOSTS)):
        rewritten_hosts = sum(seen[h] == "FOREIGN_HTTPS_INGRESS" for h in hosts)
        errors = sum(seen[h] in ("TRANSPORT_FAILURE",
                                "DNS_ERROR_OR_NONEXISTENT") for h in hosts)
        print(f"service={service} audited_exact_hosts={len(hosts)} "
              f"foreign_443={rewritten_hosts} "
              f"direct_or_ipv6={sum(seen[h]=='NON_SYNTHETIC_OR_IPV6' for h in hosts)} "
              f"DNS_error_or_inconclusive={errors}")
    print("youtube_dynamic_video_CDN_suffixes_not_verified=" +
          ",".join(DYNAMIC_VIDEO_SUFFIXES_NOT_VERIFIED))
    print("retroactive_VPN_socket_domain_attribution=IMPOSSIBLE")
    print("youtube_stitch_AI_Studio_browser_functionality=UNVERIFIED")
    rewritten = sum(seen[h] == "FOREIGN_HTTPS_INGRESS" for h in GEMINI_HOSTS)
    impaired = sum(seen[h] in ("TRANSPORT_FAILURE", "DNS_ERROR_OR_NONEXISTENT")
                   for h in GEMINI_HOSTS)
    non443 = sum(seen[h] == "FOREIGN_HTTPS_INGRESS" for h in ANDROID_SYSTEM_HOSTS)
    print(f"official_Gemini_firewall_hosts={len(GEMINI_HOSTS)}")
    print(f"official_Gemini_hosts_rewritten_to_foreign_443={rewritten}")
    print(f"official_Gemini_hosts_DNS_failure_or_inconclusive={impaired}")
    print(f"Android_system_hosts_rewritten_to_foreign_443={non443}")
    print("Android_system_non443_network_handling=UNVERIFIED")
    print("Android_private_DNS_actually_used_with_VPN=UNVERIFIED")
    print("Gemini_browser_or_native_voice=UNVERIFIED")
    print("Google_region_entitlements=UNVERIFIED")
    print("read_only_no_production_changes=yes")
    if non443:
        print("::warning::System Android endpoints rewritten by 443-only SNI proxy")
    if rewritten < len(GEMINI_HOSTS):
        print("::notice::Official Gemini hosts still outside foreign HTTPS ingress")
    if impaired:
        print("::warning::Some Google host DNS answers were inconclusive")


if __name__ == "__main__":
    main()
