# Выбранные исходники и границы — ревизия 2026-11-05

| Функция | Исходник | Роль | Лицензия/статус |
|---|---|---|---|
| Xray VPN engine | https://github.com/XTLS/Xray-core | data plane через управляемый node | Лицензию и релиз проверить перед pin |
| Remnawave production backend / Compose | https://github.com/remnawave/backend | **основной источник установки панели** | AGPL: проверить обязательства |
| Remnawave web/admin | https://github.com/remnawave/panel | UI / документация | AGPL: проверить обязательства |
| Remnawave Node | https://github.com/remnawave/node | содержит Xray, часто `network_mode: host` | AGPL: проверить обязательства |
| Remnawave Templates / Response Rules | https://docs.rw/learn-en/templates/ , https://docs.rw/learn-en/routing-rules/ | часть backend, не отдельная бизнес-БД | встроено в Remnawave |
| Remnawave SDK contracts | https://docs.rw/sdk/typescript-sdk/ | `@remnawave/backend-contract`, **не HTTP-клиент**, pin по версии backend | проверить версию/лицензию |
| Subscription Page | https://github.com/remnawave/subscription-page | опционально, браузерная страница | проверить лицензию и цену ресурсов |
| Telegram-бот | https://github.com/grammyjs/grammY | собственный интерфейс, TypeScript | MIT, проверить релиз |
| Бизнес-БД | https://www.postgresql.org | entitlement, orders, outbox; логически отдельно от upstream | отдельные учётные записи |
| DNS resolver (самостоятельный продукт) | https://github.com/coredns/coredns | DNS policy / upstream / cache, программные правила | Apache-2.0 |
| Альтернативный DNS resolver (только если нужен) | https://github.com/AdguardTeam/AdGuardHome | DNS rewrite / DoH/DoT; не устанавливать оба по умолчанию | оценить AGPL |
| SNI L4 proxy | https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html | разрешённые TCP TLS имена, passthrough | nginx module |
| Мониторинг | https://github.com/prometheus/blackbox_exporter | DNS/TCP/HTTPS измерения, по мере ресурсов | OSS |
| Оповещения | https://github.com/prometheus/alertmanager | dedupe и отправка сигналов; возможен более лёгкий MVP | OSS |
| VPS IaC (позже) | https://opentofu.org/docs/ | provider adapters / планирование и создание узлов | не разворачивать пока нет провайдера/API |
| ИИ-критик | MNEBYVPN собственный модуль | диагностические выводы, предлагаемые действия | нет стороннего облачного доступа к root |

Не копируем код Aeternia и не подключаем её API. Это **собственная независимая реализация** похожего класса функциональности.

## Планируемый код (не создан)

```text
apps/
  service/              # один лёгкий TypeScript HTTP API + Telegram bot + worker
packages/
  domain/               # entitlement, состояния, policy
  billing/              # платёжный адаптер и проверка webhook
  remnawave-adapter/     # официальный API с contract pin
  dns-policy/            # политика DNS, правила SNI, ACL, аудит
  operations/            # измерения/аварии/runbooks/guardrails
  provisioners/          # provider interfaces; cloud API только после выбора
infra/
  remnawave/            # отдельный upstream deployment, pinned images
  dns/                  # resolver/DoH/TCP ingress; тест без захвата :443
  observability/        # маленькие probes и алерты
  provisioning/         # IaC после утверждения провайдера
tests/
  contract/
  integration/
  e2e/
```

Избегаем лишних контейнеров на 1-vCPU/1-GB сервере: нет микросервисов/очередного отдельного брокера без необходимости. **У Remnawave свои PostgreSQL и Redis требования**; бизнес-схему можно держать в том же *экземпляре* PostgreSQL только после совместимости, но в отдельной БД/ролях, без записи в upstream таблицы.

## Pin и лицензии

В production только версии/tag/sha/OCI digest, совместимые backend/node/SDK/Xray. Нельзя `latest` в deployment. OpenTofu state и ключи провайдеров — секреты. Внесение сторонних библиотек возможно только после проверки лицензий.

Источники: https://docs.rw/install/remnawave-panel/ , https://docs.rw/install/remnawave-node/ , https://docs.rw/sdk/typescript-sdk/ .
