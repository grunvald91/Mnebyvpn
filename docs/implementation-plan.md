# План разработки MNEBYVPN v2

Статус задач: **[x] = оформлено в документах**, не означает код или реальное внедрение.

## A. Архитектура / review

- [x] Стек Xray + Remnawave, универсальные клиентские подписки.
- [x] Независимый MNEBYDNS: собственный DNS policy + выборочный SNI/TCP passthrough, без Aeternia.
- [x] AI Ops: мониторинг, alert, guarded runbooks, autoscaling с hard caps.
- [x] Контракты доменов/портов, DR, лицензионные границы, machine capacity.
- [x] Исправлены все 4 P0 и 5 P1 **в проекте**, без проверки на production.
- [ ] Решение владельца по ресурсам, выбранному домену и моменту установки.

## B. Preflight (пока без изменений сервера)

- [ ] Полная карта текущего nginx SNI, портов Xray/nginx/proxy/Docker, firewall; пересмотреть 8888/8787.
- [ ] Проверка SSH-безопасности и возможных старых аномалий.
- [ ] Offsite backup и подтверждённое тестовое восстановление.
- [ ] Проверить resize 188, стоимость/сохранение IP/data; подтвердить бюджет RAM/CPU.
- [ ] Подтвердить домен sub/api/panel/dns и TLS.
- [ ] Определить pinned версии backend/node/Xray/SDK/CoreDNS и сохранить manifest.

## C. VPN pilot без разрушения прокси

- [ ] Поднять тестовый Xray/REALITY профиль на обособленном порту/маршруте, не меняя действующие прокси.
- [ ] Доказать соединение минимум двух различных клиентов.
- [ ] Remnawave backend/Panel на 188 только после ресурсов; Node на 89 только с согласованием host-port.
- [ ] Импорт/update/revoke/expiry/failover в тесте.
- [ ] Проверить производительность и ресурсы при реальной нагрузке.

## D. Собственный Smart DNS pilot

- [ ] CoreDNS/DoH/DoT и policy store (одна-две разрешённые HTTPS цели); no open DNS.
- [ ] SNI TCP passthrough с allowlist и без MITM/SSRF; отдельный тестовый ingress.
- [ ] Реально протестировать iOS/Android подключение, HTTPS сертификат origin, TTL, DNSSEC, QUIC/ECH, IPv6.
- [ ] Токен/персональный DNS-профиль выдаётся и отзывается по entitlement.
- [ ] Отдельное решение по пользовательскому списку поддержанных сайтов; никаких общих гарантий.

## E. Billing / Telegram bot

- [ ] Один TypeScript service (bot + API + worker), PostgreSQL entitlement/order/outbox.
- [ ] Выбор провайдера СБП с подходящим статусом бизнеса, договор/тариф/API.
- [ ] Верифицированные webhook, двойные платежи, refund, конкурирующие операции.
- [ ] Отдельные VPN и SmartDNS adapters, bundle entitlement, revoke реальных ключей.

## F. Ops/AI

- [ ] Базовые probes (DNS/TCP/HTTPS/VPN) + Telegram alert + внешний независимый health source.
- [ ] Детерминированная оценка инцидентов и исполнение утверждённых low-risk runbooks.
- [ ] ИИ диагностика read-only по обезличенным телеметрическим данным, без root/provider credentials.
- [ ] Автоматизированный **dry-run** план создания VPS через API+IaC, выбранный провайдер.
- [ ] Тест budget hard cap, cooling, idempotency, тестовый canary Node, rollback, manual approval.
- [ ] Только после утверждения лимитов — ограниченный автоматический scale-out при доказанной перегрузке.

## G. Release acceptance

- [ ] Два совместимых iOS VPN клиента, два Android VPN клиента и Windows — end-to-end.
- [ ] Smart DNS протестирован отдельно на выбранных устройствах и разрешённых сайтах.
- [ ] Платёж+доступ+revoke/renew/refund под тестом.
- [ ] Backup/restore, DNS failure, panel failure, ingress failure и load test.
- [ ] Нет регрессии работающих Telegram-прокси.
- [ ] Неподтверждённая работа в ограниченных операторских сетях не рекламируется как доступная.

GitHub Actions для документации не нужны. Без отдельного разрешения владельца на VPS не запускать изменяющие команды.

## H. Дополнительные release gates по ревью (2026-11-05)

- [ ] `P1-DNS-AUTH`: direct-IP + valid SNI НЕ даёт неоплаченному/отозванному клиенту проксироваться — **BLOCKS PAID SNI**. [Контракт](smart-dns-access-gate.md).
- [ ] `P1-ORDER`: delayed ENABLE не активирует учётную запись после refund/revoke (включая истёкший lease/fencing). [Контракт](provisioning-ordering.md).
- [ ] `P1-LOAD`: замерено фактическое снижение перегрузки после добавления Node, не только появление в подписках. [Контракт](scale-out-contract.md).
- [ ] `P1-BUDGET`: конкурентные резервирования и provider `UnknownOutcome` не превышают hard cap и не создают дубликаты. [Контракт](scale-out-contract.md).
- [ ] `P1-OFFLINE`: expiry/revoke протестированы при разрыве Panel↔Node и измерено max stale window. [Контракт](offline-expiry.md).
- [ ] `P1-RR`: проверена политика A/AAAA/CNAME/HTTPS/SVCB/DNSSEC на реальных клиентах. [Контракт](dns-record-policy.md).

**Чек-боксы остаются пустыми, пока нет кода и испытаний.** Документация сама по себе не подтверждает отсутствие архитектурных рисков.

## I. Новое бизнес-решение: общая квота MNEBYDNS

