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

fn normalize_check_host(input: &str) -> Result<String, String> {
    let host = input.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Ok(host);
    }
    if host.len() > 253
        || !host.contains('.')
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("Введите только домен, например youtube.com, без URL и порта".into());
    }
    Ok(host)
}

#[cfg(windows)]
pub fn compatibility(host: &str) -> Result<serde_json::Value, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let host = normalize_check_host(host)?;
    let root = std::env::var_os("SystemRoot").ok_or("SystemRoot missing")?;
    let executable = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("compatibility.ps1"),
        ])
        .env("MNEBYDNS_CHECK_HOST", host)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|err| format!("Не удалось запустить диагностику Windows: {err}"))?;
    let stdout = child.stdout.take().ok_or("Нет канала диагностики")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(40);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Диагностика Windows не завершилась вовремя".into());
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "Ошибка чтения диагностики")?
        .map_err(|err| err.to_string())?;
    if !status.success() || bytes.len() > 256 * 1024 {
        return Err("Диагностика Windows завершилась ошибкой".into());
    }
    let mut result: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Некорректный ответ диагностики Windows")?;
    let adapters = mnebydns_network::list_adapters()?;
    result["adapters"] = serde_json::to_value(
        adapters
            .into_iter()
            .filter(|adapter| adapter.operational)
            .collect::<Vec<_>>(),
    )
    .map_err(|err| err.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::normalize_check_host;

    #[test]
    fn accepts_only_dns_names() {
        assert_eq!(normalize_check_host(" YouTube.COM. ").unwrap(), "youtube.com");
        assert_eq!(normalize_check_host("").unwrap(), "");
        for bad in ["https://youtube.com", "a.com;whoami", "a.com:443", "127.0.0.1", "-a.com", "a..com"] {
            assert!(normalize_check_host(bad).is_err(), "{bad}");
        }
    }
}
