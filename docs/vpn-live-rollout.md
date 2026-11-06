# Реальный VPN provisioning: запуск и автоматический релиз

Дата: 2026-11-06. **Код подключения написан, настоящий Node и production не проверены.** Истина о готовности: [release-gates](release-gates.md).

## Цепочка выдачи

1. Telegram /trial создаёт trial_grants, entitlement и outbox, но не запускает отсчёт.
2. VPN-worker каждые 5 секунд выбирает только VPN-заявки. **Текущий Remnawave Panel adapter не подтверждает узловый hard expiry** и поэтому блокирует выдачу новых VPN-подписок: пробные сутки не начинают отсчитываться.
3. После отдельной реализации и проверки независимого node-side expiry enforcement adapter станет возможна двухфазная выдача: краткий предварительный срок → фиксация активации → ровно 24 часа. На сегодня это **не включено в живом worker**; тесты отрабатывают сценарий на синтетическом node verifier.
4. /connect отдаёт подписочную ссылку только владельцу ранее подтверждённого неистёкшего доступа при совпадении revision и срока.
5. Для expiry/refund worker отправляет Remnawave Panel команду отключения существующего профиля; при подтверждённом отсутствии удалённого профиля запись может быть закрыта без бесконечных retry. **Отключение уже работающих TCP/UDP сессий и автономный expiry при потере связи не доказаны.**

Интеграционные тесты используют disposable PostgreSQL и синтетическую HTTPS-панель, **не реальный Xray**. Отпечаток частного отчёта и версии — необходимое решение оператора, а не автоматически полученное доказательство.

## Подготовка выделенного VPS-окружения

- Приватно проверить реальные CPU/RAM/диск, firewall и слушателей, восстановление из резервной копии; не ломать действующие nginx/Xray/прокси.
- Установить пинованные версии Remnawave Panel/Node/Xray на согласованных отдельных ресурсах. Проверить internal squad, ключи API с минимальными правами и переносную публичную HTTPS-ссылку подписки.
- Проверить пилотного клиента: подключение, DNS, новые и действующие TCP/UDP соединения, expiry после короткого срока, refund/revoke, разрыв Panel ↔ Node, reboot, clock skew. Без фактических результатов не включать коммерческий режим и не выдумывать report SHA256.
- Подготовить непривилегированного Unix-пользователя c Node.js >=22.16, работающим systemctl --user, каталогом ~/mnebyvpn/releases и двумя приватными файлами окружения (права 0600).

### Приватное окружение (никогда не в git)

Файл ~/mnebyvpn/runtime-bot.env: MNEBYVPN_ENV=production, BOT_PUBLIC_INFO_ONLY=no, BOT_PORT, DATABASE_URL, TELEGRAM_WEBHOOK_SECRET_SHA256, REMNAWAVE_API_URL, REMNAWAVE_READ_API_TOKEN, VPN_SUBSCRIPTION_ORIGIN, REMNAWAVE_SQUAD_UUIDS. Боту нужен только read-only API-токен.

Файл ~/mnebyvpn/runtime-vpn.env: MNEBYVPN_ENV=production, MNEBYVPN_PROVISIONING_WORKER=enabled, DATABASE_URL, REMNAWAVE_API_URL, REMNAWAVE_API_TOKEN (только права управления пользователями), REMNAWAVE_SQUAD_UUIDS, VPN_SUBSCRIPTION_ORIGIN, VPN_WORKER_HEALTH_PORT (по умолчанию 8794). Произвольные SHA256 отчёта и строки версии **не разблокируют** создание VPN-пользователей без узлового доказательства.

Отдельные unit-шаблоны: ops/systemd/mnebyvpn-telegram.service и ops/systemd/mnebyvpn-vpn-worker.service. Установить их под выделенным пользователем в ~/.config/systemd/user/ и перезагрузить менеджер systemctl --user daemon-reload. Не перенаправлять webhook/relay без отдельной проверки. VPN trial_offers.enabled в БД остаётся false до пилотного E2E.

## Автоматический деплой после зелёного main

Workflow: .github/workflows/deploy-production.yml.

Условия: успешный push-CI ветки main, соответствие проверенному SHA текущей вершине main и переменная GitHub Actions MNEBYVPN_DEPLOY_ENABLED=true. До этого автоматическое развёртывание отключено.

Необходимые GitHub Actions secrets:
- MNEBYVPN_DEPLOY_HOST
- MNEBYVPN_DEPLOY_USER
- MNEBYVPN_DEPLOY_SSH_KEY
- MNEBYVPN_DEPLOY_KNOWN_HOSTS — заранее независимо проверенный SSH host key, не результат первого подключения.

Необязательные GitHub Actions variables: MNEBYVPN_DEPLOY_SSH_PORT (22), MNEBYVPN_BOT_PORT (8793), MNEBYVPN_WORKER_HEALTH_PORT (8794). Указанный порт worker должен соответствовать VPN_WORKER_HEALTH_PORT на VPS.

CI упаковывает **точный набор Node.js runtime-зависимостей после успешных тестов** в артефакт с SHA256 и commit SHA. Workflow_run скачивает артефакт исключительно из того же зелёного запуска main, сверяет SHA и копирует его на VPS — повторного npm install на сервере нет. Релиз создаётся в ~/mnebyvpn/releases/SHA, current заменяется атомарно, перезапускаются только собственные systemd user units. Публикация считается успешной при локальной HTTP-готовности **и бота, и VPN-worker** (worker дополнительно проверяет недавний цикл и БД). При отказе происходит rollback. SQL-миграции, Remnawave Node, Nginx, DNS, TLS, firewall и чужие приложения не изменяются.

Зелёный CI — только CODED/TESTED_OFFLINE. **Прежняя ошибка P0:** `enforcesHardExpiry=true` в panel-only adapter могла запустить таймер пробных суток после чтения одной панели; теперь это запрещено. Реальная выдача будет разблокирована только после node-side проверки новых и существующих сессий, offline partition, reboot, refund и отдельного надёжного адаптера. P0-DATAPLANE, P0-OFFLINE, P0-ORDER остаются BLOCKED.

Источники: https://docs.rw/api/ ; https://docs.rw/learn-en/users/ ; https://docs.rw/learn-en/nodes/ .
