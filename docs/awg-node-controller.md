# MNEBYVPN — центральный доступ к AmneziaWG 3.1

Изменения: `db/migrations/0131_vpn_awg_peer_allocations.sql`, `packages/provisioning/src/awg-controller-grants.ts`, `tests/awg-controller-grants.test.ts`.

## Архитектурная граница

- Только **реально действующее VPN entitlement** (product=`vpn`, state=`ACTIVE`, текущая revision) вправе получить серверный AWG peer grant.
- Узел должен быть заранее зарегистрирован Ed25519 challenge/response в `vpn_node_enrollment_inventory` со статусом `enrolled`, а отдельный AWG pool иметь свежую независимую E2E-проверку, `state=verified`.
- Глобальный флаг `vpn_awg_clients` создан **false**. Даже если исходники развёрнуты, ни один клиент не получает новый grant до отдельного релиза.
- Серверная AWG конфигурация на финском VPS использует `10.73.91.0/24`. Поэтому первый выпуск ограничен узлом `fi-test-01` (`fi.mnebyvpn.site`). Для остальных стран до включения требуется расширить общий IPAM и on-node валидатор адресов; код сознательно запрещает предположительный cross-country allocation.
- Клиентский приватный ключ создаёт сам клиент. Сайт/контроллер принимает только публичный ключ, выдаёт уникальный IPv4/32 и подписывает контрольную команду Ed25519.
- Подпись связывает `nodeId, op, entitlementId, revision, peerPublicKey, clientIpv4, expiresAt, issuedAt, nonce`. Узел доверяет исключительно заранее закреплённому публичному Ed25519 контроллера. Код подписания **не должен работать на публичном web, в GitHub Actions или у ИИ-агентов**.
- На новом Nodekit VPS `awg_peer_grants.py` проверяет подпись и монотонную ревизию, `awg_watchdog` каждые две секунды удаляет просроченные peers и аварийно опускает интерфейс при ошибке. Подписка/доступ не публикуется автоматически при одной лишь записи в БД.
- Отзыв можно сформировать даже для уже истёкшего права. Состояние `revoked` хранит ревизию, чтобы отложенная старая команда не могла снова включить клиента.

## Не перепутать с VLESS или персональным DoT

`/sub/<token>` уже существует и содержит VLESS/Xray; **AWG 3.1 не является обычной VLESS-ссылкой**. Нужны отдельный генератор совместимого AWG 3.1 профиля, подтверждение поддерживаемых версий клиентов и собственный безопасный способ получить профиль с существующим VPN-правом. До успешной проверки не добавлять AWG данные в `/sub`.

У DNS уже действует персональная схема `<12-символьный-токен>.dns.mnebyvpn.site`. Распространять неаутентифицированный доступ CoreDNS в каждой стране нельзя. Следующая интеграция — контролируемый премиальный backend или отдельный SNI ingress с полноценным wildcard TLS и тем же PostgreSQL grant authority.

## Производственный запуск — отдельный gate

1. Независимо проверить страну выхода FI, доступность TCP/UDP от настоящего внешнего устройства, правильный MTU и IPv4 NAT.
2. Записать доказательство E2E в `vpn_awg_node_pools`, а не просто выставить `verified`. Реестр узлов проверяет node Ed25519 identity и последний успешный чек.
3. Настроить контроллерный приватный ключ, недоступный GitHub, и закрепить его публичный SPKI на тестовом узле. Проверить локальный подписанный grant/revoke и фактическую очистку живого peer после окончания срока.
4. Реализовать надёжную доставку подписанных команд и подтверждение их фактического применения узлом в центральную БД. `state='staged'` никогда не означает работающую подписку.
5. Только после полноценной проверки и защищённого UI включить `vpn_release_flags.vpn_awg_clients` на production. Ошибки узла должны приводить к `degraded` без отключения других существующих серверов.

Никакие приватные ключи или клиентские конфигурации не записываются в таблицы `vpn_awg_peer_allocations`. На текущем этапе migration создаёт только неактивные таблицы и флаг.

Официальные спецификации: [AmneziaWG tools](https://github.com/amnezia-vpn/amneziawg-tools), [PostgreSQL inet/cidr](https://www.postgresql.org/docs/current/functions-net.html).

## Ревью 2026-11-18 — долговечная доставка и подтверждение

- **Максимальный AWG lease — 60 минут**, а не срок всей купленной подписки. Будущий controller scheduler должен перевыпускать грант примерно каждые 15 минут, проверяя действующее право. При недоступности контроллера трафик отключится по истечении последнего локального lease.
- **Миграция 0133** создаёт `vpn_awg_command_outbox`; каждая выдача/отзыв записывается вместе с ревизией entitlement в одной транзакции. Очередь не может открывать доступ самостоятельно.
- Подписанная команда принимается узлом в пределах 45 секунд от `issuedAt`. Контроллер допускает claim очереди только в первые 35 секунд; просроченные команды становятся `stale` и должны **переиздаваться после новой проверки прав**, а не повторно отправляться.
- После успешного `awg syncconf` Nodekit подписывает расписку `MNEBYVPN_AWG_APPLIED_V1` уникальным локальным ключом узла. `acknowledgeAwgCommand` сверяет её только с заранее зарегистрированным публичным Ed25519 SPKI узла и текущей ревизией allocation. `state=applied` нельзя установить по неподписанному сообщению «успешно».
- **Остаётся**: отдельный доверенный controller worker доставки через защищённый SSH / приватный RPC и планировщик обновления lease. Миграция не применяется к production только за счёт merge в Git; проверьте реальное состояние схемы прежде чем включать новую функцию. Флаг `vpn_awg_clients` остаётся false.


## Production deployment clarification 2026-11-18

The central controller already exists on **188.120.254.223**. Keep the
central DB, bot, entitlement and expiry workers there. A new FI node is an
egress/provider-only node; a second production controller must not be
created. The **Telegram proxy** is Telemt/MTProto, separate from both AWG
and the SmartDNS SNI stream. The existing Telemt owner contract lives in
`packages/web/src/telegram-proxy-provisioning.ts`; reuse that contract
for per-user activation/revoke rather than treating SNI as a Telegram proxy.
