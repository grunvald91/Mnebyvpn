# Мне бы VPN — MNEBYVPN

**Статус на 2026-11-05: архитектура v2 и первая версия бизнес-домена, SQL-схемы и локальной диагностики. Реальный VPN/DNS, платежи и сетевое применение квот ещё НЕ реализованы и НЕ развёрнуты.**

Независимая платформа подключения к интернету с **двумя способами**:
1. **VPN**: сторонние совместимые приложения (Happ, INCY, OneXray, Karing, v2rayNG и др. только по результатам теста), серверы Xray-core под управлением Remnawave.
2. **MNEBYDNS / Smart DNS**: разрабатываем **собственный** DNS + выборочный SNI/TCP-прокси. Это **не интеграция с Aeternia** и не копирование его закрытого кода. Настройка DoH/DoT и HTTPS-маршрутов рассматривается как отдельный клиентский путь. Не путать DNS с полнофункциональным VPN.

Общие для обоих способов: аккаунт, право доступа, платежи, поддержка, каталог узлов и наблюдаемость. VPN и Smart DNS — **разные data planes и разные системы выдачи конфигураций**.

**Управление сетью:** детерминированный мониторинг, ограниченные автоматические действия восстановления, ИИ-агент для диагностики и рекомендаций, будущий autoscaling по явным проверяемым метрикам и бюджетным ограничениям. Никакого свободного root-доступа у ИИ и бесконтрольных покупок VPS.

**Старт без третьего VPS.** Российский 188 — кандидат на control plane только после улучшения ресурсов; зарубежный 89 — кандидат на VPN/data plane после изолированного теста. Не очищать и не менять действующие прокси без отдельного разрешения и проверенного восстановления.

## Документы

- [Общая архитектура и схемы](docs/architecture.md)
- [Компоненты и исходные репозитории](docs/components.md)
- [Собственный Smart DNS / SNI-прокси](docs/smart-dns.md)
- [Мониторинг, ИИ-оператор и автомасштабирование](docs/operations-automation.md)
- [Размещение, ресурсы и порты](docs/infrastructure.md)
- [Контракты развёртывания и адресов](docs/deployment-contract.md)
- [Модель оплаты и предоставления доступа](docs/billing-lifecycle.md)
- [Деградации, аварии, восстановление](docs/disaster-recovery.md)
- [Матрица проверки клиентских приложений](docs/client-compatibility.md)
- [Миграция без повреждения Telegram-прокси](docs/migration-runbook.md)
- [Безопасность и лицензии](docs/security.md)
- [Особые узлы / ограниченные сети](docs/special-nodes.md)
- [Этапы и приёмка](docs/implementation-plan.md)
- [Начало реализации: фундамент и незакрытые проверки](docs/phase1-status.md)
- [Этап 2: биллинг и сверка прав без VPS](docs/phase2-status.md)
- [Этап 3: платёжные адаптеры Продамус + Telegram Stars](docs/phase3-payments.md)
- [Этап 4: PostgreSQL-заказы, webhook и Telegram 10.3 Rich Messages](docs/phase4-payment-handlers.md)
- [Итоги ревью и исправления P0/P1](docs/review-remediation.md)
- [ADR-0001: Универсальные клиенты](docs/decisions/0001-universal-client-architecture.md)
- [ADR-0002: Два VPS](docs/decisions/0002-two-vps-special-nodes.md)
- [ADR-0003: Независимый Smart DNS](docs/decisions/0003-independent-smart-dns.md)
- [ADR-0004: ИИ-автоматика с ограниченными полномочиями](docs/decisions/0004-guarded-ai-operations.md)
- [ADR-0006: Совместимость Private DNS + VPN, приватность, скорость, зарубежный выход](docs/decisions/0006-private-dns-vpn-privacy-performance-egress.md)

## Проверенные upstream и технические ограничения

- Remnawave backend: https://github.com/remnawave/backend ; Node: https://github.com/remnawave/node ; требования: https://docs.rw/install/requirements/
- Remnawave шаблоны: https://docs.rw/learn-en/templates/ ; rules: https://docs.rw/learn-en/routing-rules/
- DNS: https://github.com/coredns/coredns ; SNI passthrough: https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html
- Измерения двух VPS (05.11.2026): https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42045124823 и https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42048759983

**Документация — не подтверждение работающего продукта.** Ни серверы, ни DNS, ни автоскейлер в этом коммите не изменялись.

## Ревью шести дополнительных архитектурных рисков (2026-11-05)

**Это не закрытые баги в коде; реализация ещё не началась.** [Отчёт по 6 рискам](docs/review-20261105-six-gaps.md). Ключевые контракты: [авторизация SNI](docs/smart-dns-access-gate.md), [очередность прав](docs/provisioning-ordering.md), [scale-out + денежный учёт](docs/scale-out-contract.md), [offline expiry VPN](docs/offline-expiry.md), [DNS RR policy](docs/dns-record-policy.md). **Paid Smart DNS/SNI и платный autoscaling — BLOCKED, пока нет прохождения тестов.**

## Тариф MNEBYDNS: общая квота

Одна подписка = один оплаченный пакет байтов на **любом количестве устройств** (можно пользоваться совместно). Ограничение выполняется на SNI ingress по суммарному трафику, не по числу DNS-запросов. Техническая привязка потока к пакету пока не испытана: [ADR-0005](docs/decisions/0005-shared-dns-quota.md).


**Review update:** см. [исправления 5 замечаний](docs/review-20261105-followup.md). Продамус и Telegram Stars сохранены как два выбранных владельцем канала оплаты; сеть и VPS не менялись.


**CI-проверка (05.11.2026):** [GitHub Actions run 42109968701](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701) — `success`: TypeScript typecheck, **25/25 unit-тестов**, миграции PostgreSQL 0001–0003 и SQL contract tests на disposable PostgreSQL 17.6. Это не тесты конкурентных клиентов, реального Prodamus/Telegram API, CoreDNS/SNI ingress или действующих VPS; эти gates **UNVERIFIED**.

- [Этап 5: подтверждённые возвраты, PostgreSQL outbox worker и HTMLBubble-модель](docs/phase5-refunds-outbox-bubbles.md)

- [Telegram Bot API 10.4: HTMLBubbles MNEBYVPN](docs/phase6-telegram-widgets.md)

- [Ревью кода HTMLBubbles и реферальных покупок](docs/review-referrals-20261106.md)
- [Этап 7: пересылаемые реферальные HTMLBubbles](docs/phase7-referral-bubbles.md)

- [Этап 8: кнопки, сроки тарифов и пробные 24 часа](docs/phase8-buttons-tariffs-trial.md)

- [Этап 9: активация trial, поздние платежи и ревью](docs/phase9-completion-and-review.md)

## Одновременная работа VPN + Smart DNS (решение 06.11.2026)

Целевое поведение: на Android системный **Private DNS (DoT)** настраивается один раз; включение/выключение **нашего VPN** не должно требовать ручной перенастройки DNS **на подтверждённых сочетаниях ОС/клиентов**. Одно физическое размещение DNS и VPN не гарантирует такую совместимость. Сбалансировать: приватность, отсутствие DNS/IP утечек, скорость без двойного проксирования и выбор зарубежного egress там, где сервис ограничивает доступ по стране IP. **Private DNS сам не скрывает IP/страну и не шифрует всё интернет-соединение.** Не обещать гарантированного обхода геоограничений, всегда проводить E2E-тесты. Реализация: **UNVERIFIED**. [Полный контракт](docs/decisions/0006-private-dns-vpn-privacy-performance-egress.md).
