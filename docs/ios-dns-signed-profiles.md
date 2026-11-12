# MNEBYDNS — автоматическая CMS-подпись iOS DNS профилей

Дата: 12.11.2026. **Только подготовка выпуска. На серверах изменений нет; оплаченный SmartDNS и индивидуальная выдача заблокированы.** Не имеется купленного / установленного подписывающего сертификата, и статус «Проверен» на iPhone не подтвержден.

## Выбор сертификата

Нужна X.509 identity с закрытым ключом для digitalSignature и цепочкой доверия, пригодной для CMS/PKCS#7 SignedData на iOS. Кандидат для рассмотрения — Sectigo S/MIME Organization-Validated Multipurpose (при наличии подтверждаемого юридического лица); для изолированной проверки — Mailbox-Validated S/MIME. **Поставщик должен подтвердить, что конкретный сертификат допустим для подписи конфигурационных профилей iOS**, а не только электронной почты. Результат обязательно проверяется на реальном iPhone. Обычный TLS-сертификат сайта сам по себе не считается сертификатом для подписи профилей.

Источники:
- Apple CMS: https://developer.apple.com/documentation/devicemanagement/configuring-multiple-devices-using-profiles
- Apple iOS root trust: https://support.apple.com/en-us/126047
- Sectigo S/MIME: https://www.sectigo.com/ssl-certificates-tls/email-smime-certificate
- Sectigo OV и Mailbox: https://docs.sectigo.com/sps/place-order-resellers/smime-certificates
- OpenSSL: https://docs.openssl.org/master/man1/openssl-cms/

## Реализовано в ветке

- packages/dns-policy/src/ios-signed-profile.ts: генератор Apple com.apple.dnsSettings.managed (DoT / DoH), строгая проверка адресов, экранирование XML; DER opaque CMS SignedData.
- Скрипт scripts/issue-ios-dns-profile.ts формирует и подписывает профиль в одной операции.
- Сертификат и ключ загружаются из приватных абсолютных путей. Для ключа обязательны права не шире 0600. Ключ не входит в HTTP-ответы, коммиты или логи.
- OpenSSL проверяет подпись, цепочку по явно указанному локальному доверенному набору и точное совпадение извлеченного plist. При отказе файл клиенту не выдаётся.
- Создаётся файл в режиме 0600 без перезаписи существующего; нет незаметной установки, собственного корневого CA или VPN payload.
- Тесты: поддельный CA, изменение подписанного файла, ошибки XML, недопустимый DoH, права ключа, проверка CMS и извлечение содержимого.

Тестовая self-signed CA применяется **только внутри CI**, не на телефонах пользователей. Успех OpenSSL не доказывает доверие iOS.

## Пример для оператора с реальным сертификатом

~~~sh
chmod 600 /run/secrets/mnebydns-ios-sign.key

MNEBYDNS_IOS_OUTPUT=/secure/out/MNEBYDNS-test.mobileconfig \
MNEBYDNS_SIGN_CERT_FILE=/run/secrets/mnebydns-ios-sign.crt \
MNEBYDNS_SIGN_KEY_FILE=/run/secrets/mnebydns-ios-sign.key \
MNEBYDNS_SIGN_TRUST_ROOTS_FILE=/run/secrets/mnebydns-ios-roots.pem \
MNEBYDNS_SIGN_CHAIN_FILE=/run/secrets/mnebydns-ios-intermediates.pem \
node --experimental-strip-types scripts/issue-ios-dns-profile.ts
~~~

Если промежуточные сертификаты не нужны, MNEBYDNS_SIGN_CHAIN_FILE можно опустить. Путь вывода должен быть абсолютным и не существовать. Это **общий тестовый DoT**, DNS: dns.mnebyvpn.site; срок, квота и персональный отзыв для него отсутствуют.

## Отдельный клиентский DoH

Подписанный профиль с персональным DoH URL формируется только при установленном сервером доверенном MNEBYDNS_VERIFIED_PERSONAL_DOH_URL, явных MNEBYDNS_PERSONAL_DOH_ISSUANCE_VERIFIED=yes и MNEBYDNS_DNS_INGRESS_VERIFIED=yes, а также уникальном стабильном MNEBYDNS_IOS_PROFILE_IDENTIFIER. Сам генератор **не создаёт** и не авторизует DNS-токены; подставлять тестовый URL и утверждать, что персональный доступ работает, запрещено.

Для реальной автоматической выдачи клиентам необходим отдельный защищённый signing worker с проверкой entitlement, а не ключ на публичном веб-процессе. После генерации — краткоживущая авторизованная загрузка, application/x-apple-aspen-config, Cache-Control: no-store, отсутствие токенов в публичных логах. Эта клиентская выдача пока **не включена**: см. docs/smart-dns-access-gate.md и docs/release-gates.md.

## Проверки перед релизом

1. Зелёные CI: npm run typecheck, npm test, отдельная реальная CMS проверка.
2. Сертификат: назначение/разрешение для CMS-профилей, срок, доверенная iOS цепочка, условия поставщика, защита ключа и plan renewal.
3. Установка на настоящем iPhone: статус подписи «Проверен», DNS на Wi-Fi и сотовой сети, отзыв/удаление, проверка подключения.
4. Проверка доступности DoT/DoH сервера и платных network E2E ingress-лимитов прежде, чем обещать индивидуальные DNS-ссылки.
5. Apple предупреждает: при замене подписанного профиля без MDM требуется та же signing identity. Смена сертификата / ключа может потребовать переустановки профиля. Источник: https://developer.apple.com/documentation/devicemanagement/configuring-multiple-devices-using-profiles

Не приобретать сертификат до проверки применимости в конкретной юрисдикции и у конкретного удостоверяющего центра.
