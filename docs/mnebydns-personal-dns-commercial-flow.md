# MNEBYDNS — персональные DNS-подписки и оплата (этап #84)

**Дата: 2026-11-12. Статус: офлайн-тесты пройдены, выпуск в эксплуатацию НЕ разрешён.**

## Цель

Одна подтверждённая покупка `smart_dns` → отдельный высокоэнтропийный **DoT DNS hostname** для подписки → проверка оплаченного срока и действующей ревизии перед **каждым DNS-запросом** → отдельный агрегированный счётчик *разрешённых DNS-запросов* → перевыпуск/отзыв ключа и продление без переустановки (если ключ не перевыпускался).

Это **не** точный счётчик скачанных гигабайт; обычный телефонный DNS-over-TLS hostname **не аутентифицирует** последующие TCP/TLS-соединения к сайтам/общему SNI-прокси. Текущий общий SNI-прокси не получает DNS токен. Оплачиваемый обход сайтов через существующий публичный SNI-прокси не может считаться защищённым от использования неоплаченными клиентами до отдельного transport ACL. Сетевые эксперименты и прежние лимиты байтов остаются отдельно (не в этом PR).

## Логика покупки и выдачи

1. Пользователь входит на сайт через проверенный Telegram/email аккаунт. Серверное `accountId` берётся исключительно из отзываемой веб-сессии, не из браузерного поля.
2. `POST /api/checkout` создаёт заказ на выбранный `billing_plans` (см. `packages/billing/src/website-checkout.ts`). Подтверждением служит **только** проверенный callback Prodamus; возврат пользователя на `/payment/success` не предоставляет доступ.
3. Действующий платёжный обработчик записывает `orders=PAID`, `entitlement_credits`, `smart_dns` entitlement и outbox. **Существующий DNS provisioning adapter не включён:** до реального ACK DNS front-end после безопасной сетевой проверки подписка остаётся в `PAID_PENDING_PROVISIONING`.
4. После **реального** `ACTIVE` + актуального `provisioning_state` ACK клиент через `POST /api/me/dns-access` может один раз получить `u<48 hex>.dns.mnebyvpn.site`. Сервер генерирует 192-битный случайный ключ. PostgreSQL хранит только SHA-256, токен передаётся браузеру один раз при выдаче.
5. Android: скопировать hostname в системный Private DNS (ручная настройка, без отдельного VPN-приложения). Apple: локально скачать **неподписанный** `.mobileconfig` с `DNSProtocol=TLS`, `ServerName=personal_hostname` и самостоятельно установить. Эти профили пока не проверены на настоящих устройствах; реальный wildcard TLS-сертификат не установлен.
6. Отдельный Node TLS gateway (собственная opt-in служба) работает **только** на `127.0.0.1:8853` и не меняет существующий зарубежный `mnebydns-dot` на `:853`. Он принимает только правильный personal DoT SNI с wildcard-сертификатом; перед **каждым** DNS-over-TLS запросом через узкую функцию базы проверяет текущий статус подписки и увеличивает суточный счётчик, а затем передаёт DNS сообщение в существующий CoreDNS по loopback TCP/53.
7. Прежняя персональная ссылка перестаёт работать при явном `rotate` или `revoke`, истечении срока, возврате платежа без оставшихся оплаченных кредитов и отмене. Смена ключа разрывает доступ на всех устройствах со старым hostname. При обычном продлении действующего ключа не нужно переустанавливать профиль.
8. `GET /api/me/dns-access` возвращает только состояние и суммарные разрешённые запросы (без DNS-доменов/адресов и без исходного hostname). Присутствие счётчика не означает доступность приложений.

## Что зафиксировано в коде

- SQL: `db/migrations/0120_dns_personal_access.sql` + откатываемые SQL-контракты `db/tests/0120_dns_personal_access_contract.sql`.
- Утилиты/профили: `packages/dns-access/src/personal.ts`.
- Отдельный TLS/DoT gateway: `packages/dns-access/src/dot-gateway.ts`; отдельный gated entrypoint `apps/service/src/dns-access-gateway.ts`.
- Сайт/API/клиентский кабинет: `apps/web/src/server.ts`, `apps/web/public/app.js`, `apps/web/public/neo.css`.
- Проверки: unit + integration tests `tests/dns-personal-access.test.ts`, `tests/integration/dns-personal-access.test.ts`, `tests/integration/dns-personal-dot-gateway.test.ts`.
- CI: `offline-contracts.yml`, disposable PostgreSQL + реальный loopback TLS, временный тестовый wildcard cert генерируется внутри CI; приватные ключи в GitHub не сохраняются.

## Предохранители, которые должны остаться выключены

