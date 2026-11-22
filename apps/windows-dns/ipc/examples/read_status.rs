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
