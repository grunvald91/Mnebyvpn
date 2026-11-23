#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

//! Native Windows SCM installer and UAC control helper for the persistent
//! mnebyDNS system resolver. It provisions a protected recovery directory,
//! stores pinned DoT configuration and controls the privileged DNS service.
//! This is an unsigned developer preview, NOT a production installer.

use mnebydns_journal::{ControllerConfig, ProtectedJournal};
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_service::service::{
    ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

const SERVICE_NAME: &str = "MnebyDnsHealth";
const SERVICE_BIN: &str = "mnebydns-health-service.exe";
const INSTALL_DIR: &str = "mnebyDNS";
const MAX_BINARY_BYTES: u64 = 64 * 1024 * 1024;

fn error(msg: impl Into<String>) -> io::Error {
    io::Error::other(msg.into())
}

fn map_service(err: windows_service::Error) -> io::Error {
    error(err.to_string())
}

fn ensure_regular_file(path: &Path) -> io::Result<u64> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > MAX_BINARY_BYTES {
        return Err(error(
            "Service binary must be a normal, nonempty file <= 64 MiB",
        ));
    }
    Ok(meta.len())
}

fn install_directory() -> io::Result<PathBuf> {
    let program_files = env::var_os("ProgramFiles")
        .ok_or_else(|| error("ProgramFiles system directory is missing"))?;
    let root = PathBuf::from(program_files);
    if !root.is_absolute() {
        return Err(error("ProgramFiles must be an absolute directory"));
    }
    let path = root.join(INSTALL_DIR);
    // On first install the directory must not be an attacker-controlled junction.
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(error("Unexpected install directory type"));
        }
        // Upgrades are not supported by this preview. A preexisting install
        // must be handled deliberately, not overwritten.
        return Err(error(
            "Install directory already exists: refusing to overwrite",
        ));
    }
    Ok(path)
}

fn copy_new_binary(source: &Path, target: &Path) -> io::Result<()> {
    let expected_size = ensure_regular_file(source)?;
    let input = File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let copied = io::copy(&mut input.take(MAX_BINARY_BYTES + 1), &mut output)?;
    if copied != expected_size {
        return Err(error("Source service executable changed during copy"));
    }
    output.flush()?;
    output.sync_all()?;
    Ok(())
}

fn service_manager(create: bool) -> io::Result<ServiceManager> {
    let access = if create {
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE
    } else {
        ServiceManagerAccess::CONNECT
    };
    ServiceManager::local_computer(None::<&str>, access).map_err(map_service)
}

fn protect_recovery_directory() -> io::Result<()> {
    mnebydns_journal::provision_for_installer().map_err(error)
}

fn install() -> io::Result<()> {
    let manager = service_manager(true)?;
    // Reserve our SCM name before any file changes.
    if manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .is_ok()
    {
        return Err(error(
            "A service with this name already exists; upgrade is blocked",
        ));
    }

    let source = env::current_exe()?.with_file_name(SERVICE_BIN);
    ensure_regular_file(&source)?;
    let install_dir = install_directory()?;
    // A trusted administrator must run this tool elevated. SCM access above
    // verifies elevation by requiring CREATE_SERVICE.
    fs::create_dir(&install_dir)?;
    let binary = install_dir.join(SERVICE_BIN);
    copy_new_binary(&source, &binary)?;

    // Only after binary is staged, provision the protected state directory.
    // If anything fails, preserve the staged file for forensic inspection.
    protect_recovery_directory()?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("мнебыDNS — системный DNS"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: binary,
        launch_arguments: Vec::new(),
        dependencies: Vec::new(),
        account_name: None, // LocalSystem for the current IPC identity check.
        account_password: None,
    };
    let service = manager
        .create_service(
            &info,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::CHANGE_CONFIG,
        )
        .map_err(map_service)?;
    service
        .set_description(
            "Persistent mnebyDNS DNS-over-TLS resolver and per-interface DNS controller.",
        )
        .map_err(map_service)?;
    configure_service_recovery()?;
    service.start::<&str>(&[]).map_err(map_service)?;
    println!("мнебыDNS system DNS service installed and started automatically.");
    println!("It will start at Windows boot and restore saved DNS settings when disabled.");
    Ok(())
}

