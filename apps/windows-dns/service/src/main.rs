//! Persistent Windows DNS controller service.
//! Owns the authenticated DoT loopback listener, per-interface IPv4/IPv6 DNS
//! configuration, and crash-safe recovery journal. No plaintext fallback.

use mnebydns_core::{now_ms, probe_loopback, LoopbackDnsServer, ServiceReport};
use mnebydns_ipc::serve_local_status;
use mnebydns_journal::{ControllerConfig, ProtectedJournal, SystemDnsJournal};
use mnebydns_network::{
    apply_adapter_loopback_dns, capture_adapter_dns, list_adapters, restore_adapter_dns,
    verify_adapter_loopback_dns, verify_adapter_restored, AdapterDnsSnapshot,
};
use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};
use std::thread;
use std::time::Duration;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

const SERVICE_NAME: &str = "MnebyDnsHealth";
const LOOPBACK_PORT: u16 = 53;
const POLL_INTERVAL: Duration = Duration::from_secs(2);

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    if let Err(error) = run_service() {
        eprintln!("MnebyDnsHealth service failed: {error}");
    }
}

fn publish(
    journal: &ProtectedJournal,
    system_journal: &SystemDnsJournal,
    state: &str,
    adapter_count: u32,
    last_error: Option<&str>,
) -> io::Result<ServiceReport> {
    let recovery_state = match (
        journal.check_recovery_pending(),
        system_journal.has_pending(),
    ) {
        (Ok(false), Ok(false)) => "clear",
        (Ok(true), _) | (_, Ok(true)) => "pending",
        _ => "unreadable",
    };
    let report = ServiceReport {
        schema_version: 1,
        updated_at_ms: now_ms(),
        probe: probe_loopback(),
        recovery_state: Some(recovery_state.to_owned()),
        dns_state: Some(state.to_owned()),
        adapter_count: Some(adapter_count),
        last_error: last_error.map(|value| value.chars().take(1024).collect()),
    };
    let payload = serde_json::to_vec(&report)?;
    let path = journal.protected_status_path().map_err(io::Error::other)?;
    fs::write(path, payload)?;
    Ok(report)
}

fn restore_all(system_journal: &mut SystemDnsJournal) -> Result<(), String> {
    let snapshots = system_journal.read_all()?;
    let current = list_adapters()?;
    for snapshot in snapshots {
        if !current
            .iter()
            .any(|adapter| adapter.guid.eq_ignore_ascii_case(&snapshot.interface_guid))
        {
            // A disconnected adapter is still returned by IP Helper. If the
            // GUID is absent altogether, retain its journal for manual review.
            return Err(format!(
                "Адаптер {} ({}) больше не обнаружен; исходный DNS backup сохранён",
                snapshot.adapter_name, snapshot.interface_guid
            ));
        }
        restore_adapter_dns(&snapshot)?;
        verify_adapter_restored(&snapshot)?;
        system_journal.clear_verified(&snapshot.interface_guid)?;
    }
    if system_journal.has_pending()? {
        return Err("Остались не восстановленные DNS snapshots".into());
    }
    Ok(())
}

fn ensure_snapshots(
    system_journal: &mut SystemDnsJournal,
    adapters: &[mnebydns_network::AdapterInfo],
) -> Result<Vec<AdapterDnsSnapshot>, String> {
    let mut snapshots = system_journal.read_all()?;
    for adapter in adapters.iter().filter(|item| !item.is_loopback) {
        if snapshots.iter().any(|saved| {
            saved.interface_guid.eq_ignore_ascii_case(&adapter.guid)
        }) {
            continue;
        }
        // The per-adapter recovery record is committed before any DNS write.
        let snapshot = capture_adapter_dns(&adapter.guid)?;
        system_journal.save_before_change(&snapshot)?;
        snapshots.push(snapshot);
    }
    Ok(snapshots)
}

