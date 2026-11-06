# P1 — порядок применения revocation / provisioning (desired state + generations)

Дата: 2026-11-05. **СТАТУС: CONTRACT DEFINED, IMPLEMENTATION UNTESTED.** Идемпотентность команды сама по себе НЕ гарантирует порядок между разными командами.

## Инварианты

- Для каждого купленного `entitlement_id` есть **единственный актуальный desired state** в бизнес-БД: `revision` (монотонно растущий), `enabled`, `expires_at`, `plan`, `credential_generation`.
- Оплата, истечение, refund, ручная блокировка атомарно увеличивают `revision` в транзакции. `outbox` хранит **сигнал к сверке**, а не безусловную команду «включить на основании старого снимка».
- Только один действующий исполняющий процесс для `(entitlement_id, adapter)`: транзакционная сериализация/lock или fencing lease. Lease имеет монотонный `fencing_token` и CAS по `revision`; duplicate worker не может объявить старый результат новым состоянием.
- Исполнитель **перед каждым обращением к provider** перечитывает желаемое состояние и сверяет `revision`; после вызова перечитывает повторно и записывает `applied_revision` только если CAS/current revision совпадают.
- Если старая сетевая операция завершилась поздно, она НЕ должна получить статус успеха для новой ревизии: создать high-priority reconcile для уже актуального состояния; при отзыве — исправить обратно в disabled.
- Нет требования верить доставке outbox как источнику права. Полный periodic reconcile (desired vs actual) является обязательным.

## Последовательность исполнения

1. `BEGIN`: update entitlement + `revision += 1` + outbox notification; COMMIT.
2. Worker получает per-key lock/lease; сверяет `desired_revision`, `applied_revision`, текущее состояние upstream; записывает operation attempt со стабильным `operation_id`.
3. Если очередь несёт старую revision: **не применять payload**; перейти на последнее желаемое состояние.
4. Сетевой API вызов с таймаутом и, где возможно, provider idempotency key; unknown result = reconcile, а не безусловный retry enable.
5. По завершении — atomic CAS с `revision` + `fencing_token`; при mismatch в очередь отправляется reconcile, особенно когда актуальное desired = disabled.
6. Периодические sweep/reconcile и alarm при длительном расхождении и возрасте доступа вне entitlement.

**Важное ограничение:** если сторонний Remnawave/DNS API не предоставляет условные мутации или строгую сериализацию, нельзя обещать мгновенную линейризуемость между двумя независимыми API вызовами. Необходимы сериализация на стороне исполнителя, fencing, post-call verify и измерение потенциального окна некорректной авторизации. Если максимум окна неприемлем, нужен другой механизм исполнения/дополнительный control gate.

## Acceptance tests

- ENABLE r1 завис, REFUND→DISABLE r2 выполнен, затем r1 завершился: итог отключён; недопустимое окно измерено.
- Lease истёк у worker A, B взял более новый fencing token: A не может признать успех и перезаписать `applied_revision`.
- Повторный webhook/outbox, конкурентные оплаты, повторный refund, процесс crashed после upstream call → desired state после reconciliation сохранён.
- Сбой провайдера при `unknown outcome`: не удваивать доступ/ресурс, запросить актуальный статус.
- Тест два адаптера (VPN и DNS) с независимыми `applied_revision` при одном коммерческом bundle; refund должен отозвать все соответствующие права.

Смежные документы: [billing-lifecycle](billing-lifecycle.md), [offline-expiry](offline-expiry.md).

**Модель пакета (review 2026-11-05):** два заказа одной услуги означают два отдельных `entitlement_id`, с **разными** credential refs/профилями. Нельзя объединять их под одним Remnawave user или Smart DNS IP с независимыми ревизиями: при этом старая отмена может снести активный другой пакет. Возврат отзываeт только пакет соответствующего заказа. Клиенту показывать независимые пакеты; «пополнить имеющийся» пока не реализовано.
