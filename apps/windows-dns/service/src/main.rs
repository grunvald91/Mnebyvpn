//! An independent read-only Windows SCM service. Never changes DNS or VPN.
//! All service writes use a protected SYSTEM+Administrators directory.
//! Not registered automatically. IPC/authentication is a future release gate.

use mnebydns_core::{now_ms, probe_loopback, ServiceReport};
use mnebydns_journal::ProtectedJournal;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io;
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

fn publish(journal: &ProtectedJournal) -> io::Result<()> {
    let recovery_state = match journal.check_recovery_pending() {
        Ok(true) => "pending",
        Ok(false) => "clear",
        Err(_) => "unreadable",
    };
    let report = ServiceReport {
        schema_version: 1,
        updated_at_ms: now_ms(),
        probe: probe_loopback(),
        recovery_state: Some(recovery_state.to_owned()),
    };
    let payload = serde_json::to_vec(&report)?;
    let path = journal.protected_status_path().map_err(io::Error::other)?;
    // Only the privileged service owns this file; never publish snapshots or secrets.
    fs::write(path, payload)
}

fn run_service() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Fail closed: if the directory ACL is unsafe or ownership cannot be
    // verified, the privileged service does not start.
    let journal = ProtectedJournal::open_service().map_err(io::Error::other)?;
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

    while !stop.load(Ordering::Acquire) {
        if let Err(error) = publish(&journal) {
            eprintln!("Cannot publish protected health report: {error}");
        }
        for _ in 0..20 {
            if stop.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    // Protected status file remains for later forensic review; consumers must
    // verify a freshness timestamp and must never treat it as authenticated IPC.
    status.current_state = ServiceState::Stopped;
    status.controls_accepted = ServiceControlAccept::empty();
    status_handle.set_service_status(status)?;
    Ok(())
}

fn main() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}
