# Telegram-бот MNEBYVPN: безопасный публичный информационный этап

**Адрес:** [@MnebyVPN_bot](https://t.me/MnebyVPN_bot). Токен проверен через Bot API `getMe` в [GitHub Actions](https://github.com/grunvald91/Mnebyvpn/actions/runs/42202774614).

## Архитектура

- Telegram Bot API token **остаётся только в защищённом секрете** `TELEGRAM_TOKEN_BOT` репозитория `Mnebyvpn`. Он не передаётся на сервер, не появляется в публичной истории Git, логах и Docker environment.
- Telegram webhook выставляется из GitHub Actions по `https://mnebyvpn.site/webhooks/telegram` с высокоэнтропийным `secret_token`, детерминированно производным от Bot API token через HMAC-SHA-256. На сервер передаётся **только SHA-256 digest** этого token. Проверка HTTP-заголовка осуществляется через constant-time digest comparison. Нельзя использовать digest как исходный `secret_token` в Telegram.
- `apps/service/src/telegram-brochure-server.ts` прослушивает только `127.0.0.1:8793`. Telegram может принимать один Bot API вызов из JSON-ответа самого webhook, поэтому серверу **не требуется** сам Bot API token на первом этапе.
- /start возвращает полезное информационное меню с кнопками и ссылкой на `https://mnebyvpn.site`. /help, callback и другие обычные сообщения обрабатываются без доступа к платёжной БД.
- Все платные функции **намеренно выключены**. `pre_checkout_query` всегда отклоняется, сообщения об уже состоявшемся платеже возвращают HTTP 503 без ложного подтверждения и требуют запуска полноценного проверенного биллинга. `/readyz` всегда 503. Такой информационный бот не может создавать или активировать подписки.
- Нельзя вводить пользователя в заблуждение сообщением «доступ оформлен»: существующее бот-меню биллинга активируется только после тестов VPN и DNS узлов, подтверждения платежей и миграций.

## Необходимые следующие шаги

После испытаний сети и подтверждённой готовности биллинга потребуется отдельный полноценный backend `handleTelegramUpdate` с устойчивой обработкой платежей, общими данными подписок и возможностью совершать исходящие Bot API вызовы. Информационный этап работает без раскрытия серверу бот-токена и не подменяет такие испытания.

**Telegram Login на сайте — другой набор реквизитов**: BotFather > Login Widget выдаёт `Client ID` и `Client Secret`. Для перехода на `/auth/login` их необходимо отдельно передать через защищённые секреты, зарегистрировать `https://mnebyvpn.site` и `https://mnebyvpn.site/auth/callback`. Bot API token не является Client Secret.

Первоисточники: [Making requests when getting updates](https://core.telegram.org/bots/api#making-requests-when-getting-updates), [setWebhook и secret_token](https://core.telegram.org/bots/api#setwebhook), [Telegram Login/OIDC](https://core.telegram.org/bots/telegram-login).
