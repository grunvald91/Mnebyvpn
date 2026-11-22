# мнебыDNS — Windows service preview

This is an **unsigned developer package**, not a production or one-click installer.

## What it does

- Copies `mnebydns-health-service.exe` into `%ProgramFiles%\\mnebyDNS`.
- Provisions `%ProgramData%\\mnebydns-controller-v1` with a restricted
  SYSTEM+Administrators DACL (existing unsafe ACLs cause an error).
- Registers the read-only `MnebyDnsHealth` Windows service with **OnDemand**
  start and starts it once.
- GUI (distributed separately) may read status via a local named pipe.
- **Never** changes Windows DNS, IPv4/IPv6 adapter settings, VPN or DNSProxy.
  Does not bundle or install third-party DNSProxy binaries.

## Developer test on Windows 10

Extract the two executables into the same folder. Check their source and verify
the unsigned-binary risk before installing. In an elevated terminal:

```powershell
.\\mnebydns-setup.exe install
.\\mnebydns-setup.exe status
.\\mnebydns-setup.exe uninstall
```

No DNS outage should be caused by these commands, but Windows service
installation is a privileged system change and should be tested on a disposable
VM first. Avoid this preview on a production client before integration tests.

## Fail-safe removal

If a pending/corrupt/inaccessible protected recovery journal is detected,
uninstall refuses to proceed. The service binary and protected journal are
deliberately **preserved** on uninstall; never delete them manually while
recovery is pending. This preview has no in-place upgrade or signed updater.

If installation fails halfway, review `%ProgramFiles%\\mnebyDNS` and
`%ProgramData%\\mnebydns-controller-v1`. Do not erase recovery files to
force reinstallation.

Build:
`cargo test --manifest-path apps/windows-dns/setup/Cargo.toml`

## CI smoke test

The branch push workflow runs `smoke-runner.ps1` on an **ephemeral
GitHub-hosted Windows runner** only (never on an untrusted pull request).
The script installs this read-only service, tests status over the actual
LocalSystem named pipe, uninstalls it, and compares adapter DNS settings
before/after. On failure the workflow reports the error. It does not
simulate Windows 10 22H2 and does not verify DNSProxy or encrypted DoT.
