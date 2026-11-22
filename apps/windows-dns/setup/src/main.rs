//! Native Windows SCM bootstrap for the READ-ONLY diagnostic service.
//! It never changes network adapters, DNSProxy, routes, or Windows DNS settings.
//! This is an unsigned developer preview, NOT a production installer.

use mnebydns_journal::ProtectedJournal;
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
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
        display_name: OsString::from("мнебыDNS — диагностика (только чтение)"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::OnDemand,
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
        .set_description("Read-only mnebyDNS localhost diagnostics. Does not change DNS or VPN.")
        .map_err(map_service)?;
    service.start::<&str>(&[]).map_err(map_service)?;
    println!("Diagnostic service installed and started (OnDemand).");
    println!("Windows DNS settings and existing DNSProxy were NOT changed.");
    Ok(())
}

fn status() -> io::Result<()> {
    let manager = service_manager(false)?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .map_err(map_service)?;
    let state = service.query_status().map_err(map_service)?;
    println!("{}: {:?}", SERVICE_NAME, state.current_state);
    match ProtectedJournal::open_service() {
        Ok(journal) => match journal.check_recovery_pending() {
            Ok(true) => println!("Recovery journal: PENDING (do not delete)"),
            Ok(false) => println!("Recovery journal: clear"),
            Err(reason) => println!("Recovery journal unreadable: {reason}"),
        },
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
    // removal. This applies even to the current diagnostics-only service.
    let journal = ProtectedJournal::open_service().map_err(error)?;
    if journal.check_recovery_pending().map_err(error)? {
        return Err(error("Recovery pending: service uninstall blocked"));
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
    eprintln!("mnebydns-setup.exe [install|status|uninstall]");
    eprintln!("install/uninstall require an elevated Windows Administrator terminal.");
    eprintln!("This is a diagnostic service only. It never changes DNS settings.");
}

fn main() {
    let mut args = env::args().skip(1);
    let result = match (args.next().as_deref(), args.next()) {
        (Some("install"), None) => install(),
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
        let quoted = PathBuf::from(format!("\\\"{}\\\"", expected.display()));
        assert!(is_our_service_path(&quoted, &expected));
        let other = dir.path().join("other.exe");
        fs::write(&other, b"test").unwrap();
        assert!(!is_our_service_path(&other, &expected));
        let injected = PathBuf::from(format!("\\\"{}\\\" --other", expected.display()));
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
