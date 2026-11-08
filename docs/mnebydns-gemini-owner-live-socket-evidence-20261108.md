# Gemini Android socket-only diagnostic — 2026-11-08 (read-only)

**Result status: completed, not proof of per-app traffic. No live Smart DNS changes.**

Verified GitHub Actions run: https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42515144245

## Scope and timing

- Foreign MNEBYVPN isolated Xray outbound socket sample, **15 seconds idle baseline**, then **90 seconds operator-initiated Gemini interaction window**.
- UTC test window: **2026-11-08T19:28:07Z through 19:29:37Z** (Moscow: 22:28:07–22:29:37).
- Owner explicitly stated all VPN connections were theirs. The server still cannot cryptographically attribute any particular outbound socket to the owner's Android app.
- At preflight: 2 enabled entitlements, 53 established inbound TCP sessions. Sessions are *not* subscriber counts.
- Baseline unique global destination socket endpoints: **26**.
- Unique global destination socket endpoints seen during test: **31**.
- New unique destinations (test minus baseline): **7**. 26+7≠31 is expected because the 26 baseline endpoints and 31 observed test endpoints are sets with both overlap and turnover.
- New endpoint protocols/ports: **7 × TCP/443**.
- New endpoints matching a simultaneously resolved official Google service IP: **3**; unmatched: **4**.
- Distinct destinations reported only as aggregated counts; no raw IP, credentials, identifiers, content or voice data in CI logs.

## LOW-CONFIDENCE DNS co-location candidates

These were obtained by resolving a fixed list of hostnames on the foreign server and seeing whether a destination socket IP matches one or more resolved addresses. **These are candidates, not observed TLS SNI or actual Android app requests. Google expressly warns that services share IPs and IP ranges change.**

Gemini-related candidate domains (listed in official Gemini App firewall guidance):
- `jnn-pa.googleapis.com`
- `optimizationguide-pa.googleapis.com`
- `www.googleapis.com`
- `content-autofill.googleapis.com`
- `maps.googleapis.com`

Additional Android/Google service candidates (not proof of use by Gemini):
- `android.googleapis.com`
- `firebaseinstallations.googleapis.com`
- `gcm-http.googleapis.com`

Advertising/tracking candidate, **do not prioritize for Gemini functionality**:
- `td.doubleclick.net`

Official Google reference: https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/gemini-app-firewall-settings
Official Android endpoint and protocol matrix: https://support.google.com/work/android/answer/10513641
Official FCM warning (push streams cannot transparently use generic HTTPS proxy): https://firebase.google.com/docs/cloud-messaging/network-configuration

## Reconciliation with live MNEBYDNS

Prior [authenticated-DoT read-only live audit](https://github.com/grunvald91/Mnebyvpn/actions/runs/42489604676): only **1 of 34** official Gemini hosts resolved to foreign HTTPS ingress; **0 of 12** Android system candidates did. The current broad Google/YouTube suffix staging in PR #74 remains **LAB ONLY**; its generated CoreDNS rewrites do NOT represent production state. This test did **not** show that Google endpoints under those DNS names are actually used by a specific voice request.

## Suggested bounded follow-up, NOT a deployment authorization

1. Repeat the on-demand measurement after confirming *text + voice + Live* operations actually occurred within the timestamped window. Compare idle and test-only difference. Reused TCP sockets cannot reliably be detected as newly established.
2. On a dedicated test setup, add a trusted user-attributed per-connection transport trace to determine destinations more accurately (or use an opt-in Android client debug log with sensitive fields redacted). The server's shared-socket approach is inherently low-confidence.
3. Prioritize a **small, exact-host, reversible TLS/443 canary** for validated Gemini HTTP endpoints. Verify original end-to-end TLS certificate, text/voice, IP egress, DNS A/AAAA/HTTPS/SVCB, existing routing precedence, and rollback before any production extension.
4. Do **not** redirect every `*.google.com`, FCM, NTP, STUN or UDP/QUIC endpoint to a 443-only proxy. Some Android services need TCP 5228–5230 or UDP 123; existing DNS rewrites cannot carry those protocols.

No user-specific IP addresses, account tokens, or raw source/destination payloads are included.
