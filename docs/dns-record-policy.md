# P1 — политика DNS RR для MNEBYDNS Smart DNS/SNI

Дата: 2026-11-05. **СТАТУС: PROPOSED FAIL-SAFE POLICY, IMPLEMENTATION UNVERIFIED.**

Маршрутизация выбирается **по доменному профилю целиком** (не по одной записи A), с учётом всех запросов A, AAAA, CNAME/DNAME, HTTPS/SVCB, IPv4/IPv6, DNSSEC. Если цель нельзя согласованно обработать — домен **не включать** в Smart DNS passthrough и возвращать корректный обычный upstream DNS ответ. Это означает, что желаемый обход может не работать; это лучше ложной гарантии и повреждённого DNS.

| RR / ситуация | Поведение для подтверждённого Smart DNS домена | Условия отклонения из поддерживаемых |
|---|---|---|
| A | На клиентском DNS допустим только ответ с тестовым адресом IPv4 ingress и корректным TTL/кешем | Если origin/tunnel/ингресс/авторизация не проверены → обычный upstream (не Smart route) |
| AAAA | Возвращать ingress IPv6 **только если** реально настроен и успешно испытан IPv6 путь; иначе весь домен/профиль считать непригодным для заявленной dual-stack поддержки | Не «глушить» AAAA через NXDOMAIN/ложный NODATA по умолчанию |
| CNAME / DNAME | Учитывать всю цепочку, ограничение hop count, нормализацию IDN, owner/target; целевой SNI/Host сохраняет исходный HTTPS origin | Неподдержанная alias chain, wildcard и redirect → профиль не активировать |
| HTTPS / SVCB | Проверять AliasMode/ServiceMode, TargetName, priority, `alpn`, `no-default-alpn`, `port`, `mandatory`, `ipv4hint`, `ipv6hint`, `ech`. **Не** отдавать альтернативные адреса/протоколы, обходящие допустимый ingress, для якобы включённого Smart proxy профиля | Если согласованное представление этих записей и fallback не доказаны — исключить домен; не отключать ECH произвольно |
| DNSSEC (DO bit, AD, RRSIG) | Помнить, что переписанный ответ не имеет оригинальной подписи authoritative зоны; нельзя подделывать RRSIG/AD. Для клиентов со строгой DNSSEC валидацией нужен отдельный проверенный контракт | При несовместимости с DNSSEC не включать Smart route |
| SOA, NS, MX, TXT, PTR, SRV, CAA и прочее | Не менять; обычный upstream с сохранением семантики, если нет отдельной спецификации | Нельзя использовать общие wildcard rewrite для всех типов |
| NXDOMAIN/NODATA/SERVFAIL/timeout | Сохранять корректную отрицательную семантику, SOA/negative TTL, retries; не маскировать ошибки под «успешную» подмену | При ошибке upstream — fail-safe, инцидент и отсутствие гарантии доступа |

## Atomically consistent domain policy

- Единая версия `domain_policy_revision` должна охватывать IPv4, IPv6, HTTPS/SVCB, CNAME follow, разрешённые origin, ingress readiness, TTL и cache invalidation.
- У домена статус `unverified | testing | verified | degraded | disabled`, независимо от профиля конкретного подписчика. Все verified paths проходят TLS/certificate validation без MITM.
- Валидация двух путей: resolver возвращает ingress, а ingress соединяется с настоящим origin **по непереписанному** internal resolver, исключая рекурсивную петлю и rebinding.
- Не строить динамический upstream из произвольного ClientHello SNI. SNI allowlist, origin address allowlist и anti-SSRF обязательны.
- При изменении политики учесть TTL, negative caching и уже сохранённые IP у клиентов; не заявлять мгновенное отключение через DNS.
- Указывать контракт на QUIC/HTTP3: если приложение выбирает UDP 443, TCP-only ingress его не проксирует. Не делать тихие подмены протокольных параметров для неподтверждённых приложений.

## Проверки

1. A+AAAA dual stack, split-horizon, неверный IPv6 и fallback.
2. CNAME 2–4 хопа, DNAME, wildcard, разные target IP, CDN geo, IDN.
3. HTTPS/SVCB AliasMode, ServiceMode, `alpn=h3`, ECH, адресные hints, ports; клиент не должен обходить выбранный ingress незаметно.
4. DNSSEC signed zone и строгий validating client: ни подделки валидности, ни несогласованного поведения.
5. TTL/negative TTL, cache по двум сетям, пережившие отзыв старые DNS ответы.
6. Совместимость iOS/Android/Windows и конкретных сайтов; каждый verified домен имеет дату и версию.

Требует отдельного PoC с пакетным анализом в **контролируемой тестовой сети**, прежде чем включать rewrite. Стандарты: https://www.rfc-editor.org/rfc/rfc9460.html ; https://www.rfc-editor.org/rfc/rfc1034 ; https://www.rfc-editor.org/rfc/rfc4033 ; https://coredns.io/plugins/rewrite/ .
