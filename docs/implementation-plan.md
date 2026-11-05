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
