# Security review — MNEBYVPN VPN / MNEBYDNS / Ops

## Публичный репозиторий

Никаких рабочих API keys, SSH passwords/keys, subscription URLs/QR, TLS/WireGuard/Xray private keys, токенов DoH, raw logs, .env или cloud provider state в git. `grunvald91/telegram-proxy-infra` стал публичным; отдельно проверить историю коммитов и sanitzed backups на утечку, в случае раскрытия секретов — rotation по согласованному плану. **Не публиковать** клиентские IP и историю DNS.

## Доступ к сетевым интерфейсам

- Panel UI/API — закрытый admin/management segment, защищённая аутентификация, RBAC, audit.
- Remnawave Node control port — только от Panel IP, по официальным требованиям https://docs.rw/install/remnawave-node/ . Не привязывать к публичному 443.
- Root SSH только на время администрирования, по возможности ключи и pinned host keys, no `StrictHostKeyChecking=no`; least privilege.
- Firewall открывать только по утверждённой карте портов. Прослушивание TCP 8888/8787 на ru-edge требует реальной проверки авторизации/достижимости, не считать открытым прокси без теста.
- DoH/DoT protected resolver: доступ только с проверенным entitlement и ограничения запросов, либо отдельно утверждённая abuse policy. Иначе становится публичным open resolver.
- SNI ingress: explicit allowlist, нет универсального proxy target, блок private/localhost/metadata, DNS rebinding, target whitelist pinning, лимиты соединений/полосы. **No TLS interception / root CA**.
- Помнить о built-in DoH в приложениях, DNSSEC, ECH, QUIC. DNS-режим не объявлять полноценной защитой приватности/VPN.

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
