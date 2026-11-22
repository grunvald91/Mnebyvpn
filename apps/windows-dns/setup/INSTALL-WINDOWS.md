# мнебыDNS — Windows system DNS controller

This is an unsigned developer package. It installs a persistent Windows service and changes per-interface DNS only after an explicit UAC approval.

## Package contents

Keep these files in one directory:

- mnebydns-setup.exe
- mnebydns-health-service.exe
- mnebydns-windows.exe

The GUI invokes the setup helper with runas. The helper installs the service into %ProgramFiles%\mnebyDNS, provisions the protected %ProgramData%\mnebydns-controller-v1 directory, configures Automatic service start and SCM restart actions, then stores the validated DoT hostname and pinned upstream IP addresses.

## Commands

Run in an elevated terminal:

~~~powershell
.\mnebydns-setup.exe install
.\mnebydns-setup.exe enable <personal-dot-hostname>
.\mnebydns-setup.exe status
.\mnebydns-setup.exe disable
.\mnebydns-setup.exe restore
.\mnebydns-setup.exe uninstall
~~~

enable resolves and pins the DoT hostname before Windows DNS is changed. The service then starts the localhost resolver and changes IPv4/IPv6 DNS on active network interfaces. It monitors new interfaces while running.

disable and restore write a durable disabled state and wait for the service to restore the original DNS settings. If any adapter cannot be restored or verified, the recovery journal is retained and uninstall is blocked.

uninstall is refused while any DNS recovery record remains. The protected ProgramData directory is deliberately preserved; never delete it manually while recovery is pending.

## Recovery

If the GUI is unavailable, run mnebydns-setup.exe disable from an elevated PowerShell window. status reports service state, config state and the number of adapter backups. If the journal is unreadable, do not delete it; inspect the service logs and recover adapter DNS before uninstalling.

The service runs as LocalSystem, uses authenticated DoT only, and does not provide plaintext DNS fallback. Windows DNS changes are persistent; there is no trial timer or automatic time-based rollback. The user can restore through the app or helper at any time.

## CI and release notes

The CI build is not a signed production installer and has not yet been validated on the user's Windows 10 machine. Before wider distribution, verify:
- real SetInterfaceDnsSettings apply/restore for IPv4 and IPv6 on Windows 10 22H2;
- DHCPv4/DHCPv6/RA and static DNS restoration;
- Wi-Fi profile DNS restoration;
- multiple active NICs and VPN/TUN adapters;
- service crash/restart and Windows reboot;
- local DoT listener behavior during long DNS traffic and upstream outage;
- DoH applications and VPN NRPT/split-DNS precedence.
