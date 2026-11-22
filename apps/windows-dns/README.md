# мнебыDNS for Windows (Rust/Tauri 2)

**Current: read-only Windows DNS recovery preflight.** The tray, adapter inventory and protected diagnostic service are implemented. The application still does not modify DNS, VPN routes or adapters.

## Implemented

- Rust DNS probe for 127.0.0.1:53 (A) and [::1]:53 (AAAA).
- Separate Windows health-service source (not installed automatically).
- Rust network inventory using Windows IP Helper `GetAdaptersAddresses`: interface GUID, friendly name, interface type/status, and effective IPv4/IPv6 DNS server addresses.
- Adapter picker in Diagnostics. Nothing is auto-selected. Tunnel/loopback/unknown adapters are clearly marked; no DNS changes are possible from this stage.
- No polling while hidden, no shell execution, no personalized DNS hostnames in the repository.

## Important limits

- The DNS server list returned by Windows is the **effective list**. It does not by itself tell whether the values were set manually, supplied by DHCP, or received through IPv6 router advertisements.
- A VPN adapter may identify itself as Ethernet. The app therefore does not claim that any adapter is safe just because it looks physical; the user must verify its name.
- No adapter snapshot/restore, DNS writes, DNSProxy process lifecycle, privileged IPC, or rollback are implemented yet.
- Do not register the health-service source or use the GUI as a DNS switcher. Continue using the existing DNSProxy setup.

## Build

Windows 10 22H2 x64 target. Prerequisites: Rust MSVC, Visual Studio C++ Build Tools, Windows SDK and WebView2.

```powershell
cargo test --manifest-path apps/windows-dns/dns-core/Cargo.toml
cargo test --manifest-path apps/windows-dns/network/Cargo.toml
cargo check --manifest-path apps/windows-dns/service/Cargo.toml
cargo check --manifest-path apps/windows-dns/src-tauri/Cargo.toml
```

CI builds an unsigned read-only GUI EXE artifact named `mnebydns-win10-diagnostics-unsigned`. It is not a signed production installer, requires WebView2, and has not been runtime-tested on the user's PC.

## Next release gate

Before any DNS write:
1. Capture IPv4 and IPv6 adapter DNS modes, including static vs automatic and profile DNS.
2. Persist a tamper-resistant, ACL-protected transaction journal before changing anything.
3. Use a restricted authenticated local IPC API between GUI and a privileged Windows service.
4. Apply only to the explicitly selected adapter; never auto-target TUN/VPN.
5. Start DNSProxy bound only to loopback (127.0.0.1 and ::1) and validate real DNS responses before changing adapter DNS.
6. On any failure or service crash, restore the exact original adapter configuration; if restoration cannot be verified, surface a prominent recovery instruction.
7. Test on Windows 10 22H2 and with VPN/TUN enabled before release.

## UX references

- https://aiforui.dev/skills/gestures
- https://github.com/benjitaylor/skills
- https://github.com/GoogleChrome/modern-web-guidance

## Review fixes (0.4 diagnostic branch)

- Local DNS probe verifies the full DNS question, requested record type, untruncated answer data and safe packet boundaries. It never claims a successful TLS handshake.
- Windows network inventory fails rather than silently returning truncated adapters or DNS address lists, and bounds retry counts for GetAdaptersAddresses.
- The UI prevents concurrent diagnostics/adapter refresh requests and clearly labels the optional service status file as untrusted.
- Effective DNS addresses are not a recoverable snapshot of DHCP/static configuration. There is **still no privileged DNS control** and no automatic network changes.

Before commercial deployment, the service status mechanism needs protected ACLs, an authenticated IPC channel and crash-safe persistence. The current service writes a JSON file for non-authoritative diagnostics only.

## Stage 4 (0.5): Windows DNS API preflight

Added `preflight_dns_adapter`: native Rust read-only access to Windows
`GetInterfaceDnsSettings` / `FreeInterfaceDnsSettings`, with separate IPv4 and IPv6
inspection for an explicitly selected adapter GUID. The GUI shows existing static/profile DNS
values and clearly refuses to infer automatic configuration from an empty static field.

**Safety lock:** `mutation_enabled` is hard-coded to `false`; this is not a DNS
switcher yet. The Windows API snapshot alone is not a complete crash-safe rollback
journal and is not stored as a privileged backup. DNSProxy service management,
authenticated IPC, Windows SCM setup, an atomic protected journal and verified
Windows 10 recovery tests are still required before enabling any DNS changes.

