# Windows DNS app — UX/performance contract

## Priority hierarchy

1. **No network breakage**. This tray/UI prototype cannot change DNS.
2. **Fast, small, calm**. Rust control plane; system WebView2 with plain HTML/CSS/JS and no front-end framework; evaluate a Rust/Win32 view if the target machine struggles.
3. **Clear states**. No "connected" status without successful real DoT and local DNS checks, and never claim that a DNS connection is a VPN.
4. **Tray first**. Close = hide, left click = open, right click = menu; Exit explicitly leaves the GUI but must not change any future service-controlled DNS status.
5. **Accessible gestures**. 1:1 dragging only when a genuine draggable UI is implemented, interruptible animation, reduced-motion support. No swipe-to-disconnect.
6. **Visual priority**. One main status, one main action. Diagnostics/settings secondary, crisp contrast and touch-friendly targets. Responsive at narrow widths.

## Measurable release gates (targets, not measured performance)

- Cold UI visible in 1s target; on-click feedback within 100ms.
- No network I/O on UI's critical paint path.
- Idle CPU target below 1% on user's hardware; benchmark RAM rather than invent limits.
- Support Windows 10 22H2 x64 / Intel Core i7-870 without AVX/AVX2.
- Test 100%, 125%, 150% scaling and Windows high contrast/reduced motion.
- Compare application behavior when WebView2 runtime is missing or damaged.
- Confirm startup/restore and tray behavior across sleep, restart, logoff and multiple-clicks.
- No unwanted modification of VPN clients/TUN adapters.

## Next stage: trusted service

The service owns DNSProxy, credential-safe DoT profile storage, all adapter modifications and journaled restore of IPv4/IPv6 (DHCP/static). GUI receives read-only state and sends limited enable/disable commands through authenticated local IPC; never arbitrary shell. Apply one irreversible change only after verifying a validated rollback state. DoT TLS certificate verification must remain enabled. The client must not introduce insecure DNS fallback silently.

The current graphical button is **not** a real connect command. Production requires end-to-end tests and signing.

## References

- Tauri tray: https://v2.tauri.app/learn/system-tray/
- Gesture guidance: https://aiforui.dev/skills/gestures
- Layout and motion: https://github.com/benjitaylor/skills
- Web performance/accessibility: https://github.com/GoogleChrome/modern-web-guidance
