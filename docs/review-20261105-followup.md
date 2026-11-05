# MNEBYVPN: follow-up review — 5 замечаний (2026-11-05)

| # | Внесено | Что остаётся неверифицированным |
|---|---|---|
| P1 Prodamus redelivery | Валидатор подписанного PAID/REFUNDED события, повтор по capture+заказ+сумма+валюта, delivery hash/attempt отдельно, SQL + TypeScript тесты | Конкурентная PostgreSQL integration, подписанные эталонные test-векторы и настоящий Prodamus webhook |
| P1 IPv6 reuse | Пожизненный permanent tombstone, never-reissue policy на уровне адресного реестра; отдельная SQL таблица claims | IPv6 префикс, ingress enforcement, управление кадровыми IP и маршрутами |
| P1 DNS cache | Общий кеш только до персонализации; персональный AAAA response с no-store; 2 параллельные подписки → разные IP в unit-модели | CoreDNS/DoH pipeline, кеширование клиента, A/AAAA/CNAME/HTTPS/SVCB/DNSSEC E2E |
| P1 единица доступа | Каждый order+product создаёт **отдельный entitlement** с независимой ревизией и ключом; refund одного заказа не касается другого, worker lock по entitlement | реальные provisioning adapters и выдача отдельного сетевого ключа каждой покупке |
| P2 чужой пользователь | Описана transferable bearer-модель без HWID/source-IP user identification; deny по состоянию пакета/квоты/невыданному IPv6 | реальный SNI proxy/connection enforcement |

**Главное:** эти изменения не подтверждают коммерческую готовность VPN/Smart DNS. Нет настоящих сетевых тестов и полноценного worker. Код/документация внесены только в feature branch без работы с VPS.

Источники: https://help.prodamus.ru/payform/uvedomleniya/kak-ustroena-otpravka-uvedomlenii-ob-oplate ; https://coredns.io/plugins/cache/ ; https://github.com/grunvald91/Mnebyvpn/blob/main/docs/decisions/0005-shared-dns-quota.md .


**CI-проверка (05.11.2026):** [GitHub Actions run 42109968701](https://github.com/grunvald91/Mnebyvpn/actions/runs/42109968701) — `success`: TypeScript typecheck, **25/25 unit-тестов**, миграции PostgreSQL 0001–0003 и SQL contract tests на disposable PostgreSQL 17.6. Это не тесты конкурентных клиентов, реального Prodamus/Telegram API, CoreDNS/SNI ingress или действующих VPS; эти gates **UNVERIFIED**.
