# мнебыDNS for Windows (Rust/Tauri 2)

**Stage 3: read-only Windows network adapter inventory.** The previous tray and localhost DNS diagnostics remain. This stage does not modify Windows DNS, VPN routes, adapters, or services.

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
