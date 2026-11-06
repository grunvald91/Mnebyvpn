# Security review — MNEBYVPN VPN / MNEBYDNS / Ops

## Публичный репозиторий

Никаких рабочих API keys, SSH passwords/keys, subscription URLs/QR, TLS/WireGuard/Xray private keys, токенов DoH, raw logs, .env или cloud provider state в git. Отдельно проверить историю публичных репозиториев, включая ссылки на аудит и старые коммиты: удаление строк из HEAD **не удаляет историю Git, публичные Actions-логи и чужие копии**. При фактическом раскрытии секретов — согласованная rotation. **Не публиковать** клиентские IP и историю DNS.

## Доступ к сетевым интерфейсам

- Panel UI/API — закрытый admin/management segment, защищённая аутентификация, RBAC, audit.
- Remnawave Node control port — только от Panel IP, по официальным требованиям https://docs.rw/install/remnawave-node/ . Не привязывать к публичному 443.
- Root SSH только на время администрирования, по возможности ключи и pinned host keys, no `StrictHostKeyChecking=no`; least privilege.
- Firewall открывать только по приватной утверждённой карте портов. Нестандартные публичные listeners требуют доказанного теста внешней достижимости/авторизации; не называть open proxy без проверки.
- DoH/DoT protected resolver: доступ только с проверенным entitlement и ограничения запросов, либо отдельно утверждённая abuse policy. Иначе становится публичным open resolver.
- SNI ingress: explicit allowlist, нет универсального proxy target, блок private/localhost/metadata, DNS rebinding, target whitelist pinning, лимиты соединений/полосы. **No TLS interception / root CA**.
- Помнить о built-in DoH в приложениях, DNSSEC, ECH, QUIC. DNS-режим не объявлять полноценной защитой приватности/VPN.

Правовая проверка рекламы, ПДн и оферты до продаж — [commercial-readiness](commercial-readiness.md); готовность и свидетельства — [release-gates](release-gates.md).

## Платежи и данные

- Подтверждать webhook подписью + provider server verification, unique event, idempotent outbox, reconciliation.
- При expiry/revoke запрещать сетевое право уже импортированных VPN профилей и персональных DNS токенов.
- Разделять бизнес-БД и Remnawave upstream схемы, отдельные роли, encrypted backup, тест восстановления.
- Данные минимизировать; срок хранения и условия обработки персональных данных/платежей проверить до публичной продажи.

## AI Operations security

- LLM: только **обезличенные метрики и логи**, без провайдерских ключей; ни root, ни произвольный terminal, ни командный канал.
- Executor: typed allowlisted runbooks, RBAC, lease/idempotency, cooldown, safe rollback, журнал каждого действия.
- Risk A3/A4: удаление/изменение старых VPS, firewall, ключи, деньги, провайдеры — только явное согласие владельца по утверждённой политике.
- Cloud spend hard cap и dry-run по умолчанию; неизвестная цена — deny. Special nodes default manual approval.
- В случае недоступности control plane / плохой телеметрии fail closed для действий, но не обязательно остановка VPN-трафика.

## Версии и лицензии

- Собственный код MNEBYVPN MIT, upstream лицензии независимы.
- Remnawave backend/Node/Panel/Subscription Page: проверить действующую AGPL-3.0 и обязанности при модификации/сетевом взаимодействии.
- CoreDNS Apache-2.0, nginx и зависимости — проверить notices и версии.
- Не копировать Aeternia код, графику, брендинг/закрытую реализацию.

Первоисточники: https://www.gnu.org/licenses/agpl-3.0.html ; https://github.com/coredns/coredns ; https://docs.rw/install/remnawave-node/ .

## Security vs performance / geo-exit — ADR-0006

- DoT шифрует DNS, а не произвольный трафик устройства. Для full-tunnel приватности требуются подтверждённые VPN маршруты, защита от DNS/IPv6 leaks и запрет скрытого direct fallback; TLS до origin не расшифровывать.
- При выборе скорости не отключать TLS verification и не превращать DoT в открытый DNS. Исключать ненужный двойной SNI ingress поверх VPN, измерять реальную задержку/пропускную способность.
- Зарубежный egress может изменить наблюдаемый сервисом IP/страну, но географический доступ не гарантирован; решает только трафик, действительно направленный через этот egress. Режим split-tunnel раскрывает прямые соединения.
- Для приватности: не хранить историю пользовательских доменов по умолчанию; только минимальные обезличенные агрегаты, bounded retention для технической диагностики после отдельного согласования. Проверять действия сторонних клиентов и приложений со своим DNS.
- Контракт и тесты: [ADR-0006](decisions/0006-private-dns-vpn-privacy-performance-egress.md). До успешного E2E — **UNVERIFIED**. Старые gates по paid SNI и per-flow quota сохраняются.
