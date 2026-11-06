# ADR-0003 — Собственный Smart DNS + выборочная маршрутизация SNI

**Дата:** 2026-11-05; **статус с 2026-11-06:** принято как долгосрочное исследование, **DEFERRED из платного MVP**. Платный transparent SNI с общим ingress без отдельной аутентификации **BLOCKED**. См. [ADR-0007](../mvp-scope.md) и [release-gates](../release-gates.md).

## Контекст
Нужен способ подключения без отдельного VPN-приложения, аналогичный по классу персональному DNS + маршрутизации, но полностью автономный от Aeternia.

## Решение
Создать собственный DNS policy subsystem на CoreDNS/DoH/DoT и собственный strict-allowlist TCP TLS/SNI ingress на основе nginx stream (или сравнимого открытого proxy), без MITM. Возможная будущая модель MNEBYDNS — отдельный продукт или bundle после E2E. На MVP платную квоту проксируемых HTTPS-байтов через один DNS-hostname не продавать. VPN остаётся независимым контуром.

## Негативные ограничения
Не подходит для всего трафика. QUIC/HTTP3, ECH, DNSSEC, индивидуальные DNS в приложениях, IP literals и allowlisting операторов могут нарушить работу; не обещать универсальную совместимость. Запрещён открытый прокси, неизвестный upstream и доступ к внутренней сети.

## Тесты до релиза
Подтвердить реальную настройку DoH/DoT, TLS passthrough без сертификатного вмешательства, auth/revoke, DNS cache, адреса, услуги и условия каждого origin. Не занимать существующий порт 443 без отдельного разрешения.

Обоснование: https://github.com/coredns/coredns , https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html , https://www.rfc-editor.org/rfc/rfc6066.html .
