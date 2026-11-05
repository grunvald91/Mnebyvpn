# Два существующих VPS — размещение MNEBYVPN и MNEBYDNS

**План без новых серверов. Ничего не установлено.**

## Фактические read-only ресурсы на 05.11.2026

| Метрика | Российский edge 188 | Зарубежный exit 89 |
|---|---:|---:|
| CPU | 1 vCPU | 1 vCPU |
| RAM total | 956 MiB | 1.9 GiB |
| RAM available | 281 MiB | 1.2 GiB |
| Swap used | 768 MiB | 126 MiB |
| Disk total/free | 15 GB / 4.8 GB | 15 GB / 4.1 GB |
| Существенные сервисы | nginx, Telemt, tinyproxy, redsocks, Docker, WireGuard | nginx, Xray, MTG/Telemt, WireGuard |
| Состояние | работающий proxy edge | работающий proxy exit |

Первоисточники: [RU Audit](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42048759983) и [Foreign Audit](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42045124823).

Официальные минимальные требования Remnawave Panel: 2 vCPU, 2 GB RAM, 20 GB storage; рекомендовано 4 vCPU и 4 GB RAM. Node: 1 GB RAM, 1 CPU (потребление Xray зависит от нагрузки): https://docs.rw/install/requirements/ . **Ни один имеющийся VPS не соответствует всем требованиям Panel.**

## Целевое размещение после отдельного решения владельца

| Компонент | Потенциальное место | Условие |
|---|---|---|
| Remnawave backend+DB+Redis / subscription | 188 | Только после resize и preflight безопасности/портов |
| MNEBYVPN TypeScript API + Telegram bot + outbox | 188 | Компактный процесс/контейнер, отдельные права доступа |
| Xray via Remnawave Node | 89 | Только параллельный тест, **не заменять** существующий Xray автоматически |
| MNEBYDNS resolver/DoH policies | 188 или 89 | Только после измерения ресурсов, совместимости TLS и 53/443/853 |
| MNEBYDNS SNI/TCP ingress | 89 или 188 | Указанный ingress должен быть доступен клиентам, 443 уже занят; согласованное мультиплексирование или новый IP позже |
| Guarded Ops worker | совместно с лёгким API | После preflight и запрета root shell для ИИ |
| Независимые probes | внешняя сеть позже | Зависеть только от проверок двух VPS недостаточно |
| Нетбук 2 GB RAM | администрирование | Не критический production и не единственный backup |

**Значения для resize (проектный резерв, не измерение):** 188 в ориентире >=4 GB RAM, >=2 vCPU, >=30 GB диска с запасом для существующих прокси, DB, панели, API и DNS. Решение о тарифе — только после проверки провайдера. 89 пока не расширяем и не загружаем дополнительными прод-сервисами без ресурсного бюджета.

## Реальный конфликт портов

- На 89 публичный 443 занят nginx, local 8443 — Xray. Официальный Node с `network_mode: host` не может слушать уже занятый адрес:порт.
- На 188 заняты публичные 80/443/8888 и ряд других сервисов; открытые TCP 8888 и 8787 требуют отдельной проверки firewall/auth.
- DoH обычно HTTPS 443, DoT — TCP 853, SNI passthrough HTTPS — TCP 443; **они не могут все просто занять один и тот же IP:443 разными процессами.**
- Публичный DNS TCP/UDP 53 не открывать без политики abuse/auth. Блокировать open resolver/forwarder.
- Нужны **live** `ss`, `nginx -T` (санитизированный), firewall/nft, Docker compose ports, iptables/route/SNI, сервисные зависимости. Никаких изменений 443 до проверки.

Полный контракт: [deployment-contract](deployment-contract.md). Режимы: [Smart DNS](smart-dns.md). Отказоустойчивость: [DR](disaster-recovery.md).

## Стоимость и масштабирование

Не покупать третий сервер в ходе создания документации/PoC. Через provider API/IaC добавление серверов возможно позднее, при выбранном провайдере и утверждённых расходных лимитах. У дорогих специальных узлов отдельное ручное одобрение. Мониторинг перегрузки не означает, что увеличение серверов исправит сетевые ограничения.
