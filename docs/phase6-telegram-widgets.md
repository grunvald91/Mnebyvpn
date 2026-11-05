# Этап 6 — Telegram HTMLBubbles / Bot API 10.4

**Подтверждённая техническая документация:**
- https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/tgw-format.md
- https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/sdk-v1.md
- https://github.com/TelegramMessenger/widget-sandbox/blob/main/docs/widget-runtime-profile.md
- https://github.com/TelegramMessenger/widget-sandbox/blob/main/scripts/conformance/test-bot.ts

Это документированный Telegram layer 233: Bot API 10.4 включает sendWidget, sendSharedWidget, answerWidgetQuery, editMessageWidgetData, editSharedWidgetData и updates widget_query/shared_widget_query.

## Подключено без VPS

- packages/telegram-ui/src/widget-104.ts: компактный immutable HTML с CSS/JS, профиль 1, theme vars Telegram, TelegramWidget.chatData, chatDataChanged, request(). Сервер формирует только личное chat_data. Виджет переключает разделы, обновляет список и может запросить покупку за Telegram Stars.
- packages/billing/src/handlers.ts: команды /my и /status отправляют sendWidget с подписками, /plans — sendWidget с тарифами. На widget_query view:status/view:plans выполняется проверка приватного чата и отправителя, получение данных из PostgreSQL, editMessageWidgetData и ответ answerWidgetQuery с новым состоянием. Для buy:0..3 тариф и цена берутся из БД, создаётся Stars invoice. Попытка из пересланного/чужого чата отвергается.
- tests/widget-104.test.ts: unit проверки размера, состояния, вызовов, безопасности и покупки.
- /start сохраняет документированный Rich Messages как основной начальный экран.

## Безопасность и размер

HTML неизменяем, пересылается вместе с сообщением. Персональные сведения о сроках и расходе квоты есть только в chat_data оригинального приватного сообщения, которое не копируется при пересылке. Shared mode и public_data для персональных карточек выключены. HTML не содержит VPN токены, destination IPv6, персональные ссылки, платёжные ключи или JS доступ к сети.

Лимиты из спецификации: UTF-8 HTML не более 32768 байт, zlib level 9 не более 4096 байт. Проверка приложения требует запас: <=3800 байт после deflateSync level 9. Chat_data и query answer <=1024 UTF-8 bytes. Данные запроса от виджета: 1–64 байта.

## Что необходимо подтвердить

- Настроить setWebhook allowed_updates с widget_query и shared_widget_query при отдельном разрешённом запуске.
- Сделать живой sendWidget E2E через действующий Bot API 10.4 и Telegram-клиент с layer 233: проверить chatDataChanged и отказ пересланных виджетов.
- Проверить старые клиенты: caption в unsupported-media, fallback /start.
- Реальные платежи Prodamus/Stars и VPN/DNS ingress вне текущего этапа, серверы не трогали.
