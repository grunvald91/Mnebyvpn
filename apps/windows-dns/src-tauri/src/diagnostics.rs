//! Tauri-side read-only bridge for localhost DNS and the optional Windows service.

use mnebydns_core::{now_ms, probe_loopback, DnsProbeReport, ServiceReport};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct DnsDiagnosticState {
    pub local: DnsProbeReport,
    pub service: Option<ServiceReport>,
    pub caution: &'static str,
}

fn service_status_path() -> Option<PathBuf> {
    let dir = std::env::var_os("ProgramData")?;
    Some(PathBuf::from(dir).join("mnebyDNS").join("health-v1.json"))
}

fn recent_service_status() -> Option<ServiceReport> {
    let path = service_status_path()?;
    let file = std::fs::read(path).ok()?;
    if file.len() > 8192 {
        return None;
    }
    let report: ServiceReport = serde_json::from_slice(&file).ok()?;
    let age = now_ms().checked_sub(report.updated_at_ms)?;
    if report.schema_version != 1 || age > 15_000 {
        return None;
    }
    Some(report)
}

pub fn inspect() -> DnsDiagnosticState {
    DnsDiagnosticState {
        local: probe_loopback(),
        service: recent_service_status(),
        caution:
            "Ответ локального DNS не подтверждает TLS, зарубежный IP или Smart DNS-маршрутизацию.",
    }
}
