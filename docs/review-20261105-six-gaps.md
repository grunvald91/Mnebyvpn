# Ревью v2: шесть незакрытых инвариантов

Дата: 2026-11-05. Это **архитектурные уточнения, не протестированные исправления сервиса**.

| ID | Замечание | Архитектурный ответ | Выпуск платного продукта |
|---|---|---|---|
| P1-DNS-AUTH | DoH token не авторизует TCP ingress | [smart-dns-access-gate](smart-dns-access-gate.md): proxy-side authentication, direct-IP bypass/revoke tests, сравнение вариантов | **BLOCKED до выбора и испытания** |
| P1-ORDER | Поздняя выдача может переписать отзыв | [provisioning-ordering](provisioning-ordering.md): desired revision, fencing, per-key serialization, reconcile, late result | Требует E2E race tests |
| P1-LOAD | Новый узел не означает перераспределение старых клиентов | [scale-out-contract](scale-out-contract.md): new user placement, tested client update/migration, load-relief metrics | Autoscaling disabled |
| P1-BUDGET | Race при резервировании денег и UnknownOutcome после create | [scale-out-contract](scale-out-contract.md): serializable budget reservations, provider inventory reconciliation | Autoscaling disabled |
| P1-OFFLINE | Не доказано автономное expiry при потере Panel | [offline-expiry](offline-expiry.md): stale entitlement contract, partition tests and alternative local enforcement | **BLOCKED до test** |
| P1-RR | A rewrite без AAAA/HTTPS/SVCB согласованности | [dns-record-policy](dns-record-policy.md): per-domain RR matrix, fail-safe exclusion | Smart route disabled до PoC |

## Архитектурный принцип

Выполнено лишь **документирование требований**. Ни один P1 не закрыт кодом или измерением. Для Smart DNS коммерческий тариф с доступом через прозрачный SNI-proxy запрещён, пока не выбран независимый от DoH способ TCP client auth. Для VPN обязательна проверка expiry при изоляции панели. Не создавать платные узлы и не включать автономные destructive operations.

Первоисточники: https://www.rfc-editor.org/rfc/rfc9460.html ; https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html ; https://coredns.io/plugins/rewrite/ ; https://github.com/remnawave/node .
