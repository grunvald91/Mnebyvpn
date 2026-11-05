# Мне бы VPN — MNEBYVPN

**Статус на 2026-11-05: архитектурная спецификация v2; код сервиса, DNS-узлы и автоматизация ещё не развёрнуты.**

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
- [Итоги ревью и исправления P0/P1](docs/review-remediation.md)
- [ADR-0001: Универсальные клиенты](docs/decisions/0001-universal-client-architecture.md)
- [ADR-0002: Два VPS](docs/decisions/0002-two-vps-special-nodes.md)
- [ADR-0003: Независимый Smart DNS](docs/decisions/0003-independent-smart-dns.md)
- [ADR-0004: ИИ-автоматика с ограниченными полномочиями](docs/decisions/0004-guarded-ai-operations.md)

## Проверенные upstream и технические ограничения

- Remnawave backend: https://github.com/remnawave/backend ; Node: https://github.com/remnawave/node ; требования: https://docs.rw/install/requirements/
- Remnawave шаблоны: https://docs.rw/learn-en/templates/ ; rules: https://docs.rw/learn-en/routing-rules/
- DNS: https://github.com/coredns/coredns ; SNI passthrough: https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html
- Измерения двух VPS (05.11.2026): https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42045124823 и https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42048759983

**Документация — не подтверждение работающего продукта.** Ни серверы, ни DNS, ни автоскейлер в этом коммите не изменялись.

## Ревью шести дополнительных архитектурных рисков (2026-11-05)

**Это не закрытые баги в коде; реализация ещё не началась.** [Отчёт по 6 рискам](docs/review-20261105-six-gaps.md). Ключевые контракты: [авторизация SNI](docs/smart-dns-access-gate.md), [очередность прав](docs/provisioning-ordering.md), [scale-out + денежный учёт](docs/scale-out-contract.md), [offline expiry VPN](docs/offline-expiry.md), [DNS RR policy](docs/dns-record-policy.md). **Paid Smart DNS/SNI и платный autoscaling — BLOCKED, пока нет прохождения тестов.**
