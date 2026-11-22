# мнебыDNS for Windows (Rust/Tauri 2)

**Stage 2: read-only integration with localhost DNSProxy and an independent Windows health-service source.** The previous tray implementation remains: close = hide; left-click tray = open; right-click = menu/open/hide/exit. No changes to system DNS, VPN or real subscriptions are made by this stage.

## Implemented

- Rust DNS probe (shared crate `dns-core/`), bounded UDP queries to 127.0.0.1:53 (A) and [::1]:53 (AAAA), with explicit response checks, timeouts and unit tests.
- UI calls a Rust Tauri asynchronous command (off UI thread), renders actual local results and a sober warning about what this does **not** test.
- Separate Rust Windows service **source** (`service/`) polls the same local DNS endpoints and publishes a read-only status record to `%ProgramData%\mnebyDNS\health-v1.json`.
- UI can read a service report if present and fresh (15 seconds). If service isn't installed/running, diagnostics still work directly.
- No polling while hidden and no privileged shell execution. We never publish a personalized DNS hostname.

## Not implemented / not claimed

- No verified DoT/TLS upstream; the probe only tests localhost DNS, which can be supplied by any local resolver.
- No start/stop of DNSProxy, no Windows DNS adapter change, no DHCP/static snapshot/restore, no safe rollback yet.
- No production-ready service installer / ACL hardening / signed binary. **Do not register the service on a production client until release-gated.**
- No Windows 10 target-machine benchmark and no verified runtime behavior of service/GUI on the user's machine.

The existing working DNSProxy and shortcuts should remain in use until the service-based controller is tested.

On each branch push CI also builds an **unsigned standalone diagnostic GUI EXE**, uploaded as `mnebydns-win10-diagnostics-unsigned` in its Actions run artifacts. It is not a production installer or a signed commercial release; it requires WebView2 and hasn't been tested on the target Windows 10 machine. The Windows service is **not** installed or included in the GUI artifact.

## Development

Windows prerequisites: Rust MSVC toolchain, Visual Studio C++ Build Tools, Windows SDK and WebView2. See https://v2.tauri.app/start/prerequisites/.

```powershell
cargo test --manifest-path apps/windows-dns/dns-core/Cargo.toml
cargo check --manifest-path apps/windows-dns/service/Cargo.toml
cargo check --manifest-path apps/windows-dns/src-tauri/Cargo.toml
```

The service source uses `windows-service` SCM lifecycle and is not registered automatically. It is **read-only** and should not be installed manually by end users at this stage.

## Next release gate: privileged controller

Implement signed installation and a restricted privileged Rust service with an authenticated narrow IPC command API (status/enable/disable only). Protect persistent adapter snapshots for both IPv4/IPv6, preserve DHCP/static settings, journal and restore after crash/power loss, validate actual DoT chain before routing, and audit interaction with VPN/TUN software. No arbitrary shell command execution or unverified bypasses.

## UX bases

- https://aiforui.dev/skills/gestures
- https://github.com/benjitaylor/skills
- https://github.com/GoogleChrome/modern-web-guidance
- See `DESIGN.md` for measurable targets (not claimed results).
