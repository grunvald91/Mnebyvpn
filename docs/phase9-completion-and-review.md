# Этап 9 — завершение offline-контрактов и повторное ревью

Дата: 2026-11-06. Изменения только в Draft PR, без VPS.

## Исправлено

**P1 — 24 часа пробного доступа с момента включения, не с момента заявки.**
- 0009_trial_activation_on_provision.sql: trial_grants.activated_at/access_expires_at остаются NULL до подтверждённого adapter-side ENABLE (rev1 + fencing).
- До первого включения entitlement.starts_at и expires_at равны NULL; заявка не означает доступ.
- worker использует короткий provisional expiresAt (~5 минут) и отказывается от trial-адаптера без явного enforcesHardExpiry. Адаптеров продакшена пока нет.
- после подтверждённого включения SQL фиксирует 24 часа, повышает revision и создаёт обязательный второй сигнал, чтобы заменить provisional deadline на точный.
- bundle trial начинает единый период при первом наблюдаемом включении; оба entitlement получают одинаковый expires_at.
- Нет гарантий реального on-wire enforcement до сетевых испытаний. trial_offers остаются выключенными по умолчанию.

**P1 — оплаченный, но внутренне отменённый из-за истёкшей заявки счёт.**
- SQL 0010 и проверки Telegram Stars/Prodamus принимают реально подтверждённый captured платёж при состоянии заказа CANCELLED после timeout, строго сверяя провайдера, заказ, сумму, валюту, transaction ID.
- Идемпотентная capture выдаёт entitlement ровно один раз. Нельзя игнорировать полученные деньги, если webhook опоздал.
- Создание нового invoice на отменённый заказ не разрешается.

**Продамус — только независимый сайт.**
- packages/billing/src/website-checkout.ts формирует signed do=link из immutable order snapshot и принимает только проверяемый HTTPS Payform URL.
- Атрибуция реферала сохраняется атомарно. Настоящая авторизация website session должна установить accountId ДО вызова модуля; accountId из браузера не является аутентификацией.
- НЕТ публичного HTTPS checkout, live merchant test vectors и реальной оплаты. В Telegram цифровые услуги продаются исключительно за Stars.

## Остающиеся риски и блокировки выпуска

1. **BLOCKING:** Remnawave VPN, DoT/CoreDNS/SNI ingress, выдача ключей, отзыв импортированных профилей, enforcement трафика/срока при partition — нет действующего адаптера или E2E.
2. **BLOCKING:** подтверждённые реальные Telegram Stars и Prodamus платежи/refunds с merchant credentials и независимой проверкой.
3. **BLOCKING:** внешний HTTPS сайт с login, сессией и платёжной авторизацией; website-checkout — библиотека, не действующий endpoint.
4. **BLOCKING:** контакт поддержки и правила покупки/возврата, утверждённые RUB/XTR цены и DNS-квоты, испытание Telegram HTMLBubbles 10.4 на клиенте.
5. **BLOCKING:** собственный Android-клиент для Always-on/kill switch и совместимость Private DNS+VPN остаются архитектурной целью (ADR-0006 в main); реальные тесты не проведены.
6. **Долг:** узловой worker runner, мониторинг очереди и rollback, per-edge throttling, проверка provider-signature на реальных тестовых уведомлениях.

## Проверяемые источники

- https://core.telegram.org/bots/payments-stars
- https://telegram.org/tos/bot-developers
- https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov
- https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md
- https://github.com/grunvald91/Mnebyvpn/pull/1

## Фактический результат CI

[GitHub Actions run 42174724473](https://github.com/grunvald91/Mnebyvpn/actions/runs/42174724473) — SUCCESS на исходниках 2c5f6234016822e8a68850afc421cf6ba19f7767. **58/58 Node.js unit tests, 16/16 PostgreSQL integration tests**, TypeScript typecheck, миграции 0001–0010 и SQL-контракты. Выполнение на временной базе не подтверждает реальных оплат, работы VPN/DNS-узлов или поведения при сетевых разделениях.

## Интеграция с main

В Draft PR включены изменения из main (ADR-0006 и ссылки в README, архитектуре, клиентской матрице и безопасности). Они добавлены без изменения существующих технических реализаций. Исходный main не модифицирован; интеграция призвана устранить расхождение истории и сохранить требования к Private DNS + VPN.
