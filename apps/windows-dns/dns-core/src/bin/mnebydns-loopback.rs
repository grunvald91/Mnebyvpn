//! Preview-only local DNS server. Requires MNEBYDNS_DOT_HOST in process
//! environment, never on the command line. This process does not change
//! system DNS and must be supervised by an external controller.
use mnebydns_core::LoopbackDnsServer;
use std::time::Duration;

fn main() {
    let host = match std::env::var("MNEBYDNS_DOT_HOST") {
        Ok(host) if !host.is_empty() => host,
        _ => {
            eprintln!("No transient personal DoT hostname supplied");
            std::process::exit(2);
        }
    };
    // Avoid keeping a second copy of the personal key in the child process
    // environment. The Rust DNS bridge retains it only in process memory.
    std::env::remove_var("MNEBYDNS_DOT_HOST");
    let _server = match LoopbackDnsServer::start(&host, 53) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("Local UDP/TCP DNS listeners could not start: {error}");
            std::process::exit(3);
        }
    };
    eprintln!("Local DNS loopback started (IPv4+IPv6, UDP+TCP port 53).");
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
