# MNEBYVPN — решение владельца о каналах оплаты (06.11.2026)

## Желаемый пользовательский интерфейс

- **Telegram-бот `@MnebyVPN_bot`**: на опубликованных тарифах показать **Telegram Stars** и **Prodamus**.
  - Stars: нативный счёт `sendInvoice` с `XTR`; `pre_checkout_query`, `successful_payment` и `refunded_payment` обрабатывает коммерческий backend, а не информационная заглушка.
  - Prodamus: открывается **независимый сайт** `https://mnebyvpn.site/` с выбранным VPN и сроком; бот не принимает RUB, не формирует платёжную ссылку самостоятельно, не доверяет успешному возврату браузера. Факт оплаты — только проверенный подписанный webhook сайта.
- **Независимый сайт**: **только Prodamus**, без Stars.
- Аккаунт и доступ к VPN должны совпадать для покупок и управления через сайт и Telegram. На реальных production-базах это требует отдельного E2E, а не простого совпадения полей в коде.
- Никаких дополнительных платёжных провайдеров не добавлять без запроса владельца.

## Ограничение платформы Telegram — не скрывать

По официальным правилам Telegram продажа цифровых услуг внутри бота допускает только Telegram Stars. Даже переход из бота к альтернативной внешней оплате несёт риск санкций платформы. UI с альтернативой Prodamus реализован по прямому решению владельца; независимый веб-сайт может существовать и принимать Prodamus отдельно. Перед публичным запуском требуется отдельно проверить соответствие варианту показа Prodamus условиям Telegram.

Официальные источники:
- https://core.telegram.org/bots/payments-stars
- https://telegram.org/tos/bot-developers (пункт 6.2)
- https://help.prodamus.ru/payform/integracii/rest-api/url-dlya-uvedomlenii-i-sekretnyi-klyuch

## Реализация / приёмка

- `apps/service/src/telegram-cabinet-server.ts`: основной production-обработчик Telegram, напрямую возвращает один Bot API метод в JSON ответе авторизованному webhook. Не требует хранения Bot API token на VPS.
- `packages/billing/src/stars.ts`, `packages/billing/src/store.ts`: подписанный payload, цены из опубликованных `billing_plans`, атомарный capture, защита от повторов и возврат.
- `STARS_PAYLOAD_SECRET` можно задать защищённой переменной окружения. Если она не задана, payload signing key детерминированно выводится из защищённого `TELEGRAM_WEBHOOK_SECRET_SHA256` с отделением контекста. При смене секрета webhook не менять его без обработки уже выставленных счетов.
- Prodamus: админ `mnebyvpn.payform.ru` → «Настройки» → «Секретный ключ»; настроить `https://mnebyvpn.site/webhooks/prodamus`; секрет хранить только серверно.
- `tests/integration/telegram-cabinet-stars-live.test.ts`: симуляция HTTP-обмена на PostgreSQL; **не** реальная транзакция Telegram или Prodamus.
- Проверки перед production: опубликованные тарифы RUB/XTR, реальный Telegram счёт и успешная/повторная оплата, refund, подписанный Prodamus callback, общность аккаунтов и сетевое предоставление VPN. Пока они не подтверждены — не заявлять, что реальные платежи принимаются.
