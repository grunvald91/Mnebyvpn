# MNEBYVPN — этап 5 без серверов

## Реализовано
- `packages/billing/src/store.ts`: `applyVerifiedRefund` по provider+capture+order+сумма+валюта, только для провайдером **уже подтверждённого** полного возврата. Отключает ровно entitlement возвращённой покупки; более старые и иные пакеты не затрагивает.
- `packages/billing/src/handlers.ts`: сервисное событие Telegram `refunded_payment`. Проверяются настоящий authenticated Bot API transport (на уровне HTTP), HMAC order payload, Telegram sender, exact XTR amount и original charge ID из БД. Дубликат не создаёт повторного отзыва.
- `db/migrations/0005_outbox_retries.sql`: due_at/last_error_code для восстановления после worker restart.
- `packages/provisioning/src/pg-worker.ts`: сериализация через PostgreSQL session advisory lock + fencing, idempotent desired-state reconcile, SKIP LOCKED при выборе сигнала, backoff и periodic drift scan. Только явное подключение адаптера позволяет подтвердить upstream observed state. Без адаптера сигнал остаётся в очереди, а доступ в бизнес-БД не становится ACTIVE.
- `packages/telegram-ui/src/html-bubbles.ts`: самостоятельный безсетевой интерактивный HTML/CSS/JS-шаблон карточек MNEBYVPN (VPN и MNEBYDNS), состояние, остаток ГБ, сроки и вкладки. Никаких секретов, bearer IPv6, URL конфигурации или привилегированных JS API.
- `/my`, `/status` в Telegram — подтверждённый fallback через Rich Messages по актуальным данным PostgreSQL.
- `tests/html-bubbles.test.ts` и `tests/integration/phase5.test.ts`: unit HTML/sanitization, mock provisioner, refund/disable и изоляция нескольких покупок на временной PostgreSQL.

## Telegram: что проверено
- https://kod.ru/telegram-zapustil-html-bubbles — публикация от 06.11.2026, подтверждающая HTMLBubbles в стабильном Telegram 13.2.
- https://core.telegram.org/bots/api-changelog — при прямой проверке 06.11.2026 последняя доступная запись Bot API 10.3 (24.08.2026).
- https://core.telegram.org/bots/api#refundedpayment — документы сервиса Telegram по RefundedPayment, invoice_payload и original telegram_payment_charge_id.

**Нельзя отождествлять поддержку исполнения HTMLBubbles клиентом и опубликованный интерфейс отправки их произвольным ботом.** В настоящее время подготовлены разметка и безопасный рендерер; выдуманного `sendHtmlBubble` в исходниках нет. Когда будет получен официальный контракт 10.4 — подключить эту транспортную часть. 

## Обязательные блокеры запуска
- Невыполненные live test-vectors Telegram Stars и Prodаmus, не подключён provider-side refund для Prodаmus.
- Разработанный backend-worker не запускался в постоянном процессе; без настоящих data-plane adapters лишь unit/integration mocks. Не гарантирует on-wire deny/expiry.
- Полный revoke старого VPN профиля и hard traffic limit MNEBYDNS НЕ ПРОВЕРЕН; серверы не изменялись.
- Администраторские операции refund требуют аудита, одобрения и проверки фактического provider result перед вызовом store, при недетерминированном результате запрет слепого повтора.

## Результат независимой CI-проверки

[GitHub Actions run 42118297218](https://github.com/grunvald91/Mnebyvpn/actions/runs/42118297218) — **SUCCESS**, 32 из 32 unit-тестов, 5 из 5 интеграционных тестов на временном PostgreSQL 17.6, TypeScript typecheck, миграции 0001–0005 и SQL contract tests. Подтверждены отказ при отсутствии сетевого адаптера, mock grant → verified full refund → mock disable, повторный Telegram refunded_payment и независимость других покупок. Это **не** испытание настоящих Remnawave/CoreDNS и не реальная оплата/возврат.
