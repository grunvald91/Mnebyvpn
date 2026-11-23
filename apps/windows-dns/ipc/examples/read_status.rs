//! Print one authenticated local Windows service status frame.
//! Used for smoke tests after installing the read-only diagnostic service.

#[cfg(windows)]
fn main() {
    match mnebydns_ipc::read_service_status() {
        Ok(status) => {
            println!(
                "Local Windows service status verified: schema={}, journal={}, IPv4={}, IPv6={}",
                status.schema_version,
                status.recovery_state.as_deref().unwrap_or("unknown"),
                status.probe.ipv4.ok,
                status.probe.ipv6.ok,
            );
            mnebydns_ipc::send_recovery()
                .expect("Independent LocalSystem recovery service must respond without UAC");
            println!("Independent recovery broker verified without elevation");
            // A freshly installed idle service has no saved DoT profile.
            // The control pipe must exist, be SCM-PID-authenticated, and
            // reject activation or deactivation without a profile.
            match mnebydns_ipc::send_control(mnebydns_ipc::ControlRequest::Disable) {
                Err(message) if message.contains("Служба отклонила") => {
                    println!("Authenticated control pipe verified; unconfigured request rejected");
                }
                Ok(()) => {
                    eprintln!("CRITICAL: control pipe unexpectedly accepted unconfigured request");
                    std::process::exit(1);
                }
                Err(error) => {
                    eprintln!("Cannot authenticate new service control pipe: {error}");
                    std::process::exit(1);
                }
            }
        }
        Err(error) => {
            eprintln!("Cannot read authenticated local service status: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows-only diagnostic service smoke test");
    std::process::exit(2);
}