fn apply_all(
    system_journal: &mut SystemDnsJournal,
    applied: &mut HashSet<String>,
) -> Result<u32, String> {
    let adapters = list_adapters()?;
    let targets: Vec<_> = adapters
        .iter()
        .filter(|adapter| !adapter.is_loopback)
        .collect();
    if targets.is_empty() {
        return Err("Windows не обнаружила сетевых адаптеров для системного DNS".into());
    }

    let snapshots = ensure_snapshots(system_journal, &adapters)?;
    let mut applied_count = 0u32;
    for adapter in targets {
        let guid = adapter.guid.to_ascii_lowercase();
        let saved = snapshots
            .iter()
            .find(|snapshot| snapshot.interface_guid.eq_ignore_ascii_case(&guid))
            .ok_or_else(|| format!("Нет recovery backup для адаптера {}", adapter.name))?;

        let already_applied = applied.contains(&guid);
        let needs_apply = if already_applied && adapter.operational {
            verify_adapter_loopback_dns(&guid).is_err()
        } else {
            !already_applied
        };
        if needs_apply {
            if let Err(apply_error) = apply_adapter_loopback_dns(&guid) {
                let rollback = restore_adapter_dns(saved)
                    .and_then(|_| verify_adapter_restored(saved))
                    .and_then(|_| system_journal.clear_verified(&guid));
                applied.remove(&guid);
                return Err(match rollback {
                    Ok(()) => format!(
                        "Не удалось применить DNS к {}: {}; исходные настройки восстановлены",
                        adapter.name, apply_error
                    ),
                    Err(restore_error) => format!(
                        "Не удалось применить DNS к {}: {}; ОШИБКА ВОССТАНОВЛЕНИЯ: {}",
                        adapter.name, apply_error, restore_error
                    ),
                });
            }
            if adapter.operational {
                if let Err(verify_error) = verify_adapter_loopback_dns(&guid) {
                    let rollback = restore_adapter_dns(saved)
                        .and_then(|_| verify_adapter_restored(saved))
                        .and_then(|_| system_journal.clear_verified(&guid));
                    applied.remove(&guid);
                    return Err(match rollback {
                        Ok(()) => format!(
                            "DNS адаптера {} не прошёл проверку: {}; исходные настройки восстановлены",
                            adapter.name, verify_error
                        ),
                        Err(restore_error) => format!(
                            "DNS адаптера {} не прошёл проверку: {}; ОШИБКА ВОССТАНОВЛЕНИЯ: {}",
                            adapter.name, verify_error, restore_error
                        ),
                    });
                }
            }
            applied.insert(guid.clone());
        } else if adapter.operational {
            // Verify effective resolvers every poll to detect VPN/DHCP changes.
            if let Err(verify_error) = verify_adapter_loopback_dns(&guid) {
                apply_adapter_loopback_dns(&guid)?;
                verify_adapter_loopback_dns(&guid).map_err(|retry_error| {
                    format!(
                        "DNS адаптера {} не проходит проверку: {}; повтор: {}",
                        adapter.name, verify_error, retry_error
                    )
                })?;
            }
        }
        applied_count += 1;
    }
    Ok(applied_count)
}

fn validate_server(
    host: &str,
    addresses: &[std::net::SocketAddr],
) -> Result<(), String> {
    if addresses.is_empty()
        || addresses.len() > 5
        || addresses.iter().any(|address| {
            address.port() != 853
                || address.ip().is_loopback()
                || address.ip().is_unspecified()
                || address.ip().is_multicast()
        })
    {
        return Err("Некорректный закреплённый адрес DoT-сервера".into());
    }
    if host.len() < 4 || host.len() > 253 || !host.is_ascii() {
        return Err("Некорректное имя DoT-сервера".into());
    }
    Ok(())
}

