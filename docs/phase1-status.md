# Этап 1 — фундамент MNEBYVPN (2026-11-05)

Ветка реализации: `feat/phase1-foundation-20261105`. Только код в Git; серверы 89 и 188, DNS, nginx, proxy и Remnawave **не затрагивались**.

Создано:
- `packages/domain/src/entitlement.ts`: типы прав, проверка срока и статуса, защита от устаревшего acknowledgement provisioning, модель общей квоты без HWID/лимита устройств.
- `db/migrations/0001_initial.sql`: первичная бизнес-схема PostgreSQL (отдельно от Remnawave), уникальность verified payment events, fencing/reconcile schema, атомарная функция списания общей DNS-квоты с row lock и уникальным usage-event ID.
- `apps/service/src/server.ts`: только локальные `/healthz` и `/readyz`. `/readyz` намеренно возвращает 503, боевые endpoints отсутствуют.
- `tests/entitlement.test.ts`: проверки статусов, устаревшей ревизии, expiry, единой квоты и отказов.

## Как проверить локально

Нужен Node.js 22.16+:

```sh
npm test
npm run start:diagnostics
# отдельный терминал: curl http://127.0.0.1:8789/healthz
# readiness намеренно 503: curl -i http://127.0.0.1:8789/readyz
```

SQL миграция **не применялась**, полноценный тест на PostgreSQL и конкурентный нагрузочный тест ещё не выполнены. Нет платёжной интеграции, боевого worker/outbox executor, VPN/DNS adapters, сетевого тарификатора или реального ingress. `debit_smart_dns_quota` не ограничивает трафик сама по себе: каждый поток и его байты ещё нужно безопасно связать с подпиской; действующие долгие подключения требуют дополнительного enforcement. Платный Smart DNS/SNI и autoscaling **BLOCKED** до соответствующих acceptance gates.

## Следующие шаги по `docs/implementation-plan.md`

1. Preflight без изменений серверов: карта портов/SNI, ресурсы, offsite backup и восстановление, pinned version manifest.
2. PostgreSQL integration/contract tests (`debit_smart_dns_quota`: конкуренция, идемпотентность, refund) и транзакционный worker с reconcile/fencing.
3. Изолированный VPN pilot после разрешённых ресурсов и согласования портов; Smart DNS — отдельный тестовый стенд с проверкой ingress attribution.
