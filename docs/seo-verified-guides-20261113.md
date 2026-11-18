# Проверка десяти SEO-материалов PR #75 для текущего сайта

Дата: 2026-11-13. Основа: актуальный `main` репозитория; **старый draft PR #75 не объединять**, потому что в нём старые `index.html`, `server.ts`, условия оплаты и другие файлы.

## Граница подтверждений

- **Подтверждено на уровне текущего исходного кода:** на сайте есть интерфейс VPN, ссылки на Android INCY и iOS Karing, публичные страницы юридических документов, существующие robots/sitemap/canonical. Код `apps/web/public/app.js` блокирует заказ `smart_dns` и `bundle`, пока не закрыты другие условия готовности.
- **Подтверждено общедоступными стандартами:** DNS-over-TLS шифрует DNS-сообщения между устройством и резолвером (RFC 7858); Android 9+ поддерживает Private DNS; VPN — отдельный сетевой туннель, который не заменяется выбором DNS-сервера.
- **Не подтверждено свежим end-to-end в рамках этого изменения:** доступность конкретных YouTube, Instagram, Telegram, Gemini, ChatGPT или Claude через серверы MNEBYVPN/MNEBYDNS на конкретном операторе; работа на iPhone/Android любого клиента; активность коммерческой DNS-выдачи/оплаты, ограничения/квоты и совместная работа VPN + DNS. Это **не публикуется как гарантия**.
- **НЕ включаем:** гарантированный доступ, обещание анонимности, повышение скорости, универсальный обход геоблокировок, конкретные цены, "безлимит", статус оплаченного DNS, непроверенные параметры устройства и личные ссылки доступа.

## Проверка каждого материала

| Страница | Разрешённый проверяемый предмет | Что не заявляем |
|---|---|---|
| /vpn | VPN-туннель, выходной IP, ограничения | анонимность и работу во всех сетях |
| /smart-dns | DNS/DoT и отличия от VPN | шифрование всего трафика, гарантированную геолокацию |
| /vpn-android | INCY указан на текущем сайте, шаги по уже выданной подписке | готовность покупки и успешное соединение на любом Android |
| /vpn-iphone | Karing указан на текущем сайте, системное разрешение iOS | универсальную поддержку всех iPhone и маршрутов |
| /private-dns-android | системная настройка Private DNS и DoT | доступ без фактически выданного DNS hostname |
| /youtube | проверка симптомов/воспроизведения и сетевого маршрута | подтверждённое воспроизведение через MNEBYDNS в любой сети |
| /instagram | диагностика приложения и отличие VPN от DNS | работа Instagram только через DNS |
| /telegram | разные симптомы соединения/загрузки медиа | работу Telegram через Smart DNS |
| /google-gemini | сетевые и учётные ограничения, проверка отдельных функций | работу Gemini в любой стране и всех режимах |
| /ai-services | отличия механизмов VPN/DNS и независимые правила платформ | обход региональных правил ChatGPT, Claude или Gemini |

## Авторитетные источники

- DNS-over-TLS: https://www.rfc-editor.org/rfc/rfc7858
- Android Private DNS: https://developers.google.com/speed/public-dns/docs/using/
- Apple VPN: https://support.apple.com/en-ie/guide/security/sec802e8ab55/web
- Google Gemini availability: https://support.google.com/gemini/answer/14579026
- OpenAI ChatGPT supported countries: https://help.openai.com/en/articles/7947663-chatgpt-supported-countries
- Anthropic supported regions: https://www.anthropic.com/legal/supported-regions
- Google Search canonical: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls

## Релизные правила

1. Отдельная ветка от текущего `main`, изменение только текстов и публичных SEO-маршрутов. Не изменять `app.js` оплату, выдачу, VPN-прокси, DNS, серверную конфигурацию и секреты.
2. `npm run typecheck`, `npm test`, `npm run test:integration` и полный CI на последнем SHA должны пройти успешно.
3. Проверить HTTP 200, self-canonical, CSP-хеш JSON-LD, robots/sitemap, приватный noindex и адаптивность с телефона.
4. Выпуск **не открывает коммерческий checkout**. Запись в `docs/release-gates.md` и юридическая оценка требований к публичной подаче VPN/Smart DNS остаются отдельными условиями.
5. После мержа и выкладки проверить реальные URL и индексацию, не объявлять выпуск на production на основании одного мержа.

Внешняя доступность https://mnebyvpn.site/ из текущей среды проверки не установлена; статус HTTPS и индексации остаётся **UNVERIFIED** до внешнего HTTP-аудита.