# мнебыDNS for Windows (Rust/Tauri 2)

Experimental desktop **UI with a real Windows tray**, not yet a DNS-switching client. No DNS settings, VPN interfaces, subscriptions or production infrastructure are changed by this program.

## What works

- Closing the main window hides it in the Windows notification area instead of exiting.
- Left-click on the tray icon reopens and focuses the main window.
- Right-click tray menu: Open, Hide, Exit.
- "Свернуть в трей" button uses a read-only (with respect to networking) Rust/Tauri command.
- UI is vanilla HTML/CSS/JS without React, Node.js, Electron or a dev web server at runtime.
- No tokens, personalized DoT hostnames or other subscriptions are checked into this public repository.

## What's **not** implemented

- DNSProxy service lifecycle, Windows DNS changes and automatic recovery.
- Connection status/health checks and integration with the control-plane.
- Single instance handling, code signing, installer testing and real Windows 10 performance results.

The main screen intentionally says it is a prototype; it does **not** pretend that DNS is connected. Do not use this app as a replacement for the working PowerShell/DNSProxy configuration yet.

## Build / run (developer workstation)

Prerequisites: Rust MSVC toolchain, Visual Studio C++ Build Tools/Windows SDK, WebView2 runtime, Tauri CLI v2. See https://v2.tauri.app/start/prerequisites/.

```powershell
cargo install tauri-cli --version "^2" --locked
cd apps/windows-dns/src-tauri
cargo tauri dev
```

For a compile-only check:

```powershell
cargo check --manifest-path apps/windows-dns/src-tauri/Cargo.toml
```

For an installer later: `cd apps/windows-dns/src-tauri; cargo tauri build`. This source has **not** yet been compiled or benchmarked on the target Windows 10 22H2 PC. No AVX/AVX2 CPU assumptions may be introduced.

## Architecture

- Rust/Tauri 2: tray, window lifecycle, later read-only status and privileged-service IPC.
- Minimal static HTML/CSS/JS: no JS framework and no large animation library.
- Future separately installed Rust Windows Service: atomic and journaled DNS backup/restore across IPv4/IPv6; DNSProxy process supervision; restricted IPC.
- DNSProxy under Apache-2.0: only if separately bundled with preserved license/notice. It is **not** bundled in this prototype.
- Any personal DoT profile will be supplied at runtime; never committed to GitHub.

## UX basis

- https://aiforui.dev/skills/gestures
- https://github.com/benjitaylor/skills
- https://github.com/GoogleChrome/modern-web-guidance

No gestures on the power control; no drag-to-disconnect. Keyboard support, reduced motion and visible states are first-class. See `DESIGN.md`.

## Priority

1. CI green on Windows x64, validate tray open/hide/exit on Windows 10.
2. Measure cold/warm startup and memory on i7-870 / Radeon HD 6570. Benchmark against a native Rust/Win32 alternative if WebView2 is slow.
3. Implement a separate Rust Windows service with rollback-safe DNS handling. Never let the UI mutate network configuration directly.
