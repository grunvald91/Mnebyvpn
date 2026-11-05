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

SQL миграция **не применялась к действующим VPS**. Позднее она успешно выполнена на временном PostgreSQL 17.6 в GitHub Actions; конкурентный нагрузочный тест ещё не выполнен. Нет платёжной интеграции, боевого worker/outbox executor, VPN/DNS adapters, сетевого тарификатора или реального ingress. `debit_smart_dns_quota` не ограничивает трафик сама по себе: каждый поток и его байты ещё нужно безопасно связать с подпиской; действующие долгие подключения требуют дополнительного enforcement. Платный Smart DNS/SNI и autoscaling **BLOCKED** до соответствующих acceptance gates.

## Следующие шаги по `docs/implementation-plan.md`

1. Preflight без изменений серверов: карта портов/SNI, ресурсы, offsite backup и восстановление, pinned version manifest.
2. PostgreSQL integration/contract tests (`debit_smart_dns_quota`: конкуренция, идемпотентность, refund) и транзакционный worker с reconcile/fencing.
3. Изолированный VPN pilot после разрешённых ресурсов и согласования портов; Smart DNS — отдельный тестовый стенд с проверкой ingress attribution.


**CI-проверка (05.11.2026):** [GitHub Actions run 42109968701](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701) — `success`: TypeScript typecheck, **25/25 unit-тестов**, миграции PostgreSQL 0001–0003 и SQL contract tests на disposable PostgreSQL 17.6. Это не тесты конкурентных клиентов, реального Prodamus/Telegram API, CoreDNS/SNI ingress или действующих VPS; эти gates **UNVERIFIED**.
