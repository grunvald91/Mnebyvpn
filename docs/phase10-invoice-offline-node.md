# Этап 10 — защита отправки Stars, корректный пробный статус и offline-тест узла

Дата: 06.11.2026. **Это разработка и проверка кода, не запуск VPS.**

## Исправления замечаний (P1/P2)

### 1. Повторная отправка Telegram Stars invoice (P1)
- Миграция 0011_telegram_invoice_dispatch.sql: по одному уникальному order_id может существовать только одна зарезервированная попытка отправки sendInvoice.
- PgBillingStore.reserveStarsInvoice() атомарно проверяет PENDING + исходный Telegram account + срок invoice и создаёт запись (INSERT ... ON CONFLICT DO NOTHING). Конкурентные webhook redelivery не создают второй sendInvoice по тому же order_id.
- После ответа Bot API запись становится SENT; при ошибке HTTP/таймауте — **UNKNOWN**, без автоматического повторения. UNKNOWN означает неопределённость результата, а не подтверждённую доставку.
- Для нового добровольного заказа покупатель возвращается к выбору тарифа; остаётся ограничение трёх незавершённых заказов за 15 минут и независимая проверка суммы/pre-checkout.
- Важно: **at-most-once попытка** не гарантирует, что счёт дошёл до пользователя. Реально оплаченная несколько раз одна услуга потребует поддержки/refund; Telegram/provider E2E остаются блокером.

### 2. Неверное сообщение о пробном доступе (P2)
- Если trial_grants существует, но activated_at NULL, выдаём PENDING, а не ALREADY_USED. Пользователю сообщается, что доступ ещё активируется, а 24 часа не расходуются.
- После подтверждённой активации при повторном запросе возвращается ALREADY_USED.
- Исходная резервация НЕ удаляется только из-за недоступности панели: повторное неконтролируемое создание entitlement/доступа запрещено. Нужен отдельный админский/узловой аудит для отмены зависшей заявки.

## Следующий шаг: офлайн-испытание узлового срока действия

- OfflineExpiryNodeSimulator — изолированная **in-memory** модель узла, которая не принимает внешних IP, не использует реальные ключи и не подключается к VPN/DoT/Remnawave.
- Модель имитирует upstream apply/inspect, независимую локальную проверку expiresAt для нового подключения и уже открытой сессии, а также разрыв control-plane.
- В тестах VPN- entitlement проходит PostgreSQL verified capture → outbox → mock node ENABLE → partition → node-side deadline → запрет новых/существующих потоков → восстановление и mock node DISABLE.
- Negative test подтверждает честную границу: если refund/SUSPEND произошёл в панели **во время partition**, реальный узел не узнает об отзыве немедленно и может пропускать трафик до заранее установленного локального предела. Это не гарантия мгновенного отзыва.

## Что обязательно дальше для запуска

1. При наличии разрешённых узлов реализовать реальные адаптеры Remnawave VPN и Smart DNS/DoT/SNI на основании их официальных контрактов. Проводить on-wire тесты TLS, повторного подключения уже импортированного профиля и существующей сессии.
2. Проверить offline hard expiry при panel↔node partition, reboot, clock skew, IPv4/IPv6, UDP/QUIC. Флаг enforcesHardExpiry=true сам по себе не является доказательством.
3. Доказать per-flow subscriber attribution и hard traffic quota для MNEBYDNS, не по числу DNS-запросов. Неподтверждённые платные SNI ingress/Smart DNS остаются BLOCKED.
4. Проверить реальные Stars/Prodamus test transactions и возвраты; настроить операционную поддержку /paysupport и публичные условия услуг.
5. Утвердить RUB/XTR-цены, квоты и бизнес-политику «зависшего» неактивированного trial. До этого trial_offers выключены, pricing_drafts не опубликованы.
6. Реально проверить Telegram HTMLBubbles 10.4, кнопки и реферальный checkout на поддерживаемом клиенте. Официальный transport: https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md

## Ссылки
- Review: docs/review-20261106-final.md
- Offline expiry architecture: docs/offline-expiry.md
- Platform agreement for digital services: https://telegram.org/tos/bot-developers
- Stars: https://core.telegram.org/bots/payments-stars
- Repo: https://github.com/grunvald91/Mnebyvpn/pull/1

## Результаты тестирования

[GitHub Actions 42177619691](https://github.com/grunvald91/Mnebyvpn/actions/runs/42177619691): **SUCCESS**, 64/64 unit tests, 20/20 PostgreSQL integration tests, TypeScript, миграции 0001–0011 и SQL контрактные тесты, на исходниках ea5501df89f5fe236a64e5242c05e0446cba8711. Симуляция не является подтверждением фактического поведения сетевого узла.

См. [повторное ревью](review-20261106-phase10.md).
