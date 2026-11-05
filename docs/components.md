# Компоненты и репозитории

| Подсистема | Исходник | Решение | Что не делаем |
|---|---|---|---|
| VPN-движок | https://github.com/XTLS/Xray-core | Официальный Xray в составе Remnawave Node, пин версии | Не пишем собственный сетевой протокол |
| VPN-управление | https://github.com/remnawave/panel | Готовая панель + API (AGPL-3.0) | Не копируем панель в монорепо |
| Node | https://github.com/remnawave/node | Официальный управляемый узел (AGPL-3.0) | Не заменяем активный host-Xray без параллельного теста |
| Клиентские шаблоны | https://github.com/remnawave/templates | Шаблоны и response rules, версионированные конфигурации | Не пишем универсальный конвертер до необходимости |
| Страница подключения | https://github.com/remnawave/subscription-page | Опциональный upstream, оценить и лицензировать перед интеграцией | Не хранить реальные bearer subscription URL в исходниках |
| Telegram | https://github.com/grammyjs/grammY | Библиотека TypeScript для своего бота | Не использовать бот с несовместимой коммерческой лицензией |
| База бизнес-данных | https://www.postgresql.org/ | PostgreSQL в коммерческом сервисе, только если необходимо отдельно от Remnawave БД | Не подключать бизнес-логику напрямую к таблицам Remnawave |

Проект `grunvald91/Mnebyvpn` распространяется по MIT. Это **не переопределяет** лицензию AGPL-3.0 upstream. Проверка обязательств по AGPL и документации сторонних библиотек входит в этап pre-production.

## Предлагаемая структура будущего кода

```text
Mnebyvpn/
  README.md
  AGENTS.md
  LICENSE
  docs/
  apps/
    bot/                    # grammY: Telegram интерфейс
    api/                    # коммерческая логика, вебхуки оплаты
    web/                    # mobile-first личный кабинет (после MVP)
  packages/
    domain/                 # планы, право доступа, модель состояний
    remnawave-adapter/      # только официальный API, idempotency/reconcile
    billing-adapter/        # провайдер СБП, verified webhooks
    client-compatibility/   # проверенные профили и версии клиентов
  infra/
    compose/                # раздельные манифесты control/data plane
    config-examples/        # только fake/example, без секретов
    scripts/                # preflight, backup, restore, smoke test
  tests/
    contract/
    integration/
    e2e/
  .github/
    workflows/              # позже: экономный CI; деплой только по разрешению
```

**Эти каталоги — план, сейчас они не содержат приложений.** При реализации не нужно создавать пустые декоративные папки.

## Важные интерфейсы

- MNEBYVPN → Remnawave: versioned HTTP API, secrets outside repo, таймауты, повторы с идемпотентностью, reconcile.
- MNEBYVPN → платёжный провайдер: status verification, signed webhooks, единые идентификаторы транзакций.
- Remnawave → клиенты: подписка по HTTPS (Base64/Xray JSON/sing-box/Mihomo согласно реально проверенному клиенту).
- Remnawave Panel ↔ Node: только через документированную схему совместимых версий, приватный транспорт и аутентификацию.

## Что пока НЕ включаем

- Свой iOS/Android VPN-клиент, кастомный VPN-протокол.
- Несколько параллельных панелей (3X-UI/Marzban совместно с Remnawave).
- Отдельный sing-box сервер без доказанной необходимости.
- Коммерческие сервисы, использующие чужой код с непроверенной лицензией.
- Самописный proxy-based обход белых списков без испытаний и правовых проверок.

Пересмотреть выбор можно ADR после теста/провала конкретного upstream-компонента.
