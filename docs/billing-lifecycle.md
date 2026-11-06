# Entitlements, платежи, выдача и отзыв доступа

**План, не реализованный код.**

## Понятия

- `account`: единая идентичность пользователя (например Telegram ID, не телефон как секрет).
- `order`: idempotency key, выбранный product (`vpn`, `smart_dns`, `bundle`), amount/currency, intent/provider.
- `payment_event`: уникальный `provider_event_id`, provider_verified_at, signed payload hash, никакие полные чувствительные payload в log.
- `entitlement`: отдельное право для **конкретной покупки** (`source_order_id + product`), `subscription_id`, собственная квота и своя конфигурация; несколько покупок одного продукта у аккаунта создают разные entitlements.
- `provisioning`: adapter (`remnawave` / `mnebydns`), external_ref, desired_revision, applied_revision, error state, retries.
- `outbox`: атомарно записанная команда исполнителю, idempotency, attempts, locks/lease, deadline.

## Состояния права

`PENDING_PAYMENT` → `PAID_PENDING_PROVISIONING` → `ACTIVE` → `EXPIRED`; отдельные `PROVISIONING_FAILED` (ретраится), `SUSPENDED`, `REFUNDED`, `CANCELLED`.

- **PAID** только после проверки webhook **и** статуса у платёжного провайдера.
- Одно подтверждённое списание = одно изменение entitlement, защищённое unique order/transaction IDs, транзакционной блокировкой.
- **На текущем этапе только независимые разовые пакеты:** повторная покупка создаёт новое право и новую сетевую конфигурацию, а не продлевает старую. Для продления существующего пакета без смены адреса потребуется отдельная транзакционная политика и учёт refund.
- Ошибка Remnawave/DNS не теряет оплату: entitlement остаётся в БД, pending outbox, безопасный retry; при долгой ошибке — уведомление и support/refund policy.
- Refund/chargeback: отдельный идемпотентный переход и отзыв только entitlements, созданных **возвращённым заказом**; другие оплаченные пакеты того же аккаунта не менять.
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

Владелец выбрал **Продамус и Telegram Stars**. Эталонные подписи, реальный webhook/invoice transport и интеграция PostgreSQL ещё не прошли тесты.

## Конкурентное применение прав — обязательная спецификация

Повторы и идемпотентность **не обеспечивают** порядка между ENABLE старой ревизии и DISABLE новой. Outbox должен быть только сигналом пересчитать текущее желаемое состояние; каждый отдельный `entitlement_id` обрабатывать с монотонной `revision`, fencing token, сериализацией, проверкой state до/после provider API и reconcile. При неизвестном результате не повторять старую выдачу без сверки. См. [provisioning-ordering](provisioning-ordering.md).

VPN offline-expiry не доказан для текущих версий панели/узла: **платная модель требует теста** отключения при потере Panel и максимального stale entitlement window. См. [offline-expiry](offline-expiry.md). DNS token revoke не эквивалентен прямому SNI ingress deny; см. [smart-dns-access-gate](smart-dns-access-gate.md).

## Продукт MNEBYDNS: пакет трафика без лицензирования устройств

Единый `subscription_id` имеет `quota_limit_bytes`, `quota_used_bytes`, `quota_state`, `expires_at`, `revision`. **Любое количество устройств** разделяет один пакет и срок. Когда `quota_used_bytes >= quota_limit_bytes`, ingress обязан запрещать новые прокси-подключения и в рамках согласованного hard-cap завершать/лимитировать действующие. Отзыв DoH токена сам по себе не останавливает прокси. Учёт нескольких ingress требует согласованной квоты и concurrency control. См. [ADR-0005](decisions/0005-shared-dns-quota.md).

## Коммерческий реестр и policy, ещё не реализованные в production

Единственный источник статусов: [release-gates](release-gates.md); целевой объём первой продажи — [mvp-scope](mvp-scope.md). Существующая схема платежей и offline-тесты **не доказывают** фактический provider refund, чек или сетевой revoke. До утвердённых тарифов и legal-review checkout не публиковать.

- `refund_requested`: аутентифицированный клиент/оператор, ссылка на capture и причину; отдельный уникальный ключ операции; не меняет `refund_confirmed` по одной заявке.
- `provider_refund_pending`: возврат отправлен через **проверенный API** выбранного провайдера; таймаут помечается UNKNOWN, не ретраится слепо.
- `provider_refund_confirmed`: подтверждён транзакцией провайдера, записан идемпотентный статус, atomic entitlement revision + outbox для сетевого revoke; проверка применения прав после восстановления Panel. Никаких гарантий мгновенного revoke во время partition.
- `failed/requires_review`: доступно оператору; обработка потребительского требования и чека по применимым правилам, уведомление клиента.

VPN sharing (количество устройств, одновременно подключённых сессий и общий traffic cap) **TBD**. Для будущего MNEBYDNS намерение использовать единый пакет для любого числа устройств **не доказывает** авторизацию per-SNI flow. Не публиковать unlimited до согласования и тестирования. Экономика/возвраты/РФ: [commercial-readiness](commercial-readiness.md).
