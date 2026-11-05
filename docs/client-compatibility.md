# Матрица подтверждения клиентов — VPN и Smart DNS

Никакой клиент/сеть не считаются поддержанными без проверенного end-to-end test. Доступность приложений в App Store зависит от Apple ID и региона.

## VPN: кандидаты

| Клиент | Целевые платформы | Формат для теста | Статус MNEBYVPN |
|---|---|---|---|
| INCY | доступные iOS/Android | Xray JSON / Base64 | UNVERIFIED |
| Happ | доступные iOS/Android | Xray JSON / Base64 | UNVERIFIED |
| OneXray | iOS | Xray JSON | UNVERIFIED |
| Karing | iOS/Android | sing-box и альтернативы по клиенту | UNVERIFIED |
| Shadowrocket | iOS | Base64 / URI | UNVERIFIED |
| v2rayNG | Android | Base64 / URI | UNVERIFIED |
| v2rayN | Windows | Base64 / Xray JSON | UNVERIFIED |
| NaixGame | iOS | определить реальным тестом | UNVERIFIED |

Remnawave реализует форматы Base64 / Xray-json / Mihomo / sing-box, но формат **не добавляет** поддержку неподдерживаемого XHTTP/REALITY/UDP клиенту: https://docs.rw/learn-en/templates/ .

### VPN E2E матрица

- Импорт/обновление URL и реальное TLS/VLESS соединение.
- DNS внутри клиента и DNS leaks; IPv6 dual stack/leaks; UDP и QUIC поведение.
- Wi-Fi ↔ mobile switch, background/resume, restart device, истёкшая конфигурация.
- Серверный revoke **уже импортированного ключа** и повторный webhook.
- Обновление шаблона, удаление узла, новый узел, падение subscription domain, client failover (не предполагать).
- На каждого теста записывать версию клиента/ОС, оператора/тип сети, результат, дату и обезличенный evidence.

## Smart DNS: отдельная матрица

| Платформа / режим | Настройка | Тесты | Статус |
|---|---|---|---|
| iOS / iPadOS | управляемый DoH профиль при совместимости ОС | установка/удаление, защищённость профиля, URL, обход приложениями, TCP 443 | UNVERIFIED |
| Android | системный DoT hostname или подтверждённый DoH клиент | Private DNS, нет персональной DoT auth по умолчанию, смена сети | UNVERIFIED |
| Windows/macOS | системный DoH/DoT при наличии | DNS caching, ECH/QUIC, IPv6, revoke | UNVERIFIED |

Smart DNS **не равно VPN**, данные сайта идут без VPN-туннеля, некоторые приложения резолвят самостоятельно. DoH и DoT не обязаны быть взаимозаменяемыми по авторизации/подписке. На iOS нельзя предлагать недоверенный root CA.

### Smart DNS E2E

- Один-два разрешённых HTTPS-домена, корректный DNS ответ и original TLS сертификат без MITM.
- Forward для обычных доменов, ошибка разрешённого домена, negative TTL.
- SNI not allowed/ECH/QUIC/DNSSEC/CNAME/IPv6; no SSRF/private IP/open relay.
- Отзыв DNS токена и отсутствие доступа к per-user policy после revoke.
- Фактическая возможность выполнить настройку в ОС и контроль DNS queries.
- Испытание в ограниченных российских сетях отдельно, **без заявления о гарантии**.

Актуальная матрица результатов должна появиться только после реальных тестов и не должна быть заполнена выдуманными PASS.
