//! Non-mutating Windows runner integration check for native DNS evidence.
//! Do not print adapter names, addresses or other local machine details.
use mnebydns_network::{list_adapters, preflight_adapter};

fn main() -> Result<(), String> {
    let adapters = list_adapters()?;
    let mut inspected = 0usize;
    let mut ipv4_reads = 0usize;
    let mut registry_reads = 0usize;
    for adapter in adapters
        .iter()
        .filter(|adapter| adapter.operational && !adapter.is_loopback)
    {
        let report = preflight_adapter(&adapter.guid)?;
        if report.mutation_enabled || report.recovery_ready {
            return Err("An unverified DNS preflight exposed mutation readiness".into());
        }
        if report.ipv6.is_some() || report.ipv6_error.is_none() {
            return Err("Undocumented IPv6 interface source read was presented as verified".into());
        }
        if report.recovery_blockers.is_empty() {
            return Err("Unverified backup must report at least one blocker".into());
        }
        if report.registry.is_some() == report.registry_error.is_some() {
            return Err("Registry evidence and error must be mutually exclusive".into());
        }
        if report.registry.is_some() {
            registry_reads += 1;
        }
        if report.ipv4.is_some() {
            ipv4_reads += 1;
        }
        inspected += 1;
    }
    if inspected == 0 || ipv4_reads == 0 {
        return Err("No operational adapter returned native IPv4 DNS evidence".into());
    }
    if registry_reads == 0 {
        return Err("No operational adapter yielded readable DNS registry evidence".into());
    }
    println!("PASS: native read-only DNS preflight and registry; no Windows DNS mutation");
    Ok(())
}
