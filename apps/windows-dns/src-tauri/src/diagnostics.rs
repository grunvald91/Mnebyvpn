//! Read-only Tauri diagnostics. A local JSON file is NOT an authenticated
//! status channel; do not let a normal-user GUI trust it for DNS controls.

use mnebydns_core::{probe_loopback, DnsProbeReport};
use serde::Serialize;

#[derive(Serialize)]
pub struct DnsDiagnosticState {
    pub local: DnsProbeReport,
    pub service: Option<()>,
    pub caution: &'static str,
}

pub fn inspect() -> DnsDiagnosticState {
    DnsDiagnosticState {
        local: probe_loopback(),
        service: None,
        caution:
            "Ответ локального DNS не подтверждает TLS, зарубежный IP или Smart DNS-маршрутизацию.",
    }
}
