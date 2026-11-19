# Автоматический отчёт Google Search Console — MNEBYVPN

## Назначение

Еженедельный отчёт по органическому поиску для `mnebyvpn.site`: 28 завершённых дней по времени Google Search Console (Pacific Time) и предыдущие 28 дней; клики, показы, CTR, средняя позиция; все восемь канонических URL (главная и семь инструкций); индексация через Google URL Inspection; группы запросов по доступной выборке.

Плановое расписание: понедельник, 05:37 UTC. Отправка **в приватный Telegram**, а не в общедоступные логи GitHub. Отчёт не содержит полных поисковых фраз, персональных DNS-ссылок или токенов. Google может анонимизировать запросы и возвращать только верхние строки, поэтому это **не** полноценная рыночная частотность. Отсутствие показов не доказывает отсутствие индексации. URL Inspection возвращает статус версии в индексе, а не проверку живого URL.

## Текущее состояние

Рабочий код и офлайн-тесты подготовлены. **Сбор реальных цифр отключён по умолчанию**: это публичный GitHub-репозиторий, а разрешённая связка с `sc-domain:mnebyvpn.site` и приватным получателем отчётов не подтверждена. Workflow корректно пропускается, пока `GSC_REPORT_ENABLED` не равен `true`.

### Одноразовая настройка доступа (без передачи секретов в чат)

1. В Google Cloud создать служебную учётную запись и включить *Google Search Console API*. Предоставить учётной записи доступ к свойству `sc-domain:mnebyvpn.site` в Search Console (разрешённой роли чтения достаточно для отчёта).
2. Создать JSON-ключ этой служебной учётной записи, записать **только** в Actions secret **`GSC_SERVICE_ACCOUNT_JSON`** репозитория `grunvald91/Mnebyvpn`. Никогда не добавлять JSON в коммиты, файлы или issue.
3. Создать секреты **`GSC_TELEGRAM_BOT_TOKEN`** и **`GSC_TELEGRAM_CHAT_ID`** для доставки отчёта только владельцу. Не использовать публичную группу для приватных поисковых показателей.
4. При необходимости создать Actions variable **`GSC_SITE_URL`** (точно `sc-domain:mnebyvpn.site` или `https://mnebyvpn.site/`). По умолчанию используется `sc-domain:mnebyvpn.site`.
5. Только **после проверки прав и доставки** установить Actions variable **`GSC_REPORT_ENABLED=true`**. Один раз запустить workflow вручную через GitHub Actions и убедиться, что отчёт пришёл в нужный чат. Затем он будет выполняться по расписанию.

Изменения в DNS, прокси, VPN, платёжной системе, личном кабинете, Search Console или состоянии сайта **не выполняются**. OAuth scope — `https://www.googleapis.com/auth/webmasters.readonly`.

## Запуск проверок без Google-ключей

```bash
npm test -- --test-name-pattern='Search Console|GSC|Telegram|topic|query|28-day|report|metrics|JWT'
npm run typecheck
```

Полный стандартный `npm test` также включает `tests/gsc-weekly-report.test.ts`.

## Первоисточники

- [Google: Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Google: URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)
- [Google: OAuth и read-only scope](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)
- [Google: ограничения доступных поисковых запросов](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data)