Microsoft references:
- https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getinterfacednssettings
- https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-freeinterfacednssettings
- https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-dns_interface_settings

## Transaction core (not yet connected to Windows)

`transaction/` implements the guarded DNS activation/rollback state machine with a
`NetworkBackend` and `RecoveryJournal` abstraction. Mock tests cover successful
activation, unknown DHCP/RA mode refusal, journal failure, partial IPv6 update, DoT
verification failure, and recovery failure requiring retained journal.

This crate does **not** modify Windows networking and has **no real privileged
service backend or protected on-disk journal**. The journal must be durable and
ACL-protected before the first production mutation. Do not present these mock
tests as real Windows DNS rollback verification.

## Stage 6: durable recovery journal source (no system DNS writes)

The `journal/` crate implements the `RecoveryJournal` contract for a persistent
on-disk journal. Its record contains the captured adapter GUID and IPv4/IPv6 DNS
modes, but **no credentials, personal DNS hostnames or subscriptions**.

- Save sequence: `create_new` staging file → write → `sync_all` → hard-link
  to a unique final record → remove staging → read back and verify SHA-256.
- The recovery record cannot be overwritten while present. A truncated,
  corrupted or orphaned staging file blocks new activations.
- After BOTH families are restored and verified, the transaction engine
  permits clearing the recovery record. An interrupted restore leaves it.
- On Windows, `ProtectedJournal::open_service` uses a new
  `%ProgramData%\\mnebydns-controller-v1` directory, created with a
  SYSTEM + Administrators-only protected DACL. It compares the stored DACL
  with the expected one and rejects reparse points.

**Limitations:** journal data is not encrypted or cryptographically signed;
the checksum detects corruption, not tampering by an administrator. Flushes
and filesystem operations still require explicit power-loss testing. Windows
service installation, authentication, true DHCP/RA capture, DNSProxy process
ownership and real network rollback remain unimplemented. No user-facing DNS
enable/disable control has been unlocked. Do not install this as production
DNS controller.

## Service status storage hardening

The experimental SCM health service now refuses to start unless it can open
the SYSTEM+Administrators-only controller directory. Its internal report is
written **inside** that directory and contains a non-sensitive pending-journal
indicator (`pending`, `clear`, `unreadable`) alongside a local DNS probe.

The GUI deliberately **stopped reading** the old untrusted
`%ProgramData%\\mnebyDNS\\health-v1.json` path. These fields are not exposed
to the user until a restricted and authenticated IPC channel is implemented.
The service has not been installed on the user's Windows PC and performs no
DNS switch or actual recovery action.

## Review: failure handling improvements

- A valid committed record remains readable even if an interrupted hard-link
  commit left an identical staging record behind. This permits **restore**
  rather than blocking it. New activation still refuses to overwrite pending
  recovery, and verified restore removes staging BEFORE the committed file.
- A staging-only file, mismatched contents, invalid GUID or wrong-family DNS
  address is rejected without modifying network settings.
- During service operation, the private directory must already exist and its
  DACL must still match the required policy. If it disappears, the service
  MUST NOT silently recreate an empty directory and interpret that as
  absence of an earlier recovery record. The initial bootstrap path remains
  a separate installer/service-start concern.

The current SCM service is still diagnostic, not a production DNS controller.

## Cold-start review: explicit provisioning required

`ProtectedJournal::open_service` now **refuses** to create a missing
`%ProgramData%\\mnebydns-controller-v1` directory. This prevents an
unexpected deletion across a reboot from being interpreted as a brand-new
empty journal. A future elevated, authenticated installer must provision
the directory with the required protected DACL **before** installing or
starting the service. No installer or service registration is supplied yet.

## Stage 7: read-only Windows named pipe IPC

The new `ipc/` crate provides a Windows Named Pipe at
`\\\\.\\pipe\\mnebydns-status-v1` with a restrictive SDDL:
LocalSystem/Administrators full access, interactive users read-only.
`PIPE_REJECT_REMOTE_CLIENTS` rejects remote callers and
`FILE_FLAG_FIRST_PIPE_INSTANCE` detects pipe-name squatting. The GUI
verifies the pipe server process token belongs to LocalSystem
before reading the bounded, versioned, fresh JSON status frame.
The diagnostic service publishes its local DNS report and
the recovery record's **status only** (`clear/pending/unreadable`).

