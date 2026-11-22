//! Read-only GUI bridge: inspect localhost DNS and explicitly authenticated,
//! LocalSystem-owned, remote-disallowed named pipe service status.

use mnebydns_core::{probe_loopback, DnsProbeReport, ServiceReport};
use serde::Serialize;

#[derive(Serialize)]
pub struct DnsDiagnosticState {
    pub local: DnsProbeReport,
    pub service: Option<ServiceReport>,
    pub service_error: Option<String>,
    pub caution: &'static str,
}

pub fn inspect() -> DnsDiagnosticState {
    let (service, service_error) = match mnebydns_ipc::read_service_status() {
        Ok(status) => (Some(status), None),
        Err(error) => (None, Some(error)),
    };
    DnsDiagnosticState {
        local: probe_loopback(),
        service,
        service_error,
        caution:
            "Ответ локального DNS не подтверждает TLS, зарубежный IP или Smart DNS-маршрутизацию.",
    }
}
