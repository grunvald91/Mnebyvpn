# Этап 3 — Продамус и Telegram Stars

**Платёжные провайдеры утверждены владельцем: только Prodamus и Telegram Stars.** Решение о провайдерах не пересматривается разработчиком.

## Реализованный код

- packages/billing/src/channels.ts — две схемы цен и выбора платёжного канала, независимо настроенные суммы RUB и XTR; цены из плана, а не пересчёт валют.
- packages/billing/src/stars.ts — Telegram invoice XTR, привязка payload к UUID заказа через HMAC, проверки pre_checkout_query и successful_payment, идентификатор транзакции Telegram.
- packages/billing/src/prodamus.ts — сериализация и HMAC подпись параметров Payform по опубликованному алгоритму; подготовка подписанного do=link запроса; проверка Sign, оплаченного статуса, суммы, merchant order_num, transaction ID и домена входящего уведомления.
- tests/payment-channels.test.ts — тесты позитивных и негативных случаев.

Официальная техническая документация:
- https://core.telegram.org/bots/payments-stars
- https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov
- https://help.prodamus.ru/payform/uvedomleniya/kak-ustroena-otpravka-uvedomlenii-ob-oplate

## Ограничения готовности

1. Unit-тесты Prodamus и Stars выполнены в GitHub Actions и прошли; test-vectors от действующей формы и реальные Prodamus/Telegram уведомления **не проверялись**. Каноникализацию Prodamus необходимо сверить с тестовым webhook и SDK примерами до запуска.
2. Отсутствуют runtime HTTP/multipart webhook endpoints, authenticated Telegram Bot API update transport, секреты Payform, ссылки мерчанта и продакшен-учётная запись. Ничего не оплачено и доступ не выдавался.
3. Подписанные уведомления — только входные сигналы. Бизнес-БД должна проверять сумму/провайдера и идемпотентно вызывать транзакционный settle (миграция 0002); PostgreSQL integration ещё не проверен.
4. Для Telegram цифровых товаров официальный Bot API предусматривает Stars/XTR; конфигурация поверхностей оплаты отделена от коммерческого решения использовать оба провайдера.
5. Продление/автосписание по любому провайдеру не реализовано. Только разовая покупка пакета. При refunds необходимы отдельные подтверждённые события.
6. Подписки VPN/DNS и квоты не выдаются боевым data plane. Платный SNI остаётся blocked по architecture gates.

## Следующие задачи без серверов

- Прогнать тесты и TypeScript typecheck, проверить Prodamus HMAC на эталонном тестовом webhook.
- Реализовать handler update Telegram Stars, webhook Prodamus и базы заказов с подготовленными transactional SQL функциями.
- Написать тесты concurrent capture/refund/expiry на disposable PostgreSQL.

## Исправление P1 по повторам Продамус

Уведомления повторно доставляются с изменённым `attempt`. Идентичность оплаты: `(provider, transaction_id, merchant_order_id, trusted amount, currency)`. `payload_sha256` — хеш **конкретной доставки** и может различаться; он хранится в `payment_delivery_receipts`, не определяет дубликат. После успешного `PAID` валидатор принимает повторный **подписанный** webhook, а SQL отвечает `DUPLICATE_EVENT` или `DUPLICATE_CAPTURE` без добавления новой подписки. После `REFUNDED` задержанная доставка подтверждённой исходной оплаты также не восстанавливает доступ. Тесты написаны, но PostgreSQL/merchant end-to-end пока не запускались.


**CI-проверка (05.11.2026):** [GitHub Actions run 42109968701](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701) — `success`: TypeScript typecheck, **25/25 unit-тестов**, миграции PostgreSQL 0001–0003 и SQL contract tests на disposable PostgreSQL 17.6. Это не тесты конкурентных клиентов, реального Prodamus/Telegram API, CoreDNS/SNI ingress или действующих VPS; эти gates **UNVERIFIED**.