- **No remote network port**; IPC is local Windows only.
- **No write commands**, DNS configuration changes, VPN changes or raw
  journal/credentials exposed to clients.
- The experimental service is NOT installed automatically.
  The protected ProgramData directory must be provisioned in a future
  controlled installer before the SCM service can start.
- IPC identity verification can deny ordinary users if Windows policy
  prevents reading the LocalSystem token; fail closed rather than bypassing.
- A client connecting to the single pipe and refusing to read could delay
  IPC availability. A bounded overlapped I/O implementation and Windows
  client/service runtime tests remain a pre-production requirement.
- Do not claim this is validated on the user's Windows 10. CI compiles and
  tests protocol helpers and the UI, not live service installation.

## Stage 8: native read-only service setup preview

A separate `setup/` Rust CLI can register/unregister the **diagnostic-only**
service in the Windows SCM, provision protected recovery storage, and query
status. It requires administrator privileges for install/uninstall and deliberately
preserves the protected journal and installed EXE after unregistering.

New GitHub Actions artifact: `mnebydns-win10-service-setup-unsigned`
contains `mnebydns-health-service.exe`, `mnebydns-setup.exe` and
`INSTALL-WINDOWS.md`. This artifact is an unsigned developer preview,
not a production installer, and not yet deployed or runtime-tested in a
Windows 10 VM. See `setup/INSTALL-WINDOWS.md`.

This stage does not alter network configuration or copy third-party DNSProxy.
It has no automatic elevation, in-place upgrade, signed publishing or
automatic cleanup, and must be validated on a disposable VM before release.

## Stage 9: bounded local IPC status delivery (read-only)

The GUI already reads authenticated service state from the LocalSystem named pipe
when the user requests DNS diagnostics. The earlier service used synchronous
`FlushFileBuffers`, which Microsoft documents as waiting until a client reads
all bytes. A client that did not read could monopolize the only pipe instance.

- The pipe now supports a single-byte delivery ACK from the GUI **only after**
  the bounded status frame passes schema, timestamp and state validation.
- Interactive clients get pipe read/write permission for **this ACK only**;
  the service does not accept DNS commands, profile changes or other actions.
- Service I/O uses overlapped operations and a 1000 ms per-client deadline,
  then cancels/reaps unfinished I/O before reusing the pipe instance.
- The temporary Windows GitHub runner smoke test opens a client that refuses
  to read/ACK, then verifies a subsequent client can receive service status.
- The protocol remains local-only, LocalSystem-authenticated, and untrusted
  process identities are rejected by the GUI.

This does not enable DNS switching. Actual Windows 10 22H2 and hostile-client
security testing, safe DNSProxy ownership, DHCP/RA restore, and recovery on
power failure are still release gates.

## Stage 10: fail-closed DNS evidence and rollback identity checks

Documentation review found a prior API misuse: `GetInterfaceDnsSettings`
requires its input `Flags` to be **zero**. The previous preflight passed
`DNS_SETTING_IPV6` to the *read* call even though Microsoft documents that
flag for *setting* configuration. That return value was not a verified IPv6
source snapshot. It must never be used as rollback input.

This stage corrects the read call and adds the following safety gates:

- Read Windows' native **IPv4** static/profile DNS data with version-only
  API input. Reject invalid IPs, wrong family, overlong/unterminated UTF-16 and
  server lists beyond 32; never truncate a future backup silently.
- IPv6 shows only **effective addresses** from adapter inventory. IPv6
  static/DHCPv6/RA/profile **source remains UNVERIFIED**. The GUI reports
  blockers explicitly, with `recovery_ready=false` and
  `mutation_enabled=false` regardless of available IPv4 data.
- Recovery state machine now requires backend checks both **after durable
  journal save and before DNS writes**, and **again before any restore**.
  Mock tests reject adapter/source drift and replacement without touching DNS
  and preserve the recovery record for investigation.
- Windows runner executes a native read-only preflight example on its
  operational adapters, in addition to transaction tests and the existing
  no-mutation SCM smoke test.

