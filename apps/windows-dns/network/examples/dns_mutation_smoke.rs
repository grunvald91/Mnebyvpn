//! Disposable Windows CI runner only. Mutates one active interface briefly,
//! then restores and verifies the exact IPv4/IPv6 DNS source snapshot.
use mnebydns_network::{
    apply_adapter_loopback_dns, capture_adapter_dns, list_adapters, restore_adapter_dns,
    verify_adapter_loopback_dns, verify_adapter_restored,
};

fn main() -> Result<(), String> {
    let adapter = list_adapters()?
        .into_iter()
        .find(|item| item.operational && !item.is_loopback)
        .ok_or_else(|| "No active non-loopback adapter on disposable runner".to_owned())?;
    let snapshot = capture_adapter_dns(&adapter.guid)?;
    let apply_result = apply_adapter_loopback_dns(&adapter.guid)
        .and_then(|_| verify_adapter_loopback_dns(&adapter.guid));
    let restore_result = restore_adapter_dns(&snapshot)
        .and_then(|_| verify_adapter_restored(&snapshot));
    if let Err(error) = restore_result {
        return Err(format!(
            "CRITICAL: DNS mutation smoke test could not restore {}: {}",
            adapter.name, error
        ));
    }
    apply_result.map_err(|error| {
        format!(
            "Native DNS write/read-back failed on {} (original settings restored): {}",
            adapter.name, error
        )
    })?;
    println!(
        "Native IPv4/IPv6 DNS apply and exact restore passed on {} ({})",
        adapter.name, adapter.guid
    );
    Ok(())
}
