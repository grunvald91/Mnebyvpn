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
            smoke_local_dot_proxy
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
