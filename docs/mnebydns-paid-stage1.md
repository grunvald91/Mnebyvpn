# MNEBYDNS: этап 1 задачи #84 — контракт допуска платного ingress

**Статус: CODED / E2E BLOCKED.** Этот этап создаёт **только проверяемый SQL-контракт** персонального платного ingress. Никакого готового DoT/DoH endpoint, TCP proxy, измерителя байтов, работающих платных DNS-ссылок или выпуска на сервер он не создаёт.

## Что добавлено
- `db/migrations/0109_smart_dns_paid_ingress_gate.sql`: `authorize_paid_smart_dns_ingress(destination_ipv6)` возвращает идентификатор подписки, текущую revision, expiry и остаток квоты **только** для активной оплаченной DNS-подписки с уникальным IPv6 и подтверждённой revision provisioning.
- Нулевой доступ для неизвестных/выведенных из обращения IPv6, IPv4, CIDR, неподтверждённой выдачи, неоплаченного/неучтённого кредита, `EXPIRED`, `EXHAUSTED`, устаревшей revision.
- Триггер запрещает удалить, переназначить или восстановить выведенный из обращения IPv6. Разрешена только однонаправленная операция `retire_smart_dns_ipv6`.
- `db/tests/0109_smart_dns_paid_ingress_contract.sql`: фиктивные счета и подписки, отдельные владельцы, независимые остатки, прямой вход по адресу после expiry, имитация stale ACK, расход квоты, защита tombstone. Только disposable PostgreSQL, все тестовые данные откатываются.
- `.github/workflows/offline-contracts.yml` проверяет миграции и негативные SQL-контракты. Проверка в PR **не деплоит** и не включает продажи.

## Что НЕ доказано
1. Российский/зарубежный VPS имеет достаточно выделенных **маршрутизируемых** IPv6, которые отдельный ingress может различать по destination IP.
2. Системный Android Private DNS использует персональный hostname/резолвер, а настоящий TLS passthrough получает именно тот destination IPv6. IPv4-only сети, NAT64, ECH, QUIC и DNS cache — отдельно.
3. Прокси проверяет эту таблицу перед передачей **каждого** нового соединения, обрывает старые, живёт при недоступной БД в fail-closed и знает общий лимит.
4. `debit_smart_dns_quota` принимает только **реальные** переданные TCP TLS payload bytes, порционно резервируемые до отправки; повторная доставка, авария и несколько нод не ведут к двойному списанию или перерасходу.
5. Реальные успешные платежи, выдача и отзыв DNS-реквизитов, календарная аналитика, сроки отсечения.

## Следующий обязательный шаг (GO/NO-GO, сначала read-only)
На действующих серверах собрать **в приватном отчёте без адресов/ключей в git**:
- IPv6 assigned prefixes / `ip -6 addr`, `ip -6 route`, route reachability, возможность привязки дополнительного IPv6 к listener и ACL без изменения действующих портов.
- Список реально активных DNS и SNI services, IPv4/IPv6 ingress, NAT/routing, версии resolver и nginx, состояние и нагрузку. Только `read-only`: никаких `iptables`, `nft`, `sysctl -w`, `nginx -s reload`.
- Наличие подтверждённого upstream TLS и DNS fallback; обратимое staging размещение с портами/адресами, не пересекающимися с рабочими.
- Android Private DNS: тестовый клиент с мобильным интернетом и другой сети, **VPN выключен**; отдельно IPv4-only сценарий.
- Два абонента + один домен + два отдельных ingress destination IPv6 → независимое измеренное разрешение/отказ. **Без этого шага коммерческий DNS-only режим остаётся NO-GO.**

Если уникальные routable IPv6 недоступны, не имитировать клиентский учёт через DNS count или source IP. Рассмотреть отдельный протокол аутентификации (CONNECT/SOCKS) или VPN и явно изменить продуктовый UX, не обещая «только DNS».

## Будущие PR
1. **PR1 (этот):** fail-closed SQL admission + immutable tombstones + rollback tests; подготовка безопасного сетевого preflight.
2. **PR2:** реальная персональная DoT/DoH-выдача, надёжная БД bearer credentials, audit/revoke и безопасный resolver cache — после GO по сетям.
3. **PR3:** реальный ingress attribution, байтовые counters и preauthorized reservation/settlement, expiry enforcement, negative network E2E.
4. **PR4:** месячные/периодные отчёты, API/cabinet, notifications, verified payment provisioning и renew.
5. **PR5:** контрольные покупки, несколько телефонов, отказоустойчивость, canary, rollback и только потом коммерческое разрешение.

## Граница безопасности
- Этот контракт **не авторизует реальные TCP-сессии** сам по себе: `nginx ssl_preread` не вызывает SQL-функцию. Перед подключением live ingress нужен отдельный stateful adaptor с подтверждённым deny/timeout/chunk metering.
- Доступ к SQL-функции закрыт для `PUBLIC`; нельзя выдавать общий DB credential конечным клиентам. Будущий ingress сервис должен иметь выделенную роль с узкими полномочиями, безопасный канал и таймауты.
- Любой bearer IPv6 передаваем; утечка адреса может расходовать чужую квоту. Пользователи по HWID не ограничиваются, одна подписка — общий пакет.
- Существующие рабочие DNS маршруты, VPN, публичные listeners, другие сервисы не затронуты.
- `WEB_NETWORK_PROVISIONING_VERIFIED`, `WEB_DNS_METERING_VERIFIED` и DNS checkout **не включать**. `docs/release-gates.md` менять лишь при документированном реальном E2E.

Ссылки: [issue #84](https://github.com/grunvald91/Mnebyvpn/issues/84), [access gate](smart-dns-access-gate.md), [shared quota](decisions/0005-shared-dns-quota.md), [release gates](release-gates.md).
