# Ревью замечаний 06.11.2026 — исправления после PR #1

## Проверенные дефекты и действия

| № | Приоритет | Статус и доказательство |
|---|---|---|
| 1 | P1 | Исправлено в `reconciler.ts`: **любой** разрешённый VPN/DNS доступ требует `enforcesHardExpiry=true`, `observed.expiresAt`, совпадающий с серверным сроком. Без этого ACK/synced запрещён. См. `tests/reconciler.test.ts` и `tests/integration/phase5.test.ts`. Реальный on-wire hard expiry пока не проверен. |
| 2 | P1 | Исправлено в `pg-worker.ts`: `pg_try_advisory_lock`, единый `PoolClient` для вложенных операций через `AsyncLocalStorage`. Два независимых entitlement и два concurrent reconcile того же entitlement проверены с max=2 соединениями. |
| 3 | P1 | Добавлен `runProvisioningLoop` с `expireDue` / `scheduleDriftScan` / `processOnce`, ограничение числа операций. Запуск `npm run start:worker:offline` вручную; сетевых адаптеров нет, реальное предоставление услуг не стартует. |
| 4 | P1 | `payment_incidents` с уникальным хешем транзакции, причинам ошибок, at-least-once webhook receipt и очередью оповещения оператора. **Только аутентифицированные** captures с ошибкой суммы/заказа или `DENY_*` фиксируются и отвечают 200 после commit; неподписанный Prodamus webhook получает 401, авария DB остаётся 503. Реальные оповещения требуют конфигурации оператора. |
| 5 | P1 | `account_product_slot` + `order_entitlement_credits`: повторная оплата продлевает `max(now,expiresAt)+duration`, пополняет DNS квоту и сохраняет тот же entitlement/credentials. Рефанд уменьшает именно соответствующий кредит и не уничтожает другой оплаченный период. Проверены конкурентные оплаты и возвраты. |
| 6 | P2 | `.github/workflows/offline-contracts.yml` запускается на `pull_request` в `main`, `push main`, `workflow_dispatch`. Использует временную PostgreSQL, не деплой. |
| 7 | P1 | Триал ограничен одним Telegram ID и дополнительным суточным лимитом `trial_offers.max_daily_grants`; клиенты с оплаченной подпиской не получают бесплатный пробник. **Не решено полностью**: множество новых Telegram ID не являются доказательством разных людей. Нужна защита от мультиаккаунтов / бюджета до включения публичных trials. |
| 8 | P1/P2 | Методы widget Bot API 10.4 документированы в `TelegramMessenger/widget-sandbox/docs/tgw-format.md`, датированном 2026-10-26, и проверены в beta по тексту документа. Не могу подтвердить их доступность в действующем боевом Bot API или на телефоне пользователя: E2E пока не было. |
| 8b | Правила | **Stars + RUB/Продамус** реализованы как альтернативные кнопки, но RUB в боте и реферальном Bubble **выключен по умолчанию** и требует `MNEBYVPN_TG_RUB_LINKS_EXPLICIT=true` при запуске offline test runner. Это пользовательский запрос, но официальные правила Telegram однозначно требуют **Stars** при продаже цифровых услуг внутри ботов, включая случай отдельного сайта. Нельзя называть такое включение беспроблемным или рекомендовать запуск без подтверждения допустимости у Telegram. |

## Рублёвый сценарий (отдельный opt-in)

1. Кнопка `₽` появляется рядом со Stars только если задан доверенный `PayformLinkTransport` и существует реальный RUB price в `billing_plans`.
2. `rublePlanKey` привязан к идентификатору, наименованию, сроку, цене и DNS квоте и сверяется **в транзакции**. Цена замораживается в `order_terms`.
3. `createTelegramRubleOrder` устанавливает аккаунт из **проверенного Telegram webhook sender**, а не из полей браузера. Реферальный код сохраняется атомарно.
4. Формируется подписанный запрос `do=link` Продамусу. Возвращённая ссылка допускается только для `https://payform.ru` или поддомена `*.payform.ru`, без userinfo, фрагмента и переносов.
5. Пользователю отправляется inline-кнопка URL на итоговую форму. **Доступ не предоставляется до проверки аутентифицированного webhook и SQL settlement**.
6. Bubble передаёт `public_data.r=1` только при explicit opt-in. Тогда открывает `t.me/<bot>?start=p<referral-token>` с тем же выбранным тарифом, не повторяя шаги выбора.

## Что не подтверждено и запрещено считать готовым

- Нет настоящего ingress для платного Smart DNS/SNI, нет рабочих адаптеров Remnawave, DNS, маршрутизации, реальной выдачи профиля и on-wire тестов приватности, квот и отключения при сетевой изоляции.
- Нет реального end-to-end чека Stars/Prodamus, merchant test credentials и verified refund в боевой среде; `MNEBYVPN_ENV=offline-test` ограничивает сам runner.
- Нет опубликованных цен RUB/XTR и DNS квот: `pricing_drafts` содержит заготовки со значениями NULL.
- `trial_offers` остаётся выключенным до проверки узлов, anti-fraud, метрик и политики восстановления недоставленного доступа.

## Первоисточники

- Telegram Bot API widget-sandbox: https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md
- Telegram Payments Stars FAQ: https://core.telegram.org/bots/payments-stars
- Правила Telegram для цифровых услуг, §6.2: https://telegram.org/tos/bot-developers
- Prodamus API: https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov
- PR: https://github.com/grunvald91/Mnebyvpn/pull/5