- `WEB_DNS_ACCESS_VERIFIED`: по умолчанию не `yes`; DNS-покупка и выдача персональных адресов скрыты/заблокированы.
- `MNEBYDNS_PERSONAL_DOT_GATEWAY`: по умолчанию выключен; даже при включении bind на **127.0.0.1** (не публичный :853).
- Общие `WEB_NETWORK_PROVISIONING_VERIFIED`, `WEB_PAYMENT_PROVIDER_TESTED`, `WEB_CHECKOUT_ENABLED`, `WEB_LEGAL_PAGES_PUBLISHED`: существующие дополнительные независимые ограничения оплаты.
- Ни этот PR, ни выполнение CI не меняют nginx, CoreDNS, VPN, Telegram proxy, DNS wildcard A/AAAA, firewall, сертификаты или роли БД на рабочих VPS.

## Отдельный риск секретности имени SNI (P0, блокирует продажи)

**Персональный DoT hostname — НЕ конфиденциальный пароль при обычном TLS без ECH.** Клиент может передать это имя как открытое SNI в TLS ClientHello; в ходе первоначального разрешения имени оно также может появляться в незашифрованном DNS-запросе. Сторонний наблюдатель сети потенциально узнаёт адрес и может использовать его как bearer-ключ чужой DNS-подписки. Большая случайность токена не защищает от перехвата уже переданного имени. Ссылка на первоисточник: [RFC 9849 (Encrypted Client Hello), раздел 1](https://www.rfc-editor.org/rfc/rfc9849.html#section-1).

Выполненный CI проверяет **механику идентификации и отзыв**, но НЕ конфиденциальность токена в сети. Стандартный Android Private DNS (DoT hostname) не позволяет просто поместить скрытый отдельный bearer-token внутрь каждого DNS TLS-запроса. Пока выбранный клиентский протокол не обеспечивает секретность независимых клиентских credentials и их проверку, система **не должна продаваться как защищённый персональный оплаченный DNS по hostname**. Вариант с DoH и токеном внутри HTTPS URL потребует отдельного реального теста поддержки системы iPhone/Android и угроз безопасности; нельзя называть его уже доступным при настройке Android в одну строку.

## Принципиальные оставшиеся задачи до платной продажи DNS за 200 ₽ / 30 дней

1. **Согласовать time-only коммерческую модель с действующей схемой БД.** Сейчас `billing_plans.dns_quota_bytes`, `entitlement_credits.quota_bytes` и `settle_verified_payment(...dns_quota_bytes)` требуют положительную квоту для `smart_dns` (историческая экспериментальная архитектура). Новый gateway НЕ использует byte meter, но оставлять в оплачиваемом плане фиктивный лимит **недопустимо**. Нужна отдельная ревизия каталога/платёжной схемы с явно заданным режимом `time_only`, безопасным переходом и тестами возврата/продления.
2. **Реальный DNS provisioning adapter** с server-observed ACK и fail-closed hard expiry. Существующий `vpn-provisioning-worker` обрабатывает только `vpn`. Нельзя искусственно делать `ACTIVE` лишь после оплаты без сетевой проверки.
3. **TLS / DNS / NGINX**: публично доверенный wildcard сертификат для `*.dns.mnebyvpn.site`, индивидуальные DNS hostname→зарубежный сервер, безопасная маршрутизация по SNI к персональному DoT gateway, независимый контроль старого общего DoT и loopback CoreDNS TCP. Не включать без staging+rollback.
4. **Настоящие телефоны**: Android Private DNS, iOS/macOS профили, Wi-Fi, мобильные сети, DNSSEC/DoH/IPv4-only, сохранение доступа к обычным сайтам при отказе платного DNS. Отдельная проверка производительности per-query SQL (p50/p95, QPS) и влияния на CoreDNS.
5. **Граница оплачиваемого SNI**: DNS-ссылка защищает **DNS-запросы**, а не публичный общий TLS passthrough. Если тариф включает обход ограничений через SNI ingress, нужен доказанный контроль доступа непосредственно на этом ingress, либо честная другая коммерческая модель. См. [контроль доступа Smart DNS](smart-dns-access-gate.md).
6. **Ключ и конфигурация**: персональный hostname является bearer-secret. Любой, кому он известен, может делать запросы от этого пакета. Подписанные Apple профили и реальная обработка сертификата требуют отдельного релиза.

## Проверяемые источники

- RFC 7858 (DNS over TLS): https://www.rfc-editor.org/rfc/rfc7858.html
- Google Android Private DNS: https://developers.google.com/speed/public-dns/docs/using/
- Apple Device Management DNS Settings: https://developer.apple.com/documentation/devicemanagement/dnssettings
- Текущая схема платёжных тарифов: `db/migrations/0004_catalog_and_orders.sql`, `db/migrations/0013_entitlement_credits.sql`, `db/migrations/0105_paid_vpn_activation_clock.sql`.
- Логика paid-only выдачи и отказа: `db/migrations/0120_dns_personal_access.sql`, `tests/integration/dns-personal-access.test.ts`.

**GO/NO-GO: сейчас NO-GO по коммерческой активации.** Следующий технический PR должен адресовать time-only billing schema и честную активацию через реальный DNS gateway.
