# Финальное offline-ревью MNEBYVPN, 06.11.2026 — этапы 1–9

**Статус: архитектурные и платёжные контракты значительно расширены, но к коммерческому запуску NOT READY.** Ревью основано на исходниках PR №1 и фактическом CI в одноразовой PostgreSQL. Реальные VPN/DNS-узлы, API провайдеров и оплаченные транзакции не проверены.

## Закрытые дефекты

| Приоритет | Недоработка | Исправление и доказательство |
|---|---|---|
| P1 | Free trial 24ч отсчитывался при резервировании, а не активации | SQL 0009: даты NULL до узловой активации; ACK записывает activated_at + 24ч, создаёт второй revision; tests/integration/trial-activation.test.ts |
| P1 | Сигнал ENABLE не доказывал наличие узлового срокового отключения | Reconciler требует enforcesHardExpiry и фактический observed expiresAt: сначала ограниченный provisional, затем точный 24h deadline; без этих доказательств не ACK |
| P1 | Запоздалое уведомление о реально полученном платеже после CANCELLED могло оставить деньги без доступа | SQL 0010 и провайдерные validators допускают подлинно подтверждённую capture при CANCELLED; запись идемпотентная, tests/integration/late-capture-and-website.test.ts |
| P1 | Нет способа подготовить реферальный RUB checkout без нарушения политики Telegram | packages/billing/src/website-checkout.ts — отдельная библиотека для авторизованной веб-сессии, подписанный do=link запрос, строгий hostname allowlist, реферальная атрибуция в DB; никаких ссылок RUB внутри Telegram-бота |
| P1 | PR отставал от main с новым контрактом совместимости Private DNS+VPN | latest main ADR-0006, README, architecture, security, client-compatibility объединены с кодом в Draft branch. Main не изменён |

## CI и уровень уверенности

- [CI 42175218024](https://github.com/grunvald91/Mnebyvpn/actions/runs/42175218024): **success**, 59/59 Node.js unit, 16/16 PostgreSQL integration, typecheck, миграции 0001–0010 и SQL contract tests.
- В частности проверены конкурентные клики trial, один бесплатный день, первый observed enable, provisional TTL, post-ACK revision 2, точный node-observed срок, bundle-активация, expiry/revoke в mock adapter, confirmed late Stars/Prodamus, реферальная web атрибуция.
- **Тестовые adapters — in-memory mocks.** Никакого подтверждения работы Remnawave Node, DoT, SNI, VPN клиента или настоящего Prodamus merchant не получено. Флаг enforcesHardExpiry — требование интерфейса, не заменяет реальный E2E.

## Оставшиеся блокирующие вопросы (P0/P1)

1. **P0 Data plane:** отсутствуют реальные адаптеры, выдача ключей/VPN URL и DNS профилей, hard quota по SNI потоку, проверяемое отключение уже импортированных профилей при истечении срока, offline node partition. Режим Android Always-on/kill switch и совместимость Private DNS+VPN тоже не реализованы. Нельзя продавать со строгими SLA.
2. **P1 Merchant payments:** пока нет реальных Telegram Stars и Prodamus sandbox test vectors, полного refund lifecycle и независимого provider status lookup; одно подписанное уведомление Продамуса не доказывает, что платёж окончательно завершился, без provider API сверки и merchant acceptance.
3. **P1 External Prodamus checkout:** нет независимого HTTPS сайта, аутентификации сессии, безопасного публичного endpoint и webhook production auth. Код модуля не позволяет снять этот блокер автоматически.
4. **P1 User/support/legal:** тарифы 15/30/60/90 в pricing_drafts не имеют утверждённой стоимости и DNS квоты; trial_offers по умолчанию выключены; не опубликованы условия/контакты поддержки и возвратов, не пройдены live Bot API 10.4 HTMLBubble проверки.
5. **P2 Trial fairness:** резервирование единственного бесплатного периода при длительной недоступности узла пока не имеет автоматической политики повторной попытки/восстановления права. До запуска нужен утверждённый принцип отмены неактивированной заявки без возможности злоупотребления.
6. **P2 Duplicate notifications:** повторный Telegram update не создаёт второй order, но может попытаться отправить второй идентичный invoice. Нужен отдельный durable send-invoice outbox и rate limiting на внешнем HTTP edge при нагрузке.

## Платёжная политика

Внутри Telegram цифровые услуги продаются **только за Stars** (официальные правила 2026). **Продамус остаётся** выбранным пользователем провайдером для самостоятельного внешнего сайта, без перенаправления пользователей Telegram-бота к обходной оплате.

Источники:
- https://github.com/grunvald91/Mnebyvpn/pull/1
- https://core.telegram.org/bots/payments-stars
- https://telegram.org/tos/bot-developers
- https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov
- https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md
