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

#[cfg(windows)]
const EXPECTED_SYSTEM_DNS_SCRIPT: &[u8] = include_bytes!("../../SYSTEM-DNS.ps1");

#[cfg(windows)]
fn system_dns_script() -> Result<std::path::PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|_| "Не удалось определить путь приложения".to_owned())?;
    let path = exe
        .parent()
        .ok_or_else(|| "Не удалось определить каталог приложения".to_owned())?
        .join("SYSTEM-DNS.ps1");
    let bytes = std::fs::read(&path)
        .map_err(|_| "Не найден SYSTEM-DNS.ps1. Распакуйте весь ZIP-архив.".to_owned())?;
    if bytes != EXPECTED_SYSTEM_DNS_SCRIPT {
        return Err("SYSTEM-DNS.ps1 изменён: отказ от запуска с правами администратора. Скачайте чистый ZIP.".into());
    }
    Ok(path)
}

#[cfg(windows)]
fn powershell_path() -> Result<std::path::PathBuf, String> {
    let root = std::env::var_os("SystemRoot")
        .ok_or_else(|| "Не найден системный каталог Windows".to_owned())?;
    let path = std::path::PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !path.is_file() {
        return Err("Не найден системный PowerShell Windows".into());
    }
    Ok(path)
}

/// Launch the audited, bundled SYSTEM-DNS.ps1 through an explicit Windows
/// elevation prompt. This function never passes the personal DoT host as a
/// command-line argument or claims that UAC/activation has succeeded.
#[tauri::command]
fn launch_system_dns_trial(action: String) -> Result<String, String> {
    if action != "Enable" && action != "Disable" {
        return Err("Недопустимая операция системного DNS".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
            value.encode_wide().chain(std::iter::once(0)).collect()
        }
        let script = system_dns_script()?;
        let shell = powershell_path()?;
        let args = format!(
            "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{}\" -Action {action}",
            script.display()
        );
        let runas = wide(std::ffi::OsStr::new("runas"));
        let program = wide(shell.as_os_str());
        let parameters = wide(std::ffi::OsStr::new(&args));
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                runas.as_ptr(),
                program.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                1,
            )
        };
        if result as usize <= 32 {
            return Err("Windows не запустила запрос прав администратора (UAC)".into());
        }
        Ok("Запрос UAC открыт. Само включение ещё не подтверждено. Проверьте состояние после завершения операции.".into())
    }
    #[cfg(not(windows))]
    {
        Err("Системный DNS доступен только в Windows".into())
    }
}

#[tauri::command]
async fn system_dns_status() -> Result<String, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(|| {
            let script = system_dns_script()?;
            let shell = powershell_path()?;
            let output = std::process::Command::new(shell)
                .arg("-NoLogo")
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(script)
                .arg("-Action")
                .arg("Status")
                .output()
                .map_err(|_| "Не удалось прочитать политику DNS Windows".to_owned())?;
            if !output.status.success() {
                return Err("Windows не смогла проверить правила NRPT".to_owned());
            }
            let response = String::from_utf8_lossy(&output.stdout);
            let result = response.trim();
            match result {
                "ACTIVE" => Ok("ACTIVE".to_owned()),
                "OFF" => Ok("OFF".to_owned()),
                _ => Err("Неоднозначный ответ Windows NRPT".to_owned()),
            }
        })
        .await
        .map_err(|_| "Сбой проверки статуса системного DNS".to_owned())?;
    }
    #[cfg(not(windows))]
    Err("Системный DNS доступен только в Windows".into())
}

#[tauri::command]
fn get_ui_mode() -> &'static str {
    "Диагностика: только чтение. Настройки DNS Windows не изменяются"
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
            launch_system_dns_trial,
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
