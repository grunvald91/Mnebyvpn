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
