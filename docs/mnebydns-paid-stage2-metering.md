# MNEBYDNS #84 — этап 2: учёт реальных объёмов (контрольная модель, НЕ live ingress)

## Результат инфраструктурной проверки 10.11.2026

Read-only SSH-аудит действующих RU/foreign VPS: на обоих `public_ipv6_assigned_count=0`, `ipv6_default_route=false`, `ipv6_egress_tcp443=false`, при этом IPv6 TCP listeners присутствуют. Журнал в [telegram-proxy-infra Actions run 42792777276](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42792777276), workflow в [infra PR #62](https://github.com/grunvald91/telegram-proxy-infra/pull/62).

**Вывод: NO-GO для немедленного per-subscriber destination IPv6 в текущей конфигурации.** Это не доказательство отсутствия у провайдера возможности выделить IPv6; условия выделения/маршрутизации и входящий доступ клиентов ещё не проверены. Нельзя объявлять Android Private DNS персональным платным продуктом только на основании IPv6 listener. До реальной маршрутизации дополнительных IPv6 запрещено выдавать продаваемые ссылки для SNI/HTTPS relay и включать коммерческий checkout.

Возможные дальнейшие исследования: доступный каждому клиенту персональный ingress destination (после выделения/маршрутизации публичных адресов), или явно аутентифицированный CONNECT/SOCKS/VPN транспорт (другой UX, не Android DNS-only). Ни один вариант здесь не реализован.

## Что реализовано в SQL 0110

- `record_smart_dns_measured_traffic(entitlement_id,usage_event_id,upload_bytes,download_bytes)` атомарно вызывает прежний FIFO `debit_smart_dns_quota` и сохраняет направление байтов, не удваивая списание при повторной доставке события.
- В `smart_dns_measured_traffic` нет истории сайтов, SNI, IP-адресов и токенов. Время события строго одно — `quota_usage_events.accepted_at`; нет второго часово́го источника для границы месяца.
- `get_smart_dns_monthly_traffic(account_id,entitlement_id)` группирует данные по **календарным месяцам UTC** с раздельными upload/download. Чужой account_id возвращает ноль строк.
- Прямые события старого `debit_smart_dns_quota`, для которых отсутствует достоверная запись upload/download, отдельно маркируются `unattributed_bytes`. Пока значение больше нуля, нельзя говорить клиенту, что месячная расшифровка охватывает весь оплаченный расход.
- SQL event ID уникален внутри entitlement, payload конфликтующие повторы не принимаются; oversized/negative/zero bytes отклоняются.
- Только disposable PostgreSQL, существующие release flags и рабочие DNS/VPN не меняются.

## Важно: ограничения результата

**НЕ ВЫПОЛНЕНО:** достоверная идентификация сетевого TCP потока; измерение байтов именно реальным ingress; резервирование квоты перед отправкой порции трафика; остановка существующего TCP потока после исчерпания; пользовательская DNS-ссылка; подтверждение платного срока на физическом устройстве; месячная витрина в UI.

Этот SQL-инструмент **постфактум** списывает значение, предоставленное будущим **доверенным** измерителем. Ни одна функция SQL не удостоверяет, что клиент переслал столько TCP-байтов, сколько ей передали. Старый `debit_smart_dns_quota` остаётся доступен старым доверенным backend-компонентам; для подтверждённого денежного учёта потребуется запрет неподтверждённых путей списания, выделенная роль, контроль полноты событий и сверка с ingress.

Нужная схема до включения платного продукта:

```
client paid TCP flow
  -> authenticated ingress attribution (UNVERIFIED)
  -> atomic bytes reservation/leased bucket BEFORE forwarding (UNIMPLEMENTED)
  -> actual forwarded TLS byte measurement (UNIMPLEMENTED)
  -> durable event id + exactly-once settlement
  -> monthly aggregation / verified dashboard (SQL prepared; UI UNIMPLEMENTED)
  -> enforce expiry/refund/quota on NEW + EXISTING TCP flows (UNIMPLEMENTED)
```

**Срок:** для оплаты считать отдельно `expires_at`; агрегирование по `YYYY-MM` ничего не обнуляет 1-го числа. Ежемесячные лимиты и правила rollover должны утверждаться отдельно. Одна подписка по-прежнему покрывает любое число устройств и одну общую квоту.

Release gate `P1-DNS-AUTH` остаётся BLOCKED. Ни один флаг `WEB_DNS_METERING_VERIFIED` / `WEB_NETWORK_PROVISIONING_VERIFIED` не включать только из-за успешных unit/SQL тестов.
