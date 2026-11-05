# Entitlements, платежи, выдача и отзыв доступа

**План, не реализованный код.**

## Понятия

- `account`: единая идентичность пользователя (например Telegram ID, не телефон как секрет).
- `order`: idempotency key, выбранный product (`vpn`, `smart_dns`, `bundle`), amount/currency, intent/provider.
- `payment_event`: уникальный `provider_event_id`, provider_verified_at, signed payload hash, никакие полные чувствительные payload в log.
- `entitlement`: account_id, product, starts_at, expires_at, state, revision, quota, source_order.
- `provisioning`: adapter (`remnawave` / `mnebydns`), external_ref, desired_revision, applied_revision, error state, retries.
- `outbox`: атомарно записанная команда исполнителю, idempotency, attempts, locks/lease, deadline.

## Состояния права

`PENDING_PAYMENT` → `PAID_PENDING_PROVISIONING` → `ACTIVE` → `EXPIRED`; отдельные `PROVISIONING_FAILED` (ретраится), `SUSPENDED`, `REFUNDED`, `CANCELLED`.

- **PAID** только после проверки webhook **и** статуса у платёжного провайдера.
- Одно подтверждённое списание = одно изменение entitlement, защищённое unique order/transaction IDs, транзакционной блокировкой.
- Продление: `max(now, old_expires_at) + purchased_duration` как кандидат бизнес-правила; формально проверить возвраты/смену плана и календарные тарифы.
- Ошибка Remnawave/DNS не теряет оплату: entitlement остаётся в БД, pending outbox, безопасный retry; при долгой ошибке — уведомление и support/refund policy.
- Refund/chargeback: отдельный идемпотентный переход с заявленной политикой; revoke соответствующего VPN/DNS доступа.
- Reconciliation job сравнивает `desired entitlement` с реальными `VPN enabled/expiry` и `DNS token enabled/expiry`; исправляет расхождения.
- Срок истёк → запрет сетевой аутентификации **уже импортированного профиля**, не только скрытие подписки/DoH URL.
- Если провайдер позволяет подписки/автоплатежи — отдельное согласие и проверка юридических условий; не включать автоматически.

## Минимальные contract tests

1. Повтор одного webhook не добавляет дни.
2. Два заказа одновременно не теряют оплату и не дают двойные дни.
3. Успешный платёж + ошибка VPN adapter → задача повторяется до успешной выдачи.
4. Успешный платёж + ошибка DNS adapter → VPN может работать, DNS выдаётся после retry.
5. Expired VPN: уже существующий клиентский конфиг отключён на сервере.
6. Expired DNS: per-user DoH доступ отозван, resolver не принимает персональную политику; TTL/cache проверен.
7. Refund/chargeback и восстановление после ошибочного revoke корректны.
8. Outbox restart повторяет safe idempotent действия, уникальный order не дублируется.

Нет выбранного СБП-провайдера: тарифы, API и статус самозанятого должны быть проверены перед реализацией оплаты.

## Конкурентное применение прав — обязательная спецификация

Повторы и идемпотентность **не обеспечивают** порядка между ENABLE старой ревизии и DISABLE новой. Outbox должен быть только сигналом пересчитать текущее желаемое состояние; каждую пару `(account_id, service_type)` обрабатывать с монотонной `revision`, fencing token, сериализацией, проверкой state до/после provider API и reconcile. При неизвестном результате не повторять старую выдачу без сверки. См. [provisioning-ordering](provisioning-ordering.md).

VPN offline-expiry не доказан для текущих версий панели/узла: **платная модель требует теста** отключения при потере Panel и максимального stale entitlement window. См. [offline-expiry](offline-expiry.md). DNS token revoke не эквивалентен прямому SNI ingress deny; см. [smart-dns-access-gate](smart-dns-access-gate.md).

## Продукт MNEBYDNS: пакет трафика без лицензирования устройств

Единый `subscription_id` имеет `quota_limit_bytes`, `quota_used_bytes`, `quota_state`, `expires_at`, `revision`. **Любое количество устройств** разделяет один пакет и срок. Когда `quota_used_bytes >= quota_limit_bytes`, ingress обязан запрещать новые прокси-подключения и в рамках согласованного hard-cap завершать/лимитировать действующие. Отзыв DoH токена сам по себе не останавливает прокси. Учёт нескольких ingress требует согласованной квоты и concurrency control. См. [ADR-0005](decisions/0005-shared-dns-quota.md).