**Not yet implemented:** an authoritative, tested IPv6 origin capture,
DHCP/RA and per-profile restore, a real Windows `NetworkBackend` that can
apply/restore and verify exact configurations, DNSProxy lifecycle/DoT checks,
a signed installer, and crash/power-loss testing on Windows 10 22H2. The
protected journal remains reserved for genuine mutations; incomplete
read-only evidence is NEVER committed as a recovery record.

Microsoft references:
- https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getinterfacednssettings
- https://learn.microsoft.com/en-us/windows/win32/api/netioapi/ns-netioapi-dns_interface_settings
- https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-setinterfacednssettings


## Stage 11: Windows registry DNS origin evidence (read-only)

`network/registry_source.rs` adds native, read-only `RegGetValueW` inspection of per-interface
`NameServer` in Tcpip/Tcpip6 and `DhcpNameServer` in Tcpip for an explicitly
selected adapter GUID. Microsoft documents both IPv4 and IPv6 `NameServer` registry
paths for Windows network devices:

- https://learn.microsoft.com/en-us/windows-hardware/drivers/network/mb-dns-updates
- https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-reggetvaluew

The evidence is **not** authoritative provenance: absent/empty registry
entries are not proof of DHCP/RA; the effective DNS list can also be affected
by VPN, policies and profile DNS. The app never writes the registry, never
saves this evidence as a recovery snapshot, never enables DNS switching, and
does not log DNS addresses in GitHub Actions.

The native preflight compares IPv4 registry static data with DNS API data,
flags inconsistencies, and reports any read/parse errors instead of
guessing. IPv6 static values are exposed only as unverified evidence.
A complete original-mode capture, exact RA/DHCPv6/profile restoration and
real Windows 10 recovery testing are required before introducing mutation.


## Stage 12: authenticated upstream DoT probe (not a DNS switch)

The Windows tray app can now test a user-entered, personal DNS hostname
without saving it to disk. Rust uses Windows system certificate trust through
`native-tls` and checks the requested hostname during the TLS handshake
on TCP port **853**. If TLS fails, **no plaintext DNS fallback** occurs.
After TLS verification, it issues framed (RFC 7858) **A and AAAA** queries
for `example.com`, validates the replies, and shows success only after
both positive answers are checked. The UI does not claim Smart DNS routing,
VPN connectivity or a working local proxy. The hostname does not appear in
the code, logs, output artifacts or persistent app settings.

Security limitations:
- The Windows **OS resolver** bootstraps the DoT hostname; this initial
  lookup is not claimed to be protected by this particular DoT tunnel.
- Timeouts apply to TCP connect and TLS I/O. OS hostname resolution can
  impose additional delay; tests do not claim a hard end-to-end deadline.
- An authenticated response to example.com proves DoT transport and normal
  DNS resolution, **not** access to every site or video streaming.
- This is a non-mutating diagnostic in the GUI, not production DNSProxy
  process ownership, automatic DNS configuration or rollback.
- Unit tests exercise hostname filtering and DNS-over-TLS wire framing
  entirely offline, while Windows CI builds the native TLS client. A live
  personal upstream test requires a hostname supplied by the user.

Standards:
- https://www.rfc-editor.org/rfc/rfc7858
- https://www.rfc-editor.org/rfc/rfc8310

## Stage 12 review: address fallback, DNS identity and total response deadline

- TCP reachability alone does not authorize a success or immediate failure.
  On a TLS handshake error, the client tries other **bounded** IPv4/IPv6
  candidates for the same hostname, with normal certificate and hostname
  verification on **every attempt**. IPv4 candidates are preferred because
  current personal endpoints may be IPv4-only.
- Each DoT response is read against **one time budget**. A peer that slowly
  trickles DNS bytes no longer resets the entire read deadline on each chunk.
  OS hostname resolution still has no guaranteed end-to-end deadline.
- DNS A/AAAA answer records must belong to the actual queried owner,
  `example.com`; compression pointers are decoded with bounded backward
  jumps and loop rejection.
- A changed input invalidates pending results even if the original hostname
  is re-entered. Pressing Enter runs the check.
- Tests cover reordered/duplicated IPv4/IPv6 addresses, expired response
  deadlines, forged answer owner, compression-loop rejection and wire framing.

These measures improve the *diagnostic*. They do not install a local DNS
proxy or authorize changing Windows adapter DNS.


## Stage 13: temporary UDP loopback → authenticated DoT proxy