fn run_service() -> Result<(), Box<dyn Error + Send + Sync>> {
    let journal = ProtectedJournal::open_service().map_err(io::Error::other)?;
    let mut system_journal = journal.system_dns_journal().map_err(io::Error::other)?;

    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::clone(&stop);
    let handler = move |control_event| match control_event {
        ServiceControl::Stop => {
            cancel.store(true, Ordering::Release);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status_handle = service_control_handler::register(SERVICE_NAME, handler)?;
    let mut status = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    };
    status_handle.set_service_status(status.clone())?;

    let initial = publish(&journal, &system_journal, "disabled", 0, None)?;
    let shared = Arc::new(RwLock::new(initial));
    let pipe_data = Arc::clone(&shared);
    thread::spawn(move || {
        if let Err(error) = serve_local_status(pipe_data) {
            eprintln!("Authenticated status pipe stopped: {error}");
        }
    });

    let mut server: Option<LoopbackDnsServer> = None;
    let mut server_config: Option<ControllerConfig> = None;
    let mut applied = HashSet::<String>::new();
    let mut state = "disabled".to_owned();
    let mut last_error: Option<String> = None;
    let mut adapter_count = 0u32;

    while !stop.load(Ordering::Acquire) {
        let config = journal.read_controller_config().map_err(io::Error::other)?;
        let should_enable = config.as_ref().is_some_and(|value| value.enabled);

        if should_enable {
            let config = config.expect("enabled config checked above");
            validate_server(&config.dot_host, &config.upstream_addresses)?;
            let needs_server_restart = server.is_none()
                || server_config.as_ref().is_none_or(|old| {
                    old.dot_host != config.dot_host
                        || old.upstream_addresses != config.upstream_addresses
                });
            if needs_server_restart {
                state = "starting".to_owned();
                server.take();
                match LoopbackDnsServer::start_pinned(
                    &config.dot_host,
                    config.upstream_addresses.clone(),
                    LOOPBACK_PORT,
                ) {
                    Ok(started) => {
                        // Prove both local address families can answer through
                        // authenticated DoT before writing any adapter DNS.
                        let probe = probe_loopback();
                        if !probe.ipv4.ok || !probe.ipv6.ok {
                            drop(started);
                            server = None;
                            let error = format!(
                                "Проверка локального DNS не прошла: IPv4={:?}; IPv6={:?}",
                                probe.ipv4.error, probe.ipv6.error
                            );
                            let _ = journal.write_controller_config(&ControllerConfig {
                                enabled: false,
                                ..config.clone()
                            });
                            last_error = Some(error);
                            state = "error".to_owned();
                            applied.clear();
                            thread::sleep(POLL_INTERVAL);
                            continue;
                        }
                        server = Some(started);
                        server_config = Some(config.clone());
                    }
                    Err(error) => {
                        let _ = journal.write_controller_config(&ControllerConfig {
                            enabled: false,
                            ..config.clone()
                        });
                        last_error = Some(error);
                        state = "error".to_owned();
                        applied.clear();
                        thread::sleep(POLL_INTERVAL);
                        continue;
                    }
                }
            }

            state = "starting".to_owned();
            match apply_all(&mut system_journal, &mut applied) {
                Ok(count) => {
                    adapter_count = count;
                    state = "active".to_owned();
                    last_error = None;
                }
                Err(error) => {
                    state = "error".to_owned();
                    last_error = Some(error);
                    // Keep the listener and the durable backup alive. The
                    // service retries newly appearing or reconfigured adapters.
                }
            }
        } else {
            if system_journal.has_pending().unwrap_or(true) {
                state = "restoring".to_owned();
                match restore_all(&mut system_journal) {
                    Ok(()) => {
                        server.take();
                        server_config = None;
                        applied.clear();
                        adapter_count = 0;
                        state = "disabled".to_owned();
                        last_error = None;
                    }
                    Err(error) => {
                        state = "error".to_owned();
                        last_error = Some(error);
                    }
                }
            } else {
                server.take();
                server_config = None;
                applied.clear();
                adapter_count = 0;
                state = "disabled".to_owned();
                last_error = None;
            }
        }

        if let Ok(report) = publish(
            &journal,
            &system_journal,
            &state,
            adapter_count,
            last_error.as_deref(),
        ) {
            if let Ok(mut current) = shared.write() {
                *current = report;
            }
        }
        thread::sleep(POLL_INTERVAL);
    }

    // A normal service stop restores the user's original DNS before the
    // listener exits. If restoration fails, the journal is retained.
    if system_journal.has_pending().unwrap_or(true) {
        if let Err(error) = restore_all(&mut system_journal) {
            eprintln!("Service stop blocked by pending DNS recovery: {error}");
            status.current_state = ServiceState::Running;
            status_handle.set_service_status(status.clone())?;
            // Do not exit while system DNS still points to localhost.
            loop {
                thread::sleep(POLL_INTERVAL);
                if restore_all(&mut system_journal).is_ok() {
                    break;
                }
            }
        }
    }
    server.take();

    status.current_state = ServiceState::Stopped;
    status.controls_accepted = ServiceControlAccept::empty();
    status_handle.set_service_status(status)?;
    Ok(())
}

fn main() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}
