//! Read-only, strictly local named pipe between diagnostic Windows service and GUI.
//! No DNS control, credentials, or user-provided commands travel over this pipe.
//! Windows client requires a LocalSystem-owned server process; a spoofed pipe
//! from an unprivileged user is rejected even if it wins the name first.

use mnebydns_core::ServiceReport;

pub const MAX_FRAME: usize = 4096;
pub const MAX_STATUS_AGE_MS: u64 = 15_000;

pub fn encode_status(report: &ServiceReport) -> Result<Vec<u8>, String> {
    if report.schema_version != 1 {
        return Err("Unsupported IPC schema".into());
    }
    let mut payload = serde_json::to_vec(report).map_err(|err| err.to_string())?;
    if payload.len() + 1 > MAX_FRAME {
        return Err("IPC status response is too large".into());
    }
    payload.push(b'\n');
    Ok(payload)
}

pub fn decode_status(raw: &[u8], current_ms: u64) -> Result<ServiceReport, String> {
    if raw.len() > MAX_FRAME || raw.last().copied() != Some(b'\n') {
        return Err("Invalid or truncated IPC response".into());
    }
    let status: ServiceReport = serde_json::from_slice(&raw[..raw.len() - 1])
        .map_err(|err| format!("Invalid IPC JSON response: {err}"))?;
    if status.schema_version != 1 {
        return Err("Unsupported IPC schema version".into());
    }
    if current_ms
        .checked_sub(status.updated_at_ms)
        .filter(|age| *age <= MAX_STATUS_AGE_MS)
        .is_none()
    {
        return Err("IPC status is outdated or has an invalid timestamp".into());
    }
    if !matches!(
        status.recovery_state.as_deref(),
        Some("pending" | "clear" | "unreadable")
    ) {
        return Err("Service returned an unknown recovery state".into());
    }
    if status.dns_state.as_deref().is_some_and(|state| {
        !matches!(
            state,
            "disabled" | "starting" | "active" | "restoring" | "error"
        )
    }) {
        return Err("Service returned an unknown DNS controller state".into());
    }
    if status
        .last_error
        .as_ref()
        .is_some_and(|error| error.len() > 1024)
    {
        return Err("Service returned an oversized DNS controller error".into());
    }
    Ok(status)
}

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{read_service_status, serve_local_status};

#[cfg(test)]
mod tests {
    use super::*;
    use mnebydns_core::{DnsProbeReport, EndpointProbe};

    fn sample() -> ServiceReport {
        let probe = EndpointProbe {
            ok: false,
            latency_ms: None,
            answer_count: 0,
            error: Some("not installed".to_owned()),
        };
        ServiceReport {
            schema_version: 1,
            updated_at_ms: 1000,
            probe: DnsProbeReport {
                checked_at_ms: 1000,
                ipv4: probe.clone(),
                ipv6: probe,
            },
            recovery_state: Some("clear".to_owned()),
            dns_state: Some("disabled".to_owned()),
            adapter_count: Some(0),
            configured: false,
            last_error: None,
        }
    }

    #[test]
    fn schema_one_round_trips() {
        let report = sample();
        let encoded = encode_status(&report).unwrap();
        assert_eq!(
            decode_status(&encoded, 1400)
                .unwrap()
                .recovery_state
                .as_deref(),
            Some("clear")
        );
    }

    #[test]
    fn rejects_stale_future_corrupt_or_unterminated_status() {
        let report = sample();
        let encoded = encode_status(&report).unwrap();
        assert!(decode_status(&encoded, 16_100).is_err());
        assert!(decode_status(&encoded, 999).is_err());
        assert!(decode_status(&encoded[..encoded.len() - 1], 1000).is_err());
        let mut garbage = encoded;
        garbage[0] = b'!';
        assert!(decode_status(&garbage, 1000).is_err());
    }

    #[test]
    fn rejects_oversized_and_unrecognized_control_state() {
        let mut report = sample();
        report.recovery_state = Some("activated".into());
        let encoded = encode_status(&report).unwrap();
        assert!(decode_status(&encoded, 1000).is_err());
        assert!(decode_status(&vec![b'a'; MAX_FRAME + 1], 1000).is_err());
        report.schema_version = 2;
        assert!(encode_status(&report).is_err());
    }
}
