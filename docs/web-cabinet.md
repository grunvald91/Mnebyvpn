# Веб-кабинет MNEBYVPN — этап 11 (06.11.2026)

Статус: **код в ветке разработки**, не опубликован и не проверен реальными Telegram OIDC / Prodamus / VPN / Smart DNS сетевыми испытаниями.

## Что добавлено

- Статическая адаптивная страница: `apps/web/public/index.html`, `site.css`, `app.js`.
- `apps/web/src/server.ts` — loopback HTTP backend с read-only каталогом и кабинетом, OIDC login, историей заказов, авторизованным Prodamus checkout; никаких публичных URL персональных VPN-профилей.
- `packages/web/src/security.ts` — Telegram OpenID Connect Authorization Code + PKCE S256 + state, server-side exchange, JWKS проверка ID token (RS256, issuer, audience, expiry, Telegram user ID), короткие подписанные HttpOnly SameSite cookies, CSRF + Origin check.
- `packages/web/src/dashboard.ts` — подписки только аккаунта подтверждённого Telegram ID. Таблица `accounts` уже общая с ботом: **второй аккаунт не создаётся**, при входе используется upsert по `telegram_user_id`.
- `tests/web-cabinet.test.ts` — unit тесты подписи, неверного issuer/audience/истёкшего JWT, PKCE state, CSRF, сокрытия непроверенных DNS-измерений.

## Обязательный пользовательский сценарий

1. Посетитель видит страницу и **только опубликованные** в `billing_plans` рублёвые тарифы (`enabled=true`, `rub_minor IS NOT NULL`).
2. Выбирает услугу (VPN / Smart DNS / комплект, если комплект когда-либо опубликован), 15/30/60/90 дней. Пустые/неутверждённые варианты недоступны и не имеют вымышленных цен.
3. Открывает `/auth/login` → Telegram OIDC. В BotFather Login Widget необходимо зарегистрировать **реальный** HTTPS-origin и точный callback `https://<домен>/auth/callback`, получить Client ID/Client Secret. Это современный OIDC flow, не устаревший login widget HMAC bot-token.
4. После успешной серверной валидации сайт ставит защищённую сессию на 12 часов. Персональные API никогда не принимают `accountId` от клиента. `GET /api/me` показывает entitlements и заказы того же аккаунта, что обслуживает бот.
5. `POST /api/checkout` только с сессией, Origin и CSRF, планом и уникальным requestId. В существующем `PgBillingStore` PostgreSQL snapshot условий, идемпотентность, rate limit, запрет self-referral и verified capture. Результат — **только** URL Prodamus с allowlist доменов, не обещание оплаченного доступа.
6. Реально оплаченный заказ признаётся `PAID` **только** после подписанного проверенного webhook Продамус, с существующей транзакцией settlement/outbox. `urlSuccess` / возврат браузера не является подтверждением платежа. Продажа цифровых товаров *в Telegram* остаётся на Stars; рублёвый Prodamus используется только на отдельном внешнем сайте.

## Честность квот и сроков

- `expires_at=NULL` означает «ожидает фактической активации», а не вымышленные 24 часа.
- Остаток времени считается из серверного `expires_at` и текущего времени.
- `quota_limit_bytes` показывает размер **предоставленного пакета**. `quota_used_bytes` и «остаток» скрыты, пока `WEB_DNS_METERING_VERIFIED` не был вручную установлен после реального on-wire испытания единого SNI/DoT subscriber bucket на всех узлах/устройствах. Записанные в тестовой БД нули нельзя выдавать за реальные показания.
- Не выдаём под видом работающих кнопок ещё не реализованные VPN профили, private DNS хосты, QR или функции перенастройки клиентов. Выдача конфигураций привязана к будущим реальным provisioning adapters.

## Конфигурация и границы запуска

**Публичный deployment сейчас блокируется отсутствующими live gates.** Локальный запуск веб-интерфейса возможен только при подготовленной PostgreSQL базе с миграциями 0001–0011 и тестовыми OIDC credentials. Не коммитить секреты или `.env`.

Переменные:

| Env | Назначение |
| --- | --- |
| `MNEBYVPN_ENV=offline-test` | Изолированная разработка; либо `production` после release gate |
| `WEB_BASE_URL` | Точный origin сайта, в production только HTTPS |
| `WEB_PORT` | Loopback порт по умолчанию 8791 |
| `DATABASE_URL` | Существующая бизнес-БД PostgreSQL |
| `WEB_SESSION_SECRET` | Случайный секрет >=32 символов, вне репозитория |
| `TELEGRAM_OIDC_CLIENT_ID` | Идентификатор бота из BotFather |
| `TELEGRAM_OIDC_CLIENT_SECRET` | OIDC client secret **не Bot API токен** |
| `WEB_RELEASE_APPROVED=yes` | Явная разблокировка production после review и проверки |
| `WEB_CHECKOUT_ENABLED=1` + `WEB_PAYMENT_PROVIDER_TESTED=yes` | Разблокировать внешние RUB платежи только после проверки merchant |
| `WEB_DNS_METERING_VERIFIED=yes` | Публикация использованных байтов только после настоящего flow metering E2E |
| `PRODAMUS_FORM_URL`, `PRODAMUS_NOTIFICATION_URL`, `PRODAMUS_SUCCESS_URL`, `PRODAMUS_RETURN_URL`, `PRODAMUS_SIGN_SECRET` | Только при разблокированной оплате, по существующему контракту |

Запуск: `npm install`; `npm run typecheck`; `npm test`; `npm run start:web` (слушает только `127.0.0.1:8791`). Внешняя доступность требует отдельно настроенного TLS reverse proxy, ограничений HTTP, реального домена и legal/support pages.

## Незакрытые блокеры

- **P0** реальная выдача VPN и Smart DNS, on-wire счётчик и ограничитель байтов, offline hard-expiry тесты. Биллинг/страница не доказывают работающий доступ.
- **P1** Telegram OIDC live проверка с реальным BotFather client, callback, устройствами; работа URL авторизации проверена только кодом.
- **P1** Продамус sandbox + webhook/signature/refund + end-to-end браузерный сценарий; условия продажи, контакты поддержки, политика обработки данных, юридические реквизиты до публичной оплаты.
- **P1** тарифы RUB/Stars, DNS квоты, пробный день должны быть утверждены и опубликованы владельцем. **Никаких** цен по умолчанию.
- **P1** публичному сайту потребуются rate limiting перед OAuth, secure-session server-side revocation/rotation по оценке рисков и защита внешнего reverse proxy. Сейчас только loopback и signed session TTL12h.
- Существующие серверы, nginx, Xray/DoT/порты/фаервол **не изменялись**.

Источники: [Telegram OIDC](https://core.telegram.org/bots/telegram-login), [Telegram legacy widget](https://core.telegram.org/widgets/login/), [Prodamus do=link](https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov).
