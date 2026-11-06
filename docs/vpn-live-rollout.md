# Реальный VPN provisioning: запуск и автоматический релиз

Дата: 2026-11-06. **Код подключения написан, настоящий Node и production не проверены.** Истина о готовности: [release-gates](release-gates.md).

## Цепочка выдачи

1. Telegram /trial создаёт trial_grants, entitlement и outbox, но не запускает отсчёт.
2. Фоновый worker каждые 5 секунд обрабатывает **только VPN**. Создаёт профиль Remnawave с предварительным 5-минутным сроком и текущей revision. Панель отвечает статусом, ревизией и временем.
3. После отдельной проверки на настоящем Node и разрешения оператора PostgreSQL записывает время активации, ровно +24 часа и новую revision. Worker обновляет deadline на панели.
4. /connect отдаёт подписочную ссылку только владельцу подтверждённого неистёкшего доступа при совпадении rev и срока.
5. На expiry/refund новая revision в очереди вызывает выключение пользователя в панели. Перепроверка состояний раз в 5 минут. Это **не доказывает** закрытие уже работающих TCP/UDP сессий или автономное истечение при потере связи между панелью и Node.

Интеграционные тесты используют disposable PostgreSQL и синтетическую HTTPS-панель, **не реальный Xray**. Отпечаток частного отчёта и версии — необходимое решение оператора, а не автоматически полученное доказательство.

## Подготовка выделенного VPS-окружения

- Приватно проверить реальные CPU/RAM/диск, firewall и слушателей, восстановление из резервной копии; не ломать действующие nginx/Xray/прокси.
- Установить пинованные версии Remnawave Panel/Node/Xray на согласованных отдельных ресурсах. Проверить internal squad, ключи API с минимальными правами и переносную публичную HTTPS-ссылку подписки.
- Проверить пилотного клиента: подключение, DNS, новые и действующие TCP/UDP соединения, expiry после короткого срока, refund/revoke, разрыв Panel ↔ Node, reboot, clock skew. Без фактических результатов не включать коммерческий режим и не выдумывать report SHA256.
- Подготовить непривилегированного Unix-пользователя c Node.js >=22.16, работающим systemctl --user, каталогом ~/mnebyvpn/releases и двумя приватными файлами окружения (права 0600).

### Приватное окружение (никогда не в git)

Файл ~/mnebyvpn/runtime-bot.env: MNEBYVPN_ENV=production, BOT_PUBLIC_INFO_ONLY=no, BOT_PORT, DATABASE_URL, TELEGRAM_WEBHOOK_SECRET_SHA256, REMNAWAVE_API_URL, REMNAWAVE_READ_API_TOKEN, VPN_SUBSCRIPTION_ORIGIN, REMNAWAVE_SQUAD_UUIDS. Боту нужен только read-only API-токен.

Файл ~/mnebyvpn/runtime-vpn.env: MNEBYVPN_ENV=production, MNEBYVPN_PROVISIONING_WORKER=enabled, DATABASE_URL, REMNAWAVE_API_URL, REMNAWAVE_API_TOKEN (только права управления пользователями), REMNAWAVE_SQUAD_UUIDS, VPN_SUBSCRIPTION_ORIGIN, VPN_NODE_EXPIRY_REPORT_SHA256, VPN_VERIFIED_PANEL_VERSION, VPN_VERIFIED_NODE_VERSION, VPN_VERIFIED_XRAY_VERSION.

Отдельные unit-шаблоны: ops/systemd/mnebyvpn-telegram.service и ops/systemd/mnebyvpn-vpn-worker.service. Установить их под выделенным пользователем в ~/.config/systemd/user/ и перезагрузить менеджер systemctl --user daemon-reload. Не перенаправлять webhook/relay без отдельной проверки. VPN trial_offers.enabled в БД остаётся false до пилотного E2E.

## Автоматический деплой после зелёного main

Workflow: .github/workflows/deploy-production.yml.

Условия: успешный push-CI ветки main, соответствие проверенному SHA текущей вершине main и переменная GitHub Actions MNEBYVPN_DEPLOY_ENABLED=true. До этого автоматическое развёртывание отключено.

Необходимые GitHub Actions secrets:
- MNEBYVPN_DEPLOY_HOST
- MNEBYVPN_DEPLOY_USER
- MNEBYVPN_DEPLOY_SSH_KEY
- MNEBYVPN_DEPLOY_KNOWN_HOSTS — заранее независимо проверенный SSH host key, не результат первого подключения.

Необязательные GitHub Actions variables: MNEBYVPN_DEPLOY_SSH_PORT (22), MNEBYVPN_BOT_PORT (8793).

Workflow создаёт отдельный релиз в ~/mnebyvpn/releases/SHA, обновляет симлинк current и перезапускает только собственные systemd user units. Проверяет local /readyz и два сервиса; при неготовности откатывает current и перезапускает предыдущую версию. Не выполняет SQL-миграции, не устанавливает Remnawave, не меняет Nginx, DNS, сертификаты, firewall или чужие процессы.

Зелёный CI — только CODED/TESTED_OFFLINE. Настоящие P0-DATAPLANE, P0-OFFLINE, P0-ORDER будут закрыты лишь результатами физических испытаний.

Источники: https://docs.rw/api/ ; https://docs.rw/learn-en/users/ ; https://docs.rw/learn-en/nodes/ .