- [x] В спецификации: одна подписка → один общий пакет, **любое количество устройств**, без HWID.
- [ ] Проверить доступность отдельного destination IPv6 на подписку либо другой проверенный ingress quota key.
- [ ] Два-три устройства одной подписки расходуют один счетчик, после исчерпания все блокируются независимо от кэша DNS.
- [ ] Проверить точность live accounting, overshoot, активные соединения, конкуренцию на нескольких ingress.
- [ ] Проверить риски передачи bearer IP, IPv4-only сети и механизм revoke.

До испытаний нельзя продавать гарантированную квоту гигабайт HTTPS/SNI прокси. См. [ADR-0005](decisions/0005-shared-dns-quota.md).

## J. Кодовый фундамент — первая реализация (2026-11-05)

- [x] Чистая TypeScript-модель прав/сроков/ревизий и общей квоты с 6 локально пройденными тестами.
- [x] Подготовлена SQL-миграция бизнес-таблиц, outbox/fencing и атомарного учёта DNS-квоты (**не применялась к PostgreSQL**).
- [x] Поднят локальный диагностический HTTP endpoint; readiness остаётся 503 до проверки сетевого исполнения.
- [ ] Integration тесты на настоящем PostgreSQL, транзакционный worker с CAS/fencing, провайдер платежей и adapters.
- [ ] Direct-IP/SNI ingress attribution и on-wire quota enforcement — **BLOCKED**, до отдельного end-to-end PoC.

Подробности: [phase1-status](phase1-status.md). Код в feature branch, без вмешательства в действующие VPS.

## K. Этап 2 — разработка без серверов (2026-11-05)

- [x] Миграция 0002: уникальный capture, доверенная обработка платежа/возврата, атомарный bundle и outbox.
- [x] Функции PostgreSQL для expiry sweep, fencing и CAS подтверждения наблюдаемого результата (SQL прошёл контрактный тест на disposable PostgreSQL 17.6).
- [x] Независимый TypeScript reconciler всегда читает текущее desired state, а не исполняет старый ENABLE из очереди; 8/8 локальных тестов и проверка TypeScript без ошибок.
- [x] Подготовлен SQL contract test для повторного webhook, дублирования capture, bundle, refund и устаревшего ack (успешно запускался в GitHub Actions на PostgreSQL 17.6).
- [ ] Подключить disposable PostgreSQL в тестовой среде, выполнить обе миграции и конкурентные SQL тесты.
- [ ] Реализовать PostgreSQL storage + межпроцессный exclusive lock и production worker; сейчас только интерфейсы, алгоритм и SQL primitives.
- [ ] Реализовать независимую проверку подписи и статуса у выбранного СБП-провайдера.
- [ ] Интеграционные тесты изолированных Remnawave и Smart DNS адаптеров; платный ingress закрыт до on-wire авторизации/квоты.

**По решению владельца:** весь VPS preflight, карты портов, серверные бэкапы, установка, DNS/TLS и операции на действующих узлах откладываются. Разработка кода и локальных тестов продолжается. [Статус этапа 2](phase2-status.md).

## L. Этап 3 — выбранные владельцем методы оплаты

- [x] Определены **оба** провайдера: Продамус и Telegram Stars. Никаких альтернативных платёжных провайдеров не выбираем.
- [x] TypeScript: собственная валидируемая схема тарифов с отдельными ценами RUB minor / XTR; криптографический order payload, подготовка invoice/pre-checkout/successful_payment для Stars.
- [x] TypeScript: подпись запроса и проверка Sign webhook Продамус, сверка суммы, order_num, transaction ID, домена и статуса.
- [x] Подготовлены модульные тесты на подмену суммы, подписи, заказа, дубль и позднее successful_payment (**не запускались в данной итерации**).
- [ ] Проверить signature against Prodamus merchant/test vectors и настоящий sandbox; создать обработчики multipart/form-data + Telegram authenticated updates, не подключены.
- [ ] Подключить реальный DB repository и атомарные SQL функции 0002; одних валидаторов недостаточно.
- [ ] Реализовать независимый канал refund и безопасное хранение платёжных credentials.

Весь этап ограничен исходным кодом и тестами. Никакого запуска VPS, API-платежей или боевых запросов.

## M. Исправления 5 замечаний review (2026-11-05)

- [x] Код Prodamus/SQL: отдельная signed delivery и identity capture; hash уведомления с изменяемым `attempt` не используется для идентификации повторной оплаты; тесты повторной доставки проверены контрактными SQL тестами.
- [x] Политика IPv6: **запрещено переиспользование** между подписками навсегда; in-memory policy registry + SQL uniqueness-требование (не сеть).
- [x] Политика DNS cache: upstream cache перед персонализацией; персональные ответы никогда в shared cache; TypeScript model/tests для двух подписок.
- [x] Модель: каждый оплаченный пакет — независимый entitlement и network credential; отдельный refund, единица lock — entitlement_id. Автопополнение старого пакета отложено.
- [x] Отрицательные тесты: больше нет требования идентифицировать «третье лицо», bearer-квота может быть передана; при inactive quota/IP — deny.
- [x] PostgreSQL 0001–0003 migrations и SQL contract tests + 25 TypeScript unit-тестов — CI PASS ([run](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701)).
- [ ] Concurrency/partition, настоящий Prodamus/Telegram transport, реальный CoreDNS/ingress — **UNVERIFIED**; release gates остаются закрыты.

См. [review fixes](review-20261105-followup.md).


**CI-проверка (05.11.2026):** [GitHub Actions run 42109968701](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701) — `success`: TypeScript typecheck, **25/25 unit-тестов**, миграции PostgreSQL 0001–0003 и SQL contract tests на disposable PostgreSQL 17.6. Это не тесты конкурентных клиентов, реального Prodamus/Telegram API, CoreDNS/SNI ingress или действующих VPS; эти gates **UNVERIFIED**.
