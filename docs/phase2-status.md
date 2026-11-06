# Этап 2: billing и reconciliation без серверов

**Реализовано в feature branch. Не означает готовность к продаже или запуску.**
Действующие VPS 89/188, nginx, DNS, firewall, Xray и Telegram-прокси не изменялись.

## Добавлено
- db/migrations/0002_billing_and_reconcile.sql: транзакционная обработка **уже проверенных** платежных событий PAID/REFUND; уникальный идентификатор capture; выдача VPN/DNS или bundle-entitlement с единым outbox; expiry sweep, fencing и CAS acknowledgement. EXECUTE для PUBLIC отозван — в будущем нужны отдельные ограниченные роли БД.
- db/tests/0002_billing_contract.sql: SQL-тесты для одноразового платежа, дубликата, bundle, refund, monotonic fencing, защиты от старого ack.
- packages/provisioning/src/reconciler.ts: детерминированный алгоритм сверки desired/observed через интерфейсы ReconcileStore и ProvisioningAdapter. При timeout неизвестный результат запрещает слепое повторение ENABLE. После применения перечитывается право и, если оно отозвано, отправляется компенсирующий DISABLE в рамках той же попытки.
- tests/reconciler.test.ts: 8 тестов с fake store и fake adapter.

## Проверено в локальной среде
- Node 22.16.0: 8/8 unit-тестов пройдены.
- TypeScript 5.8.3: компиляционная проверка нового модуля и тестов успешна.
- PostgreSQL **не установлен на VPS**, но миграции 0001–0003 и SQL contract tests выполнены на временном PostgreSQL 17.6 в GitHub Actions (PASS). Тесты конкурентных сессий/отказов сети ещё не проведены.

## Границы готовности
1. SQL-функции не подтверждают платежи самостоятельно. Подпись webhook, независимая сверка в платёжном API, доверенные тарифы и роль доступа к функциям ещё не реализованы.
2. ReconcileStore.withLock — абстрактный контракт, не работающая межпроцессная блокировка. PostgreSQL runtime adapter, worker, Remnawave/DNS сетевые адаптеры ещё не созданы.
3. Блокировка в БД и fencing защищают признание результатов, но не отменяют запрос, ранее направленный третьей системе. Доказательство отказа после refund/expiry на data plane требует E2E.
4. DNS token / quota ledger не аутентифицируют прозрачный TLS ingress и не останавливают TCP-соединения. **Платный SNI остаётся BLOCKED**.
5. Продление, пополнение исчерпанной квоты, частичные возвраты и смена тарифа пока не определены; реализован начальный платёж и полный возврат в SQL.

## Следующие шаги без VPS
- Запустить disposable PostgreSQL в тестовой среде и проверить миграции с конкурентными транзакциями.
- Реализовать PostgreSQL-backed worker и межпроцессный lock/fencing с отказоустойчивым reconcile.
- Подключить provider-neutral billing interface с реальной независимой verification после выбора платёжного провайдера.
- Подготовить Telegram UX и локальные mock adapters. Действующие серверы не трогать.


**CI-проверка (05.11.2026):** [GitHub Actions run 42109968701](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701) — `success`: TypeScript typecheck, **25/25 unit-тестов**, миграции PostgreSQL 0001–0003 и SQL contract tests на disposable PostgreSQL 17.6. Это не тесты конкурентных клиентов, реального Prodamus/Telegram API, CoreDNS/SNI ingress или действующих VPS; эти gates **UNVERIFIED**.
