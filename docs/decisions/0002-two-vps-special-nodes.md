# ADR-0002 — Два VPS сейчас, новые узлы по необходимости

Дата: 2026-11-05. Статус: условно, требуется ресурсо-портовый preflight.

Два VPS уже заняты Telegram-прокси. Один (ru-edge) после согласованного расширения предполагается под Remnawave Panel + API/DB; второй (foreign-exit) под Xray/Node. При этом публичный nginx 443 на обоих VPS занят; Node host network не делает контейнер независимым от портов хоста. MNEBYDNS тоже потребует DNS TLS ingress и строгой сетевой карты.

**Нет автоматической покупки третьего VPS.** До согласованного увеличения ресурсов панели и проверки зашифрованных offsite бэкапов серверы не меняются. Autoscaling через API/IaC включается позднее после согласованных hard caps. Дорогой `special` узел — manual по умолчанию и без обещаний обхода сетевого allowlisting.

См. ../infrastructure.md , ../deployment-contract.md , ../operations-automation.md .
