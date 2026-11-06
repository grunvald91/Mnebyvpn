# Runbook — безопасная миграция двух действующих прокси-VPS

**Статус: ничего не выполнялось на production.** Никаких очисток, остановок, замен и переустановок без отдельного явного согласия владельца.

## STOP

До Gates 0–2 запрещены `rm -rf`, reset Docker, замена ОС, изменение nginx :443, любых действующих systemd/proxy служб, firewall, DNS, SSH и ключей. Исторический git snapshot **не равен** проверенной резервной копии живого состояния.

## Gate 0 — read-only

- Свежая **приватная** карта адресов, портов, локальных upstream, SNI, Docker host/bridge, nft/iptables и защита SSH.
- Отдельная проверка всех нестандартных публичных listeners, роли и аутентификации; протокол и результаты не публиковать.
- Фактическое потребление RAM/disk/CPU при пиках; GPU для ИИ локально не нужен, ИИ-критик может быть удалённым.
- Проверить ресурсы **после уже заявленного владельцем resize** и актуальное состояние IP/диска/сервисов; не полагаться на старый audit. 
- Документировать источники сертификатов и DNS (без секрета).

## Gate 1 — защищённый backup и откат

- Актуальные зашифрованные offsite резервные копии **обоих** серверов, конфигураций, service units, БД и данных, ключей/сертификатов; только в закрытом хранилище.
- В тестовой среде проверить восстановление и контрольные суммы.
- Проверить резервный SSH путь и доступ к панели VPS.
- Перечислить ожидаемые процессы, порты, маршруты и базовую работоспособность Telegram-прокси для post-check.

## Gate 2 — архитектурный preflight

- Ресурсы Panel соответствуют https://docs.rw/install/requirements/ .
- Утверждены конкретные домены, DNS/TLS, маршруты Node control API, список портов, конфигурация монитора и rollback.
- Remnawave Node `network_mode: host`: отдельные тестовые порты, **нет конфликтов занятых адресов/портов**. Не вытеснять существующий Xray.
- Smart DNS PoC на **изолированном** тестовом IP/порту; никаких публичных DNS rewrite или open proxy до проверки.
- Версии официальных backend/node/SDK/Xray/CoreDNS/nginx закреплены и протестированы.
- Отдельное разрешение владельца на изменяющие команды.

## Gate 3 — staged VPN

- После разрешения: backend+Panel (только на одобренном control-plane узле после свежего capacity check), DB/Redis, HTTPS subscription, защищённый admin API.
- Remnawave Node на согласованном data-plane узле в параллельном isolated pilot; тесты Xray конфигурации, импорт 2 разных приложений, expiry/revoke.
- Проверка existing proxy services, SNI routing, ресурсы, действующих сервисов **до и после**.

## Этап 4 — свой MNEBYDNS PoC (DEFERRED, не коммерческий gate MVP)

- DNS engine, DoH/DoT frontend, policy/ACL, один-два разрешённых тестовых сайта, strict SNI passthrough без MITM.
- Тесты DNSSEC/ECH/QUIC/IPv6/cache/built-in DNS, запрет неизвестных SNI/private-IP, per-user access и revoke.
- Только после отдельной проверки включать DNS-профили в пользовательский интерфейс.

## Этап 5 — commercial (после всех P0) + guarded ops (позже)

- TypeScript bot + backend, платежи, первый entitlement `vpn`, outbox, reconciliation, refunds, web self-service. Smart DNS entitlement остаётся неактивным коммерчески.
- Сначала **только наблюдение** и алерты; A1/A2 self-heal после dry-run и ручной приёмки.
- Auto-provision VPS только после выбора провайдера/API, тестов IaC, hard budgets и отдельного разрешения. Дорогие special узлы по умолчанию только manual.
- Canary users/протоколы, контроль отсутствия деградации существующих прокси.

## При любой регрессии

Остановить расширение и опасные действия; восстановить предыдущую конфигурацию/образы по проверенному rollback и убедиться в работе старых прокси. Не удалять старые компоненты до **отдельного** решения decommission. Документировать incident, метрики до/после, backup ID.

См. [deployment-contract](deployment-contract.md), [disaster-recovery](disaster-recovery.md), [special-nodes](special-nodes.md).