fn configure_service_recovery() -> io::Result<()> {
    let root = env::var_os("SystemRoot").ok_or_else(|| error("SystemRoot missing"))?;
    let sc = PathBuf::from(root).join("System32").join("sc.exe");
    let output = Command::new(sc)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .args([
            "failure",
            SERVICE_NAME,
            "reset=",
            "86400",
            "actions=",
            "restart/5000/restart/15000/restart/30000",
        ])
        .output()?;
    if !output.status.success() {
        return Err(error(format!(
            "Could not configure automatic service restart: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

fn ensure_service_installed() -> io::Result<()> {
    let manager = service_manager(false)?;
    match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG | ServiceAccess::START,
    ) {
        Ok(service) => {
            let config = service.query_config().map_err(map_service)?;
            let expected = PathBuf::from(
                env::var_os("ProgramFiles").ok_or_else(|| error("ProgramFiles missing"))?,
            )
            .join(INSTALL_DIR)
            .join(SERVICE_BIN);
            if !is_our_service_path(&config.executable_path, &expected) {
                return Err(error(
                    "Existing service path does not belong to this client",
                ));
            }
            if service.query_status().map_err(map_service)?.current_state == ServiceState::Stopped {
                service.start::<&str>(&[]).map_err(map_service)?;
            }
            Ok(())
        }
        Err(_) => install(),
    }
}

/// Upgrade only a disabled, fully restored, known installation. Never
/// replace a live service executable while a network adapter may still point
/// to the loopback resolver.
/// Refuse upgrades when a physical interface still depends on the
/// localhost DNS service, even if its recovery journal is unexpectedly empty.
fn physical_adapter_still_uses_local_dns() -> io::Result<bool> {
    let adapters = mnebydns_network::list_adapters().map_err(error)?;
    Ok(adapters.iter().any(|adapter| {
        adapter.operational
            && adapter.likely_physical
            && (adapter
                .dns_ipv4
                .iter()
                .any(|address| address == "127.0.0.1")
                || adapter.dns_ipv6.iter().any(|address| address == "::1"))
    }))
}

/// Emergency exact restoration for a STOPPED controller after a broken
/// previous version. Never races against the running service. Every saved
/// adapter is restored and verified independently; failures keep its backup.
fn repair_dns() -> io::Result<()> {
    let manager = service_manager(false)?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .map_err(map_service)?;
    if service.query_status().map_err(map_service)?.current_state != ServiceState::Stopped {
        return Err(error(
            "Repair requires the Windows DNS service to be stopped. Disable its startup, stop it safely, or reboot first. Backups preserved.",
        ));
    }
    let journal = ProtectedJournal::open_service().map_err(error)?;
    if let Some(mut config) = journal.read_controller_config().map_err(error)? {
        if config.enabled {
            config.enabled = false;
            journal.write_controller_config(&config).map_err(error)?;
        }
    }
    let mut recovery = journal.system_dns_journal().map_err(error)?;
    let snapshots = recovery.read_all().map_err(error)?;
    let mut errors = Vec::new();
    for saved in snapshots {
        match mnebydns_network::restore_adapter_dns(&saved)
            .and_then(|_| mnebydns_network::verify_adapter_restored(&saved))
            .and_then(|_| recovery.clear_verified(&saved.interface_guid))
        {
            Ok(()) => {}
            Err(reason) => errors.push(format!("{}: {}", saved.adapter_name, reason)),
        }
    }
    if recovery.has_pending().map_err(error)? {
        errors.push("One or more original DNS backups remain; do not delete them".to_owned());
    }
    if physical_adapter_still_uses_local_dns()? {
        errors.push(
            "An active physical adapter still uses localhost DNS; recovery is incomplete"
                .to_owned(),
        );
    }
    if errors.is_empty() {
        println!("Original adapter DNS settings restored and verified.");
        Ok(())
    } else {
        Err(error(errors.join("; ")))
    }
}

fn enable_service_autostart() -> io::Result<()> {
    let root = env::var_os("SystemRoot").ok_or_else(|| error("SystemRoot missing"))?;
    let sc = PathBuf::from(root).join("System32").join("sc.exe");
    let result = Command::new(sc)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .args(["config", SERVICE_NAME, "start=", "auto"])
        .output()?;
    if !result.status.success() {
        return Err(error(format!(
            "Could not restore DNS service auto-start: {}",
            String::from_utf8_lossy(&result.stderr)
        )));
    }
    Ok(())
}

/// Check again AFTER the service has stopped. Before that, the old
/// controller could still have an in-flight DNS mutation.
fn ensure_upgrade_is_safe(journal: &ProtectedJournal) -> io::Result<()> {
    let journal = ProtectedJournal::open_service().map_err(error)?;
    if journal.check_recovery_pending().map_err(error)?
        || journal
            .system_dns_journal()
            .map_err(error)?
            .has_pending()
            .map_err(error)?
    {
        return Err(error(
            "DNS recovery backup is pending. Restore adapter DNS before upgrading the service; backup preserved.",
        ));
    }
    if journal
        .read_controller_config()
        .map_err(error)?
        .is_some_and(|config| config.enabled)
    {
        return Err(error(
            "DNS is still enabled in the protected configuration. Disable it before upgrading.",
        ));
    }
    if physical_adapter_still_uses_local_dns()? {
        return Err(error(
            "An active physical adapter still uses localhost DNS. Upgrade blocked until restoration is verified.",
        ));
    }
    Ok(())
}

fn restore_service_start_type(original: ServiceStartType) -> io::Result<()> {
    let value = match original {
        ServiceStartType::AutoStart => "auto",
        ServiceStartType::OnDemand => "demand",
        ServiceStartType::Disabled => "disabled",
        _ => {
            return Err(error(
                "Unexpected Windows service startup mode; manual review required",
            ))
        }
    };
    let root = env::var_os("SystemRoot").ok_or_else(|| error("SystemRoot missing"))?;
    let output = Command::new(PathBuf::from(root).join("System32").join("sc.exe"))
        .creation_flags(0x0800_0000)
        .args(["config", SERVICE_NAME, "start=", value])
        .output()?;
    if !output.status.success() {
        return Err(error(format!(
            "Could not restore previous service startup mode: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

fn wait_new_service_healthy() -> io::Result<()> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if let Ok(report) = mnebydns_ipc::read_service_status() {
            if report.dns_state.as_deref() == Some("disabled")
                && report.recovery_state.as_deref() == Some("clear")
            {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
    Err(error(
        "New Windows DNS service did not confirm its protected IPC and safe disabled state",
    ))
}

fn upgrade() -> io::Result<()> {
    let journal = ProtectedJournal::open_service().map_err(error)?;
    ensure_upgrade_is_safe(&journal)?;
    let manager = service_manager(false)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS
                | ServiceAccess::QUERY_CONFIG
                | ServiceAccess::STOP
                | ServiceAccess::START,
        )
        .map_err(map_service)?;
    let expected =
        PathBuf::from(env::var_os("ProgramFiles").ok_or_else(|| error("ProgramFiles missing"))?)
            .join(INSTALL_DIR)
            .join(SERVICE_BIN);
    let config = service.query_config().map_err(map_service)?;
    if !is_our_service_path(&config.executable_path, &expected) {
        return Err(error(
            "Installed service executable path mismatch; refusing upgrade",
        ));
    }
    let previous_start_type = config.start_type;
    let was_running =
        service.query_status().map_err(map_service)?.current_state != ServiceState::Stopped;
    let source = env::current_exe()?.with_file_name(SERVICE_BIN);
    ensure_regular_file(&source)?;
    let staged = expected.with_extension("exe.staged");
    let previous = expected.with_extension("exe.previous");
    let failed = expected.with_extension("exe.failed");
    if staged.exists() || failed.exists() {
        return Err(error(
            "An unfinished service upgrade exists; inspect it before retrying",
        ));
    }
    // Preserve the immediately preceding binary during each upgrade, and
    // archive older successful backups instead of blocking future updates.
    if previous.exists() {
        ensure_regular_file(&previous)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| error(err.to_string()))?
            .as_millis();
        let history = expected.with_extension(format!("exe.previous.{nonce}"));
        if history.exists() {
            return Err(error(
                "Cannot archive previous service backup: filename collision",
            ));
        }
        fs::rename(&previous, &history)?;
    }
    copy_new_binary(&source, &staged)?;

    if was_running {
        service.stop().map_err(map_service)?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(30) {
            if service.query_status().map_err(map_service)?.current_state == ServiceState::Stopped {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if service.query_status().map_err(map_service)?.current_state != ServiceState::Stopped {
            let _ = fs::remove_file(&staged);
            return Err(error(
                "Old service could not stop; original executable and DNS backups preserved",
            ));
        }
    }
    // No change to any executable until the *stopped* state and all original
    // adapters have been re-checked. If not safe, restart the original service.
    if let Err(reason) = ensure_upgrade_is_safe(&journal) {
        let _ = fs::remove_file(&staged);
        if was_running && previous_start_type != ServiceStartType::Disabled {
            let _ = service.start::<&str>(&[]);
        }
        return Err(error(format!(
            "DNS changed during upgrade preflight: {reason}"
        )));
    }

    fs::rename(&expected, &previous)?;
    if let Err(err) = fs::rename(&staged, &expected) {
        let rollback = fs::rename(&previous, &expected);
        return Err(error(format!(
            "Failed to replace service binary: {err}; original binary restore: {rollback:?}"
        )));
    }

    let start_attempt = enable_service_autostart()
        .and_then(|_| service.start::<&str>(&[]).map_err(map_service))
        .and_then(|_| wait_new_service_healthy());
    if let Err(start_error) = start_attempt {
        // Never overwrite the executable of a service that might still be
        // running. Preserve both versions if Windows cannot stop it.
        let rollback = (|| -> io::Result<()> {
            if service.query_status().map_err(map_service)?.current_state != ServiceState::Stopped {
                service.stop().map_err(map_service)?;
                let deadline = Instant::now();
                while deadline.elapsed() < Duration::from_secs(15) {
                    if service.query_status().map_err(map_service)?.current_state
                        == ServiceState::Stopped
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                if service.query_status().map_err(map_service)?.current_state
                    != ServiceState::Stopped
                {
                    return Err(error("Cannot roll back a service that is still running"));
                }
            }
            fs::rename(&expected, &failed)?;
            fs::rename(&previous, &expected)?;
            restore_service_start_type(previous_start_type)?;
            if was_running && previous_start_type != ServiceStartType::Disabled {
                service.start::<&str>(&[]).map_err(map_service)?;
            }
            Ok(())
        })();
        return Err(error(format!(
            "New service did not start: {start_error}; original service rollback: {rollback:?}"
        )));
    }
    // A successful SCM start alone is insufficient: the new service must
    // expose an authenticated, fresh, disabled status with no pending backup.
    println!(
        "MnebyDnsHealth upgrade verified by protected IPC; previous service binary preserved."
    );
    Ok(())
}

fn enable(hostname: Option<&str>) -> io::Result<()> {
    // A user can choose a new hostname in Settings, or reuse the pinned DoT
    // endpoint already stored in protected ProgramData after a prior activation.
    let fresh = match hostname {
        Some(value) => {
            let host = value.trim().to_ascii_lowercase();
            let addresses = mnebydns_core::resolve_dot_addresses(&host).map_err(error)?;
            Some((host, addresses))
        }
        None => None,
    };
    ensure_service_installed()?;
    let journal = ProtectedJournal::open_service().map_err(error)?;
    journal.ensure_safe_to_enable().map_err(error)?;
    let config = if let Some((host, addresses)) = fresh {
        ControllerConfig {
            version: 1,
            enabled: true,
            dot_host: host,
            upstream_addresses: addresses,
        }
    } else {
        let mut saved = journal
            .read_controller_config()
            .map_err(error)?
            .ok_or_else(|| {
                error("Не найден сохранённый DoT-адрес. Укажите его в настройках клиента.")
            })?;
        if saved.upstream_addresses.is_empty() {
            return Err(error(
                "Сохранённый DoT-адрес не имеет закреплённых IP. Укажите его заново в настройках.",
            ));
        }
        saved.enabled = true;
        saved
    };
    config.validate().map_err(error)?;
    journal.write_controller_config(&config).map_err(error)?;
    let manager = service_manager(false)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START,
        )
        .map_err(map_service)?;
    if service.query_status().map_err(map_service)?.current_state == ServiceState::Stopped {
        service.start::<&str>(&[]).map_err(map_service)?;
    }
    println!("DNS controller activation requested; service is applying IPv4 and IPv6 DNS to network adapters.");
    Ok(())
}

fn disable() -> io::Result<()> {
    let journal = ProtectedJournal::open_service().map_err(error)?;
    let system_journal = journal.system_dns_journal().map_err(error)?;
    let pending = system_journal.has_pending().map_err(error)?;
    let mut config = match journal.read_controller_config().map_err(error)? {
        Some(value) => value,
        None if pending => ControllerConfig {
            version: 1,
            enabled: false,
            dot_host: "recovery.invalid".to_owned(),
            upstream_addresses: Vec::new(),
        },
        None => {
            if physical_adapter_still_uses_local_dns()? {
                return Err(error(
                    "DNS still uses localhost on an active adapter, but no saved profile or recovery backup was found; cannot confirm safe restoration.",
                ));
            }
            println!("No personal DNS controller configuration or pending adapter backup.");
            return Ok(());
        }
    };
    config.enabled = false;
    journal.write_controller_config(&config).map_err(error)?;
    // If the service was stopped or removed while DNS was active, start the
    // controller only after the disabled state is durable so it restores.
    ensure_service_installed()?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(90) {
        if !system_journal.has_pending().map_err(error)? {
            // If recovery records existed when disable began, their removal
            // proves per-adapter read-back restoration. An original setting
            // may legitimately have been 127.0.0.1, so do not mistake it for
            // a failed rollback after verified snapshot cleanup.
            if pending || !physical_adapter_still_uses_local_dns()? {
                println!("Original IPv4 and IPv6 DNS settings restored and verified.");
                return Ok(());
            }
            return Err(error(
                "System DNS still uses localhost but no original backup was available. Manual review required.",
            ));
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(error("DNS restoration is still pending. The recovery journal is retained; do not delete the service or its ProgramData folder."))
}

fn status() -> io::Result<()> {
    let manager = service_manager(false)?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .map_err(map_service)?;
    let state = service.query_status().map_err(map_service)?;
    println!("{}: {:?}", SERVICE_NAME, state.current_state);
    match ProtectedJournal::open_service() {
        Ok(journal) => {
            match journal.system_dns_journal() {
                Ok(system) => match system.read_all() {
                    Ok(records) => println!("System DNS adapter backups: {}", records.len()),
                    Err(reason) => println!("System DNS journal unreadable: {reason}"),
                },
                Err(reason) => println!("System DNS journal unavailable: {reason}"),
            }
            match journal.read_controller_config() {
                Ok(Some(config)) => println!(
                    "System DNS configured: {}",
                    if config.enabled {
                        "enabled"
                    } else {
                        "disabled"
                    }
                ),
                Ok(None) => println!("System DNS configured: no"),
                Err(reason) => println!("Controller config unreadable: {reason}"),
            }
        }
        Err(reason) => println!("Protected journal not accessible: {reason}"),
    }
    Ok(())
}

/// SCM can store its service binary path enclosed in quotes because the
/// installation directory contains spaces. A different executable or any
/// command-line arguments are rejected, even when this app runs elevated.
fn is_our_service_path(configured: &Path, expected: &Path) -> bool {
    let raw = configured.to_string_lossy();
    let text = raw
        .strip_prefix('"')
        .and_then(|part| part.strip_suffix('"'))
        .unwrap_or(raw.as_ref());
    if text.contains('"') || text.is_empty() {
        return false;
    }
    let actual_path = Path::new(text);
    if !actual_path.is_absolute() {
        return false;
    }
    match (fs::canonicalize(actual_path), fs::canonicalize(expected)) {
        (Ok(actual), Ok(expected)) => actual
            .to_string_lossy()
            .eq_ignore_ascii_case(expected.to_string_lossy().as_ref()),
        _ => false,
    }
}

fn uninstall() -> io::Result<()> {
    // A pending, missing, corrupt or inaccessible recovery record MUST block
    // removal while any adapter may still point at the local DNS listener.
    let journal = ProtectedJournal::open_service().map_err(error)?;
    if journal.check_recovery_pending().map_err(error)? {
        return Err(error("Recovery pending: service uninstall blocked"));
    }
    if journal
        .system_dns_journal()
        .map_err(error)?
        .has_pending()
        .map_err(error)?
    {
        return Err(error("System DNS recovery pending: disable the DNS client and restore all adapters before uninstall"));
    }

    let manager = service_manager(false)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS
                | ServiceAccess::QUERY_CONFIG
                | ServiceAccess::STOP
                | ServiceAccess::DELETE,
        )
        .map_err(map_service)?;
    let config = service.query_config().map_err(map_service)?;
    let expected =
        PathBuf::from(env::var_os("ProgramFiles").ok_or_else(|| error("ProgramFiles missing"))?)
            .join(INSTALL_DIR)
            .join(SERVICE_BIN);
    if !is_our_service_path(&config.executable_path, &expected) {
        return Err(error(format!(
            "Service executable path mismatch: configured={:?}, expected={:?}; refusing to modify another service",
            config.executable_path, expected,
        )));
    }
    if service.query_status().map_err(map_service)?.current_state != ServiceState::Stopped {
        service.stop().map_err(map_service)?;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(12) {
            if service.query_status().map_err(map_service)?.current_state == ServiceState::Stopped {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
        if service.query_status().map_err(map_service)?.current_state != ServiceState::Stopped {
            return Err(error(
                "Service did not stop; refusing to mark it for deletion",
            ));
        }
    }
    service.delete().map_err(map_service)?;
    println!("Diagnostic service marked for removal by Windows SCM.");
    println!("Service executable and protected recovery journal are preserved.");
    println!("Existing DNSProxy and Windows DNS settings have not been changed.");
    Ok(())
}

fn usage() {
    eprintln!(
        "mnebydns-setup.exe [install|upgrade|repair|enable [DoT-host]|disable|restore|status|uninstall]"
    );
    eprintln!("System DNS changes require Windows Administrator approval (UAC).");
}

fn main() {
    let mut args = env::args().skip(1);
    let result = match (args.next().as_deref(), args.next()) {
        (Some("install"), None) => install(),
        (Some("upgrade"), None) => upgrade(),
        (Some("repair"), None) => repair_dns(),
        (Some("enable"), host) if args.next().is_none() => enable(host.as_deref()),
        (Some("disable" | "restore"), None) => disable(),
        (Some("status"), None) => status(),
        (Some("uninstall"), None) => uninstall(),
        _ => {
            usage();
            std::process::exit(2);
        }
    };
    if let Err(err) = result {
        eprintln!("Operation failed safely: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn source_validation_rejects_empty_files_and_missing_paths() {
        let dir = tempdir().unwrap();
        let file = dir.path().join(SERVICE_BIN);
        fs::write(&file, []).unwrap();
        assert!(ensure_regular_file(&file).is_err());
        fs::write(&file, b"mock service binary").unwrap();
        assert_eq!(ensure_regular_file(&file).unwrap(), 19);
        assert!(ensure_regular_file(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn normalized_windows_service_path_rejects_other_executables() {
        let dir = tempdir().unwrap();
        let expected = dir.path().join("diagnostic service.exe");
        fs::write(&expected, b"test").unwrap();
        assert!(is_our_service_path(&expected, &expected));
        let quoted = PathBuf::from(format!("\"{}\"", expected.display()));
        assert!(is_our_service_path(&quoted, &expected));
        let other = dir.path().join("other.exe");
        fs::write(&other, b"test").unwrap();
        assert!(!is_our_service_path(&other, &expected));
        let injected = PathBuf::from(format!("\"{}\" --other", expected.display()));
        assert!(!is_our_service_path(&injected, &expected));
    }

    #[test]
    fn copy_does_not_replace_existing_executable() {
        let dir = tempdir().unwrap();
        let from = dir.path().join("source.exe");
        let to = dir.path().join("target.exe");
        fs::write(&from, b"sample").unwrap();
        copy_new_binary(&from, &to).unwrap();
        assert!(copy_new_binary(&from, &to).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"sample");
    }
}
