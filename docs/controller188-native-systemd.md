# Центральный контроллер RU188: собственный Node.js + systemd

Состояние: код установки и безопасного запуска для **уже работающего** контроллера `188.120.254.223`. Никакого нового VPS и Docker-контейнера для контроллера.

## Почему отдельная среда

На хосте 188 Node.js отсутствует; Docker-контейнеры MNEBYVPN имеют Node 22.16.0, но являются процессами сайта/бота и не должны получать root-only ключи. Поэтому новая среда будет размещена отдельно в `/opt/mnebyvpn-controller`, без добавления бинарных файлов в `/usr/bin` и без изменения образов сайта/бота. <https://github.com/grunvald91/telegram-proxy-infra/actions/runs/44300711843>

Берём **Node.js v22.23.5 LTS** (релиз безопасности от 11.11.2026), только Linux x64, проверяем точный SHA256 tar.xz по официальному сайту: `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`. Источник: <https://nodejs.org/en/blog/release/v22.23.5/>.

## Каталоги и службы

- `/opt/mnebyvpn-controller/releases/<commit>/`: неизменяемый, root-only (0700) набор Node.js, `pg`, кода регистратора и AWG-worker; `current` — ссылка на проверенный выпуск.
- `/root/mnebyvpn-controller/`: **существующие** отдельно сгенерированные приватные ключи. Установщик не читает, не копирует и не ротирует их.
- `mnebyvpn-controller-runtime-check.service`: однократная проверка импорта TS-модулей, библиотеки PostgreSQL и OpenSSH с `PrivateNetwork=yes`, без запросов в БД и без чтения ключей.
- `mnebyvpn-fi-enrollment.service`: одноразовая регистрация FI с отдельными, пока отсутствующими `fi-enrollment.env` и `approvals/fi-enrollment.enable`.
- `mnebyvpn-awg-delivery.service`: отдельный процесс доставки подписанных AWG-grants с отдельными, пока отсутствующими `awg-delivery.env` и `approvals/awg-delivery.enable`.

Обе управляющие службы устанавливаются **неактивными, без `[Install]` и без автозапуска**. Их условия запуска запрещают исполнение до отдельного подтверждения доверенного SSH-хоста FI, его ключа, регистрации в БД и контролируемой выдачи прав. В конфигурации unit используются ограничения `ProtectSystem=strict`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, `PrivateTmp=yes`, ограничение памяти/процессов и сетевые разрешения только для loopback PostgreSQL и FI `217.11.167.91`.

## Этап установки

Сначала GitHub Actions формирует архив из проверенного коммита MNEBYVPN, установленной без скриптов библиотеки `pg` и официального бинарного Node.js с проверкой SHA256. Затем по существующему SSH с закреплённым ключом сервера архив передаётся **только на 188**.

Установщик `ops/controller188-systemd/install-runtime.py` подтверждает локальный IPv4 188, root и наличие существующего MNEBYVPN на `/opt/mnebyvpn`; проверяет digest архива, распаковывает только разрешённые файлы (без symlinks, hardlinks, traversal), не перезаписывает чужие systemd units и запускает **только безопасный runtime smoke**. Действующие website/Telegram/VPN/DNS/Telemt-процессы не перезапускаются.

## Следующий этап после smoke

Независимо подтвердить SHA контроллера `e4c862bd0171e5be4ae64770a555029e090d3a8fcfa5ef2a82ffb0b798552844`, host key и Ed25519 SPKI FI, установить принудительный SSH command на FI и одобрить строку `fi-test-01` через существующую PostgreSQL. Затем отдельным проверенным изменением включить однократный registrar, проверить nonce и DB `enrolled` и позже — AWG grant/expiry/revoke E2E. Telegram-прокси — **Telemt/MTProto на 89**, не DNS SNI: его выдачу надо подключать отдельно.

**Не запускать `mnebyvpn-fi-enrollment.service` и `mnebyvpn-awg-delivery.service` только потому, что проверка runtime завершилась успешно.**
