# FI: установка только публичных доверенных ключей на существующем RU188

**Текущее состояние:** `fi-test-01` пока не зарегистрирован и не опубликован.
На RU188 есть защищённый Ed25519-ключ контроллера и отдельный SSH
enrollment-ключ, но отсутствуют `fi-known_hosts` и
`fi-node-public.spki`. Воспринимать данные из `ssh-keyscan` как
независимо утверждённый host key **нельзя**.

Результаты read-only проверки:
<https://github.com/grunvald91/telegram-proxy-infra/actions/runs/44364793055>.

## Единственная необходимая ручная проверка

Откройте **консоль виртуального сервера FI в панели провайдера**, не
подключение SSH, ключ которого пока неизвестен. Выполните на FI:

```bash
ssh-keygen -E sha256 -lf /etc/ssh/ssh_host_ed25519_key.pub
sha256sum /var/lib/mnebyvpn-nodekit/fi-test-01/identity/node-public.spki
```

Ожидаемый SHA256 **идентификатора узла** (отдельный от SSH host key):
`c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9`.

Неутверждённый кандидат SSH host fingerprint, наблюдавшийся по сети
18 ноября 2026 года:
`SHA256:9ZmaeYVL/bMTZ8gkB/rKd5dHFKgricLX6Uss2heatiI`.

**Совпадение двух наблюдений является предметом проверки оператором,
а не автоматического утверждения.** Если в независимой консоли другой
SSH host fingerprint — **остановить регистрацию**, не отправлять пароль
через неподтверждённое SSH-соединение.

## Скрипт подготовки (устанавливается на RU188, но не запускается автоматически)

`ops/controller188-systemd/stage-fi-public-trust.py` работает только root
на действующем `188.120.254.223`, без сети и без подключения PostgreSQL.
Он читает только публичные входные файлы и отдельно утверждённую
оператором запись. Не читает приватные ключи, не создаёт SSH-пользователей
и не запускает службу.

Перед ручным выполнением (только после проверки в провайдерской консоли)
должны существовать root-owned 0600 файлы:

- `/root/mnebyvpn-controller/inbox/fi-host-ed25519.pub` — **фактический**
  `/etc/ssh/ssh_host_ed25519_key.pub` с FI, полученный из подтверждённого
  источника (публичный).
- `/root/mnebyvpn-controller/inbox/fi-node-public.spki` — 44-байтный
  DER Ed25519 public key FI (публичный).
- `/root/mnebyvpn-controller/approvals/fi-trust-reviewed.json` — операторская
  запись о **независимой проверке**. Не создавать её по результату
  `ssh-keyscan` и не заполнять автоматически агентом:

```json
{
  "schema_version": 1,
  "node_id": "fi-test-01",
  "controller_public_sha256": "e4c862bd0171e5be4ae64770a555029e090d3a8fcfa5ef2a82ffb0b798552844",
  "fi_identity_spki_sha256": "c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9",
  "fi_ssh_host_sha256": "SHA256:ЗДЕСЬ_НЕЗАВИСИМО_ПРОВЕРЕННЫЙ_ОТПЕЧАТОК",
  "reviewed_via": "provider_console",
  "operator_approved": true
}
```

Важно: это пример **структуры**, поле `fi_ssh_host_sha256` должно содержать
реально независимо подтверждённый fingerprint по приведённой выше
команде. Нельзя автоматически заменить эту строку сетевым значением.

При наличии всех проверенных документов:

```bash
sudo python3 /opt/mnebyvpn-controller/tools/stage-fi-public-trust.py check
sudo python3 /opt/mnebyvpn-controller/tools/stage-fi-public-trust.py stage
```

Создаёт ровно два root-owned 0600 файла:

- `/root/mnebyvpn-controller/fi-known_hosts` с **HostKeyAlias**
  `fi.mnebyvpn.site` и независимо подтверждённым публичным SSH-ключом.
- `/root/mnebyvpn-controller/fi-node-public.spki` со сверенным по
  SHA-256 публичным узловым DER SPKI.

Скрипт проверяет соответствие существующему публичному ключу
контроллера, контрольным суммам в утверждённой записи, точное
Ed25519 SSH-кодирование, отсутствие небезопасных путей/симлинков
и защищённость всех входных файлов. При ошибке удаляет только
только что созданные файлы; уже существующее доверие не заменяет.

**Не делает:** запись/одобрение `fi-test-01` в PostgreSQL,
включение `mnebyvpn-fi-enrollment.service`,
передачу публичного ключа контроллера на FI, установку
`authorized_keys` forced-command, клиентский доступ, подписки
Smart DNS, AmneziaWG либо Telegram MTProxy/Telemt.

Следом необходимы отдельные проверки на FI, запланированная запись
в БД (`planned`), операторское одобрение (`approved`) и только
после этого одноразовый `enrolled` E2E.
