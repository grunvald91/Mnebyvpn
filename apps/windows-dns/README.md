# мнебыDNS — полноценный Windows DNS-клиент

Клиент на Rust/Tauri для системного DNS Windows 10/11. Он использует персональный DNS-over-TLS (DoT) как upstream и локальный DNS-сервер на компьютере.

## Как работает

1. GUI принимает персональный DoT hostname и проверяет его до изменения Windows DNS.
2. mnebydns-setup.exe получает стандартное подтверждение UAC, сохраняет hostname и закреплённые IP DoT в защищённой конфигурации %ProgramData%\mnebydns-controller-v1.
3. Устанавливается Windows-служба MnebyDnsHealth с автоматическим запуском при старте Windows и SCM recovery actions.
4. Служба поднимает локальный DNS resolver на 127.0.0.1 и ::1, UDP и TCP порт 53. Upstream работает только по TLS 1.2+ с проверкой сертификата и имени хоста; plaintext fallback отсутствует. DoT TCP-соединения ограниченно переиспользуются.
5. До изменения DNS служба сохраняет защищённый backup каждого активного сетевого адаптера. Затем SetInterfaceDnsSettings устанавливает локальный DNS отдельно для IPv4 и IPv6, включая DNS активного профиля.
6. Служба наблюдает за сетевыми интерфейсами. Новые активные адаптеры автоматически сохраняются и переводятся на локальный DNS; изменения DNS извне обнаруживаются и исправляются.
7. При выключении служба восстанавливает исходные статические DNS или автоматические DHCP/RA-настройки для каждого адаптера. Backup удаляется только после проверки восстановления. При ошибке backup остаётся.

## Управление в приложении

- **Включить системный DNS** — использует DoT hostname из главного экрана, запрашивает UAC и включает постоянный режим.
- **Выключить DNS** — восстанавливает исходные настройки.
- **Восстановить исходные настройки** — повторяет восстановление, если предыдущая операция была прервана.
- **Обновить состояние** — показывает состояние службы, количество адаптеров, IPv4/IPv6 локальные проверки и последнюю ошибку.

Временного таймера, NRPT-пробного режима или отдельного повторного ввода hostname в PowerShell нет.

## Важные технические границы

- Системный DNS Windows меняется на уровне активных сетевых интерфейсов. Это не VPN и не меняет публичный IP или маршрут обычного трафика.
- Приложения с собственным DoH/DoT или встроенным резолвером могут обходить системные настройки DNS.
- Специальные VPN/корпоративные NRPT-политики могут задавать отдельные DNS-маршруты. Их нужно проверять отдельно, особенно для split DNS.
- IP-адреса DoT upstream сохраняются для запуска службы после перезагрузки без DNS bootstrap loop. Если IP персонального DoT-сервера изменился, выключите и снова включите клиент, чтобы обновить закреплённые адреса.
- При недоступности DoT DNS-запросы завершаются ошибкой, а не отправляются незашифрованно на публичный DNS.
- Служба и GUI пока unsigned developer build. Реальная эксплуатация на Windows 10 22H2 пользователя и совместимость с его VPN ещё должны быть подтверждены сквозным тестом.

## Build и проверки

На Windows runner:

~~~powershell
cargo fmt --manifest-path apps/windows-dns/dns-core/Cargo.toml -- --check
cargo test --manifest-path apps/windows-dns/dns-core/Cargo.toml
cargo test --manifest-path apps/windows-dns/network/Cargo.toml
cargo test --manifest-path apps/windows-dns/journal/Cargo.toml
cargo test --manifest-path apps/windows-dns/ipc/Cargo.toml
cargo test --manifest-path apps/windows-dns/setup/Cargo.toml
cargo check --manifest-path apps/windows-dns/service/Cargo.toml
cargo check --manifest-path apps/windows-dns/src-tauri/Cargo.toml
~~~

Target: Windows 10 22H2 x64, MSVC, Windows SDK, WebView2. Package must contain GUI, setup helper and health/controller service in the same directory.

## Microsoft API references

- [SetInterfaceDnsSettings](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-setinterfacednssettings)
- [GetInterfaceDnsSettings](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getinterfacednssettings)
- [DNS_INTERFACE_SETTINGS](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/ns-netioapi-dns_interface_settings)
- [Windows DNS client netsh](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-dnsclient)

UX references:
- https://aiforui.dev/skills/gestures
- https://github.com/benjitaylor/skills
- https://github.com/GoogleChrome/modern-web-guidance
