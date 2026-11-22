//! An independent read-only Windows SCM service.
//! Does not manage DNSProxy, adapters, routes, VPNs, or system configuration.
//! Not installed automatically; setup/ACL hardening is a separate release gate.

use mnebydns_core::{now_ms, probe_loopback, ServiceReport};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

const SERVICE_NAME: &str = "MnebyDnsHealth";

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    if let Err(error) = run_service() {
        eprintln!("MnebyDnsHealth service failed: {error}");
    }
}

fn status_path() -> io::Result<PathBuf> {
    let program_data = std::env::var_os("ProgramData").ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "ProgramData is missing")
    })?;
    Ok(PathBuf::from(program_data)
        .join("mnebyDNS")
        .join("health-v1.json"))
}

fn publish(path: &PathBuf) -> io::Result<()> {
    let report = ServiceReport {
        schema_version: 1,
        updated_at_ms: now_ms(),
        probe: probe_loopback(),
    };
    let json = serde_json::to_vec(&report)?;
    let directory = path.parent().ok_or_else(|| io::Error::other("No status directory"))?;
    fs::create_dir_all(directory)?;
    // This file only carries read-only diagnostic data and is never used for control.
    fs::write(path, json)
}

fn run_service() -> windows_service::Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::clone(&stop);
    let handler = move |control_event| match control_event {
        ServiceControl::Stop => {
            cancel.store(true, Ordering::Release);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status_handle = service_control_handler::register(SERVICE_NAME, handler)?;
    let mut status = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    };
    status_handle.set_service_status(status.clone())?;

    let path = status_path().ok();
    while !stop.load(Ordering::Acquire) {
        if let Some(ref path) = path {
            let _ = publish(path);
        }
        for _ in 0..20 {
            if stop.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    if let Some(ref path) = path {
        let _ = fs::remove_file(path);
    }
    status.current_state = ServiceState::Stopped;
    status.controls_accepted = ServiceControlAccept::empty();
    status_handle.set_service_status(status)?;
    Ok(())
}

fn main() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}
