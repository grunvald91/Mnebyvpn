# MNEBYVPN — этап 4: офлайн-обработчики платежей

## Реализовано в коде
- `db/migrations/0004_catalog_and_orders.sql`: каталог тарифов с независимыми ценами RUB / Stars (XTR), снимки условий заказа, идемпотентные checkout keys.
- `packages/billing/src/store.ts`: PostgreSQL transactions создания заказов для доверенного Telegram user ID или отдельно аутентифицированной сессии внешнего сайта; атомарная запись платежа в имеющуюся функцию `settle_verified_payment`, entitlement и outbox; повторный запрос не удваивает выдачу.
- `packages/billing/src/handlers.ts`: Telegram `pre_checkout_query` (без выдачи), `successful_payment` (с платёжным charge ID), Prodamus проверка подписанного уведомления и обработка повтора `attempt`.
- `packages/billing/src/multipart.ts`: строго ограниченный парсинг POST multipart/form-data с вложенными полями.
- `apps/service/src/payments-server.ts`: по умолчанию **не запускается**, для offline-test режим + loopback `127.0.0.1`; проверка секретного заголовка Telegram и `Sign` Продамуса. Не является готовым к публикации HTTP-приложением.
- Telegram бот: тарифы через документированный `sendRichMessage` и встроенные `tg-button`/ `tg-button-row`; счёт Stars и проверка результата. Продамус — отдельно согласованный внешнесайтовый канал заказа.

## Документация Telegram (проверено 2026-11-06)
- [Официальный Bot API changelog](https://core.telegram.org/bots/api-changelog) сообщает версию **10.3 от 24 августа 2026**.
- [Rich Messages](https://core.telegram.org/bots/api#sendrichmessage): `InputRichMessage.html`, кнопки в сообщениях, компактные таблицы и прочие Rich компоненты доступны по документированным контрактам.
- [Stars](https://core.telegram.org/bots/payments-stars): валюта XTR, `pre_checkout_query`, `successful_payment`, `telegram_payment_charge_id`.
- На момент проверки официальной спецификации **Bot API 10.4 и HTMLBubbles не найдено**. HTMLBubbles обсуждается в бета-клиентах, но не объявляется работающим Bot API. Код содержит независимый experimental interface, но **не отправляет выдуманный метод HTMLBubbles**.

## Перед эксплуатацией
- Реальные платежные тесты и эталонные HMAC уведомления Продамуса, webhook connectivity, Telegram sandbox/test environment.
- Политика возврата и пользовательские условия; публикация поддержки и проверка юридических требований.
- Независимое подтверждение статуса транзакции у Prodamus, если доступно согласно конфигурации merchant API; текущий signed webhook недостаточен для полной end-to-end приёмки.
- Идентификация внешнего покупателя. Прямой публичный POST, в котором клиент заявляет произвольный account ID, запрещён.
- Producer/worker outbox создан на уровне DB, но **реального сетевого VPN/DNS provisioning нет**. Платный SNI заблокирован.
- Полноценный HTTPS/reverse proxy, rate limits, replay protection, secret rotation, refunds and chargeback reconciler на выбранном VPS после отдельного согласования.
- **Никаких** серверов, прокси, firewall, DNS, TLS и реальных учетных записей этой веткой не затрагиваем.

CI: `npm run typecheck`, `npm test`, `db/tests/*.sql`, `npm run test:integration` на ephemeral PostgreSQL.