A real UDP DNS listener is now implemented in `dns-core/src/udp_proxy.rs`.
The GUI button **"Проверить локальный DNS-прокси"** starts a short-lived
127.0.0.1 listener on an **ephemeral port** (never port 53), sends an
`example.com` A query through the listener, forwards the original DNS packet
to the user's explicitly entered DoT hostname using system-trusted TLS
with TLS 1.2+, validates the upstream transaction ID and exact question,
and shuts the listener down at the end. A failed DoT lookup produces
**SERVFAIL**, never a plaintext upstream fallback.

The listener uses two bounded workers, a bounded UDP payload, explicit
EDNS OPT parsing, per-query TLS timeouts, an upper limit on upstream
DNS frame length and short socket polling for shutdown. Oversized responses
set the DNS **TC** flag rather than sending fragmented UDP packets.
**TCP fallback is not yet implemented** and TC replies may be unusable
until it is added. DHCP/RA/VPN/Windows adapter settings are untouched.

Before opening the listener, the resolver resolves and **pins the DoT
upstream IP addresses** using the existing OS resolver, to prevent
re-resolution through a future local DNS redirect. No hostname or
personal configuration is written to disk or logged. This is a
preview smoke test, **not** continuous Windows DNSProxy deployment:
each query currently opens a separate authenticated TLS connection
(no pooling, caching, DNS over TCP listener, IPv6 listener or
production auto-recovery).

Offline tests on the actual Windows runner use a mock upstream to
exercise native UDP loopback, SERVFAIL, malformed input dropping,
EDNS framing, response correlation and truncation with **zero external
network calls**. Running the GUI button against a real personal
server is a separate manual integration check.

References: https://www.rfc-editor.org/rfc/rfc7858 and
https://www.rfc-editor.org/rfc/rfc7766.


## Stage 14: Windows 0.9 usability test build

The home screen now prioritizes the user's personal DoT profile and a single guided `Проверить подключение` action: first authenticated DNS-over-TLS, then the temporary UDP-to-DoT relay. The app explicitly labels itself preview/test mode and never mistakes the existing system localhost resolver for MNEBYDNS being enabled. Advanced adapter diagnostics and individual DNS test buttons remain available. Changed input invalidates prior results. No DNS settings are modified.

Each Windows GUI artifact includes a portable EXE, Russian `START-HERE.md` instructions and `SHA256.txt`. Runtime Windows 10/WebView2 and tray/scale checks still require local testing; a green Windows runner is not proof of hardware compatibility. `ui/contract.test.mjs` cross-checks HTML IDs and Tauri command bindings.

References: https://aiforui.dev/skills/gestures and https://github.com/GoogleChrome/modern-web-guidance.


## Stage 15 — Windows system DNS trial, version 0.10

This is a **time-limited**, administrator-approved trial. It uses the Windows
DNS Name Resolution Policy Table (NRPT) namespace dot, officially defined as
Any, so it does not overwrite the per-interface IPv4/IPv6 static/DHCP/RA
settings whose exact source is not yet safely restorable.

Before creating any NRPT rule, the separately launched local process binds
127.0.0.1 and ::1, **UDP and TCP port 53**, resolves and pins the personal DoT
server upstream, verifies certificate and hostname, and answers direct DNS
queries through encrypted DoT. A SYSTEM scheduled rollback task is registered
before the NRPT rule is added, repeats each minute, and removes the tagged
rule after 15 minutes, on reboot, or if the local proxy process exits.
A user can disable the rule sooner. Existing NRPT rules always block trial
activation rather than competing with a VPN/corporate policy.

The Windows GUI launches the elevated, bundled PowerShell helper using UAC and
checks live NRPT status separately. UAC process launch is never treated as a
successful activation. The personal DoT name is read in the elevated console
and passed only in the process environment of the child, not saved in files
or placed on the command line. The proxy binds to localhost only, never
exposes itself as an open resolver, and never falls back to plaintext DNS
upstream.

This trial is not a permanent service and is not proven on the user's Windows
10 hardware. The permanent release requires a supervised always-on service,
a secure installer, verified NRPT rollback including power loss, retries,
long-term TLS pooling, DNS over TCP/UDP tests under load, and tests with VPN
and third-party DoH. NRPT also does not capture applications that perform
their own DNS resolution.
