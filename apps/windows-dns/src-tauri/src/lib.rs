mod diagnostics;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
async fn preflight_dns_adapter(guid: String) -> Result<mnebydns_network::AdapterPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || mnebydns_network::preflight_adapter(&guid))
        .await
        .map_err(|error| format!("Предпроверка DNS не выполнена: {error}"))?
}

#[tauri::command]
async fn list_network_adapters() -> Result<Vec<mnebydns_network::AdapterInfo>, String> {
    tauri::async_runtime::spawn_blocking(mnebydns_network::list_adapters)
        .await
        .map_err(|error| format!("Не удалось получить список адаптеров: {error}"))?
}

#[tauri::command]
async fn probe_personal_dot(host: String) -> Result<mnebydns_core::DotProbeReport, String> {
    tauri::async_runtime::spawn_blocking(move || mnebydns_core::probe_dot_strict(&host))
        .await
        .map_err(|_| "Проверка DoT завершилась внутренней ошибкой".to_owned())?
}

#[tauri::command]
async fn smoke_local_dot_proxy(host: String) -> Result<mnebydns_core::UdpDotSmokeReport, String> {
    tauri::async_runtime::spawn_blocking(move || mnebydns_core::smoke_udp_dot_preview(&host))
        .await
        .map_err(|_| {
            "Проверка локального UDP/DoT-прокси завершилась внутренней ошибкой".to_owned()
        })?
}

/// Run the elevated installer only when the existing protected profile needs
/// initial setup, a deliberate server change, recovery on a legacy service, or
/// a safe one-time service upgrade. Never open a visible console window.
#[cfg(windows)]
fn run_elevated_setup(command: &str) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }
    let exe = std::env::current_exe().map_err(|_| "Не найден путь приложения".to_owned())?;
    let helper = exe
        .parent()
        .ok_or_else(|| "Не найден каталог приложения".to_owned())?
        .join("mnebydns-setup.exe");
    if !helper.is_file() {
        return Err("Файл mnebydns-setup.exe не найден. Распакуйте полный архив.".to_owned());
    }
    let verb = wide(std::ffi::OsStr::new("runas"));
    let program = wide(helper.as_os_str());
    let parameters = wide(std::ffi::OsStr::new(command));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = program.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = 0; // SW_HIDE: the elevated setup helper must remain invisible.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let code = unsafe { GetLastError() };
        return Err(if code == 1223 {
            "Подтверждение администратора отменено".to_owned()
        } else {
            format!("Windows не удалось запустить DNS-установщик (ошибка {code})")
        });
    }
    if info.hProcess.is_null() {
        return Err("Не удалось отслеживать выполнение DNS-установщика".to_owned());
    }
    let result = unsafe { WaitForSingleObject(info.hProcess, 120_000) };
    let mut exit_code = 0u32;
    let read_code = result == WAIT_OBJECT_0
        && unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) } != 0;
    unsafe { CloseHandle(info.hProcess) };
    if !read_code {
        return Err(
            "Установщик не подтвердил завершение операции. Проверьте состояние DNS.".to_owned(),
        );
    }
    if exit_code != 0 {
        return Err(format!(
            "Установщик не завершил операцию (код {exit_code}). Исходные настройки не считаются восстановленными."
        ));
    }
    Ok("Запрос выполнен. Проверяю фактическое состояние службы и адаптеров.".to_owned())
}

#[tauri::command]
async fn launch_system_dns_action(action: String, host: Option<String>) -> Result<String, String> {
    if !matches!(action.as_str(), "Enable" | "Disable" | "Upgrade") {
        return Err("Недопустимая операция системного DNS".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use mnebydns_ipc::{send_control, ControlRequest};
            match action.as_str() {
                "Enable" => {
                    if let Some(hostname) = host.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
                        mnebydns_core::resolve_dot_addresses(hostname)?;
                        run_elevated_setup(&format!("enable {}", hostname.to_ascii_lowercase()))
                    } else {
                        send_control(ControlRequest::EnableSaved).map_err(|error| {
                            if error == "CONTROL_PIPE_UNAVAILABLE" {
                                "Обнаружена старая служба DNS. Сначала восстановите DNS и обновите службу в настройках.".to_owned()
                            } else { error }
                        })?;
                        Ok("Сохранённый профиль включается через службу — без UAC.".to_owned())
                    }
                }
                "Disable" => match send_control(ControlRequest::Disable) {
                    Ok(()) => Ok("Команда выключения передана службе. Проверяю восстановление DNS.".to_owned()),
                    Err(error) if error == "CONTROL_PIPE_UNAVAILABLE" => {
                        // Explicit recovery path for an installed older service.
                        run_elevated_setup("disable")
                    }
                    Err(error) => Err(error),
                },
                "Upgrade" => run_elevated_setup("upgrade"),
                _ => unreachable!(),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = host;
            Err("Управление системным DNS поддерживается только в Windows".to_owned())
        }
    }).await.map_err(|_| "Не удалось получить результат системной операции".to_owned())?
}

/// Distinguish first launch from a broken installed service. A connection
/// failure to the IPC pipe alone is NOT evidence that DNS is safely disabled.
#[cfg(windows)]
fn service_not_installed() -> bool {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS,
    };
    let manager = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if manager.is_null() {
        return false;
    }
    let name: Vec<u16> = "MnebyDnsHealth".encode_utf16().chain([0]).collect();
    let service = unsafe { OpenServiceW(manager, name.as_ptr(), SERVICE_QUERY_STATUS) };
    let absent = service.is_null() && unsafe { GetLastError() } == 1060;
    if !service.is_null() {
        unsafe { CloseServiceHandle(service) };
    }
    unsafe { CloseServiceHandle(manager) };
    absent
}

#[tauri::command]
async fn system_dns_status() -> Result<mnebydns_core::ServiceReport, String> {
    tauri::async_runtime::spawn_blocking(|| match mnebydns_ipc::read_service_status() {
        Ok(report) => Ok(report),
        Err(error) => {
            #[cfg(windows)]
            if service_not_installed() {
                return Err("SERVICE_NOT_INSTALLED".to_owned());
            }
            Err(error)
        }
    })
    .await
    .map_err(|_| "Не удалось получить статус службы DNS".to_owned())?
}

#[tauri::command]
fn get_ui_mode() -> &'static str {
    "Полноценный системный DNS-клиент мнебыDNS"
}

#[tauri::command]
fn hide_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
async fn inspect_dns() -> Result<diagnostics::DnsDiagnosticState, String> {
    tauri::async_runtime::spawn_blocking(diagnostics::inspect)
        .await
        .map_err(|error| format!("Диагностика не выполнена: {error}"))
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_ui_mode,
            hide_to_tray,
            inspect_dns,
            list_network_adapters,
            preflight_dns_adapter,
            probe_personal_dot,
            smoke_local_dot_proxy,
            launch_system_dns_action,
            system_dns_status
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Открыть мнебыDNS", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Скрыть окно", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти из приложения", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &hide, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("мнебыDNS — диагностика")
                .menu(&menu)
                .show_menu_on_left_click(false);

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "open" => show_main(app),
                "hide" => hide_main(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Failed to run mnebyDNS");
}
