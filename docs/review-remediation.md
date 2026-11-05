# Исправления по архитектурному ревью — 2026-11-05

**Статус:** исправлена **проектная документация**; ни один пункт НЕ считается проверенным на реальных VPS или клиентских устройствах.

| Issue | Было | Исправлено / где | Осталось доказать |
|---|---|---|---|
| P0-1 портовые конфликты host network | «изолированный Node» без полной карты | deployment-contract, migration-runbook: `network_mode: host`, отдельный test port, запрет захвата 443 | live stream/SNI mapping и пилот |
| P0-2 ресурсы панели | предположение о resize | infrastructure: hard gate 2 vCPU/2 GB/20 GB минимум, capacity budget, вариант отказа | хостер и тариф, проверка ресурса после resize |
| P0-3 адрес подписки | неразделённый endpoint | deployment-contract: sub/api/panel/dns/connect/ops логические имена, TLS, DNS TTL | регистрация домена и тест TLS |
| P0-4 DR | общая фраза о бэкапах | disaster-recovery: таблица failure modes, RPO/RTO не заявлены | offsite backup + restore test |
| P1-1 установочные repos | не указан backend и SDK | components: `remnawave/backend`, `@remnawave/backend-contract` | pinned upstream matrix |
| P1-2 тяжёлый коммерческий слой | лишние отдельные app сервисы | architecture/components: один TypeScript API+bot+worker, без отдельного брокера | нагрузочный замер |
| P1-3 жизненный цикл | нет state machine/refund | billing-lifecycle: состояния, refund, idempotent outbox, reconciliation | contract/integration tests |
| P1-4 клиентские испытания | только импорт и подключение | client-compatibility: IPv6/DNS/UDP/network switch/ECH/DoH | реальные iOS/Android/Windows тесты |
| P1-5 операционная безопасность | generic security | security/deployment-contract: open proxy, SSH host verification, node control port ACL | audit доступа извне, ключи и firewall |
| NEW Smart DNS | не было независимого режима | smart-dns.md и ADR-0003: свой CoreDNS + TLS SNI passthrough | PoC для отдельных разрешённых доменов |
| NEW ИИ ops/autoscale | не было контроля сети | operations-automation.md и ADR-0004: policy + guarded controller + cloud provisioner | реальный провайдер, бюджет, метрики, runbooks |

Ссылки на официальные документы: https://docs.rw/install/remnawave-panel/ , https://docs.rw/install/remnawave-node/ , https://docs.rw/sdk/typescript-sdk/ , https://www.rfc-editor.org/rfc/rfc6066.html .
