'use strict';

const get = (id) => document.getElementById(id);
const invoke = window.__TAURI__?.core?.invoke;
let adapters = [];
let selectedAdapterGuid = null;
let showAllAdapters = false;
let preflightLoading = false;
let adaptersLoading = false;
let dnsLoading = false;
let dotLoading = false;
let proxySmokeLoading = false;
let dotInputRevision = 0;
let fullTestLoading = false;

function openTab(tab) {
  for (const candidate of document.querySelectorAll('[data-tab]')) {
    const active = candidate.dataset.tab === tab;
    candidate.classList.toggle('active', active);
    if (active) candidate.setAttribute('aria-current', 'page');
    else candidate.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('.view')) {
    panel.classList.toggle('hidden', panel.id !== tab);
  }
  if (tab === 'diagnostics') void refreshAdapters();
  if (tab === 'settings') void refreshSystemDns();
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => openTab(button.dataset.tab));
}

async function hideToTray() {
  if (typeof invoke !== 'function') {
    get('status').textContent = 'В браузере трей недоступен. Запустите приложение Tauri.';
    return;
  }
  try {
    await invoke('hide_to_tray');
  } catch (error) {
    get('status').textContent = 'Ошибка сворачивания: ' + String(error);
  }
}

function updateEndpoint(prefix, endpoint) {
  get(prefix + '-state').textContent = endpoint.ok
    ? 'Отвечает · ' + endpoint.latency_ms + ' мс'
    : (endpoint.error || 'Нет ответа');
  get(prefix + '-state').classList.toggle('good', endpoint.ok);
  get(prefix + '-state').classList.toggle('bad', !endpoint.ok);
}

function appendDetailLine(parent, label, value) {
  const row = document.createElement('div');
  row.className = 'adapter-detail-line';
  const name = document.createElement('span');
  name.textContent = label;
  const content = document.createElement('strong');
  content.textContent = value;
  row.append(name, content);
  parent.append(row);
}

function renderAdapterDetails(adapter) {
  const target = get('adapter-details');
  target.replaceChildren();
  if (!adapter) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Выбери адаптер, чтобы увидеть его текущие DNS-серверы.';
    target.append(empty);
    return;
  }
  const title = document.createElement('h3');
  title.textContent = adapter.name;
  target.append(title);
  appendDetailLine(target, 'Тип', adapter.kind);
  appendDetailLine(target, 'Состояние', adapter.operational ? 'Активен' : 'Не активен');
  appendDetailLine(target, 'IPv4 DNS', adapter.dns_ipv4.length ? adapter.dns_ipv4.join(', ') : 'Не сообщаются');
  appendDetailLine(target, 'IPv6 DNS', adapter.dns_ipv6.length ? adapter.dns_ipv6.join(', ') : 'Не сообщаются');
  const note = document.createElement('p');
  note.className = adapter.is_tunnel || adapter.is_loopback || !adapter.likely_physical ? 'adapter-warning' : 'muted';
  note.textContent = adapter.note + ' Текущий список DNS не показывает, настроен ли он вручную или получен автоматически.';
  target.append(note);
}

function renderAdapters() {
  const target = get('adapters-list');
  target.replaceChildren();
  const visible = showAllAdapters ? adapters : adapters.filter(item => item.operational && item.likely_physical);
  const toggle = get('toggle-all-adapters');
  toggle.textContent = showAllAdapters
    ? 'Скрыть служебные интерфейсы'
    : 'Показать служебные интерфейсы (' + (adapters.length - visible.length) + ')';
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = adapters.length
      ? 'Подходящие активные Wi-Fi/Ethernet не найдены. Можно просмотреть все интерфейсы для диагностики.'
      : 'Windows не вернула сетевые адаптеры.';
    target.append(empty);
    renderAdapterDetails(null);
    get('preflight-dns').disabled = true;
    return;
  }
  if (!visible.some(item => item.guid === selectedAdapterGuid)) selectedAdapterGuid = null;
  for (const adapter of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'adapter-card' + (adapter.guid === selectedAdapterGuid ? ' selected' : '');
    button.setAttribute('aria-pressed', String(adapter.guid === selectedAdapterGuid));
    const name = document.createElement('strong');
    name.textContent = adapter.name;
    const meta = document.createElement('span');
    meta.textContent = adapter.kind + ' · ' + (adapter.operational ? 'активен' : 'не активен');
    button.append(name, meta);
    button.addEventListener('click', () => {
      selectedAdapterGuid = adapter.guid;
      get('preflight-result').textContent = 'Для нового адаптера предпроверка ещё не выполнена.';
      renderAdapters();
      renderAdapterDetails(adapter);
    });
    target.append(button);
  }
  renderAdapterDetails(visible.find(item => item.guid === selectedAdapterGuid) || null);
  get('preflight-dns').disabled = !selectedAdapterGuid || preflightLoading;

}

async function refreshAdapters() {
  if (adaptersLoading) return;
  adaptersLoading = true;
  const button = get('refresh-adapters');
  button.disabled = true;
  get('adapters-list').textContent = 'Получаю список адаптеров Windows…';
  if (typeof invoke !== 'function') {
    get('adapters-list').textContent = 'Список доступен только в приложении Windows.';
    adaptersLoading = false;
    button.disabled = false;
    return;
  }
  try {
    adapters = await invoke('list_network_adapters');
    if (!adapters.some(item => item.guid === selectedAdapterGuid)) selectedAdapterGuid = null;
    get('preflight-result').textContent = 'Обновлены данные Windows. Запусти предпроверку ещё раз.';
    renderAdapters();
    get('status').textContent = 'Список адаптеров обновлён. Сетевые настройки не менялись.';
  } catch (error) {
    get('adapters-list').textContent = 'Не удалось получить список адаптеров: ' + String(error);
  } finally {
    adaptersLoading = false;
    button.disabled = false;
  }
}

async function preflightDns() {
  if (preflightLoading || !selectedAdapterGuid) return;
  preflightLoading = true;
  const selectedGuid = selectedAdapterGuid;
  const button = get('preflight-dns');
  button.disabled = true;
  const result = get('preflight-result');
  result.replaceChildren();
  result.textContent = 'Читаю настройки DNS выбранного адаптера…';
  try {
    if (typeof invoke !== 'function') throw new Error('Доступно только в Windows-приложении.');
    const snapshot = await invoke('preflight_dns_adapter', { guid: selectedGuid });
    if (selectedAdapterGuid !== selectedGuid) return;
    result.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = snapshot.adapter_name + ' — только чтение';
    result.append(title);
    const showFamily = (family, value, error) => {
      const item = document.createElement('p');
      if (error) {
        item.textContent = family + ': ошибка чтения — ' + error;
      } else {
        const servers = value.static_servers.length ? value.static_servers.join(', ') : 'не заданы';
        const profile = value.profile_servers.length ? value.profile_servers.join(', ') : 'не заданы';
        item.textContent = family + ' · статические: ' + servers
          + '; профильные: ' + profile + '. ' + value.interpretation;
      }
      result.append(item);
    };
    showFamily('IPv4', snapshot.ipv4, snapshot.ipv4_error);
    showFamily('IPv6', snapshot.ipv6, snapshot.ipv6_error);
    const note = document.createElement('p');
    note.className = 'adapter-warning';
    note.textContent = snapshot.warning + ' Переключение DNS пока отключено.';
    result.append(note);
    if (snapshot.registry) {
      const evidence = document.createElement('p');
      evidence.className = 'muted';
      const count = (values) => Array.isArray(values) ? values.length + ' адресов' : 'нет записи';
      evidence.textContent = 'Реестр (только чтение): IPv4 статический — '
        + count(snapshot.registry.ipv4_static)
        + '; IPv4 DHCP — ' + count(snapshot.registry.ipv4_dhcp)
        + '; IPv6 статический — ' + count(snapshot.registry.ipv6_static)
        + '. Это не доказывает текущий источник DNS.';
      result.append(evidence);
    } else if (snapshot.registry_error) {
      const problem = document.createElement('p');
      problem.className = 'adapter-warning';
      problem.textContent = 'Независимая проверка реестра недоступна: ' + snapshot.registry_error;
      result.append(problem);
    }
    if (!snapshot.recovery_ready && Array.isArray(snapshot.recovery_blockers)) {
      const heading = document.createElement('strong');
      heading.textContent = 'Почему точное восстановление ещё заблокировано';
      result.append(heading);
      const blockers = document.createElement('ul');
      blockers.className = 'recovery-blockers';
      for (const reason of snapshot.recovery_blockers) {
        const line = document.createElement('li');
        line.textContent = reason;
        blockers.append(line);
      }
      result.append(blockers);
    }
  } catch (error) {
    result.textContent = 'Ошибка предпроверки: ' + String(error);
  } finally {
    preflightLoading = false;
    button.disabled = !selectedAdapterGuid;
  }
}

async function refreshStatus() {
  if (dnsLoading) return;
  dnsLoading = true;
  const refresh = get('refresh-dns');
  refresh.disabled = true;
  if (typeof invoke !== 'function') {
    get('status').textContent = 'Проверка доступна только в Windows-приложении.';
    dnsLoading = false;
    refresh.disabled = false;
    return;
  }
  try {
    const response = await invoke('inspect_dns');
    const v4 = response.local.ipv4.ok;
    const v6 = response.local.ipv6.ok;
    updateEndpoint('ipv4', response.local.ipv4);
    updateEndpoint('ipv6', response.local.ipv6);
    if (response.service) {
      const state = response.service.recovery_state;
      const label = state === 'pending' ? 'Есть запись восстановления DNS'
        : state === 'unreadable' ? 'Ошибка чтения защищённого журнала'
        : 'Связь со службой установлена · журнал проверен';
      get('service-state').textContent = label;
      get('service-state').classList.toggle('bad', state !== 'clear');
      get('service-state').classList.toggle('good', state === 'clear');
    } else {
      get('service-state').textContent = response.service_error
        ? 'Служба недоступна: ' + response.service_error
        : 'Служба не отвечает';
      get('service-state').classList.remove('good');
      get('service-state').classList.add('bad');
    }
    get('status').textContent = 'Локальный DNS проверен. Статус DoT отображается отдельно в разделе «Мой DNS».';
  } catch (error) {
    get('status').textContent = 'Не удалось проверить DNS: ' + String(error);
  } finally {
    dnsLoading = false;
    refresh.disabled = false;
  }
}


async function checkPersonalDot() {
  if (dotLoading) return;
  const host = get('dot-host').value.trim();
  const requestRevision = dotInputRevision;
  const button = get('check-dot');
  const result = get('dot-status');
  const diagnostic = get('dot-diag-state');
  if (!host) {
    result.textContent = 'Введите персональное имя DoT-сервера.';
    return;
  }
  if (typeof invoke !== 'function') {
    result.textContent = 'Проверка доступна только в Windows-приложении.';
    return;
  }
  dotLoading = true;
  button.disabled = true;
  result.classList.remove('good', 'bad');
  result.textContent = 'Проверяю TCP:853, сертификат TLS и DNS-ответы…';
  try {
    const report = await invoke('probe_personal_dot', { host });
    if (dotInputRevision !== requestRevision || get('dot-host').value.trim() !== host) {
      result.textContent = 'Адрес был изменён. Повторите проверку.';
      diagnostic.textContent = 'Нужна новая проверка';
      return;
    }
    if (report.complete) {
      result.textContent = 'TLS-сертификат проверен. A и AAAA получены внутри TLS. '
        + 'Общее время: ' + report.elapsed_ms + ' мс.';
      diagnostic.textContent = 'DoT отвечает · TLS проверен';
      result.classList.add('good');
    } else {
      const reason = !report.ipv4.ok ? report.ipv4.error : report.ipv6.error;
      result.textContent = 'TLS-сертификат принят, но DNS-запрос не прошёл: ' + (reason || 'нет ответа');
      diagnostic.textContent = 'TLS принят, DNS не подтверждён';
      result.classList.add('bad');
    }
  } catch (error) {
    if (dotInputRevision !== requestRevision) {
      result.textContent = 'Адрес изменился — выполните новую проверку.';
      return;
    }
    // Error strings are sanitized by Rust; never echo or log the hostname.
    result.textContent = String(error);
    result.classList.add('bad');
    diagnostic.textContent = 'DoT не подтверждён';
  } finally {
    dotLoading = false;
    button.disabled = false;
  }
}

get('tray-button').addEventListener('click', hideToTray);
get('settings-tray').addEventListener('click', hideToTray);

let systemDnsLoading = false;
let systemDnsPollGeneration = 0;
let systemDnsOperationPending = false;
let systemDnsPendingAction = null;
let systemDnsState = 'checking';
let systemDnsConfigured = false;
let systemDnsLastError = null;
const SYSTEM_DNS_POLL_INTERVAL_MS = 2000;
const SYSTEM_DNS_POLL_MAX_ATTEMPTS = 24;

function renderHomeConnection() {
  const button = get('toggle-system-dns');
  const summary = get('home-summary');
  const hint = get('home-action-hint');
  const home = document.querySelector('.home-dashboard');
  const labels = {
    checking: 'Проверяю состояние подключения…',
    'not-installed': 'Smart DNS выключен',
    disabled: 'Smart DNS выключен',
    starting: 'Подключение…',
    active: 'Smart DNS включён',
    restoring: 'Отключение…',
    error: 'Ошибка системного DNS',
    unknown: 'Не удалось проверить службу DNS'
  };
  const active = systemDnsState === 'active';
  const recoveryNeeded = systemDnsState === 'error' || systemDnsState === 'unknown';
  const transitional = systemDnsState === 'starting' || systemDnsState === 'restoring';
  const busy = systemDnsLoading || systemDnsOperationPending || transitional;
  summary.textContent = labels[systemDnsState] || labels.unknown;
  button.textContent = systemDnsOperationPending
    ? (systemDnsPendingAction === 'Disable' ? 'Отключение…' : 'Подключение…')
    : recoveryNeeded ? 'Восстановить DNS' : active ? 'Выключить' : 'Включить';
  // Unknown or failed state is NOT "off": expose only the safe disable
  // operation so the user is never trapped without a recovery action.
  button.disabled = busy || systemDnsState === 'checking';
  button.setAttribute('aria-pressed', String(active));
  home.classList.toggle('is-active', active);
  home.classList.toggle('is-error', ['error', 'unknown'].includes(systemDnsState));
  hint.textContent = systemDnsOperationPending
    ? 'Подтвердите запрос Windows. Состояние обновится автоматически.'
    : active ? 'Системные DNS-запросы направляются через защищённый DoT.'
    : systemDnsState === 'not-installed' || systemDnsState === 'disabled'
      ? (systemDnsConfigured || get('dot-host').value.trim()
        ? 'Нажмите «Включить», чтобы использовать Smart DNS в Windows.'
        : 'Для первого подключения укажите персональный адрес в «Настройках».')
      : recoveryNeeded
        ? 'Не удалось подтвердить состояние DNS. Нажмите «Восстановить DNS» или откройте диагностику.'
        : 'Проверяю состояние Windows DNS.';
}

async function refreshSystemDns() {
  if (typeof invoke !== 'function') {
    systemDnsState = 'unknown';
    get('system-dns-state').textContent = 'Недоступно в браузере';
    get('system-dns-message').textContent = 'Откройте Windows-приложение.';
    renderHomeConnection();
    return systemDnsState;
  }
  try {
    const report = await invoke('system_dns_status');
    const state = report.dns_state || 'unknown';
    systemDnsState = state;
    systemDnsConfigured = report.configured === true;
    systemDnsLastError = report.last_error || null;
    const labels = {
      disabled: 'Выключен',
      starting: 'Настраивается',
      active: 'Включён',
      restoring: 'Восстановление',
      error: 'Ошибка',
      unknown: 'Неизвестно'
    };
    get('system-dns-state').textContent = labels[state] || state;
    get('system-dns-state').classList.toggle('good', state === 'active');
    get('system-dns-state').classList.toggle('bad', state === 'error');
    const details = [];
    if (report.adapter_count !== null && report.adapter_count !== undefined) {
      details.push('Адаптеров: ' + report.adapter_count);
    }
    if (report.last_error) details.push(report.last_error);
    if (report.probe) {
      details.push('DNS IPv4: ' + (report.probe.ipv4.ok ? 'OK' : 'ошибка'));
      details.push('DNS IPv6: ' + (report.probe.ipv6.ok ? 'OK' : 'ошибка'));
    }
    get('system-dns-message').textContent = details.join(' · ') || 'Состояние службы получено.';
    renderHomeConnection();
    if (systemDnsLastError && (state === 'error' || (state === 'disabled' && report.recovery_state === 'pending'))) {
      get('home-action-hint').textContent = 'Причина: ' + systemDnsLastError;
    }
    if (state === 'disabled' && report.recovery_state === 'pending') {
      systemDnsState = 'error';
      renderHomeConnection();
      get('home-action-hint').textContent = 'Настройки DNS не восстановлены полностью. Проверьте «Диагностика».';
    }
    return systemDnsState;
  } catch (error) {
    systemDnsLastError = String(error);
    const uninstalled = String(error).includes('SERVICE_NOT_INSTALLED');
    systemDnsState = uninstalled ? 'not-installed' : 'unknown';
    if (uninstalled) systemDnsConfigured = false;
    get('system-dns-state').textContent = uninstalled ? 'Не установлена' : 'Служба недоступна';
    get('system-dns-message').textContent = uninstalled
      ? 'Служба установится автоматически при первом включении.'
      : 'Не удалось прочитать состояние DNS: ' + String(error);
    renderHomeConnection();
    return systemDnsState;
  }
}

async function watchSystemDnsAction(action, generation) {
  const expected = action === 'Enable' ? 'active' : 'disabled';
  for (let attempt = 0; attempt < SYSTEM_DNS_POLL_MAX_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => window.setTimeout(resolve, SYSTEM_DNS_POLL_INTERVAL_MS));
    if (generation !== systemDnsPollGeneration) return;
    if (document.visibilityState === 'hidden') break;
    const state = await refreshSystemDns();
    if (generation !== systemDnsPollGeneration) return;
    if (state === expected || state === 'error') {
      systemDnsOperationPending = false;
      systemDnsPendingAction = null;
      renderHomeConnection();
      return;
    }
  }
  if (generation !== systemDnsPollGeneration) return;
  systemDnsOperationPending = false;
  systemDnsPendingAction = null;
  await refreshSystemDns();
  get('home-action-hint').textContent =
    'Изменение не подтверждено. Проверьте запрос UAC и откройте «Настройки».';
}

async function requestSystemDns(action) {
  if (systemDnsLoading || systemDnsOperationPending || typeof invoke !== 'function') return;
  // Once configured, the normal power button reuses the protected profile.
  // A new hostname is installed only through the explicit Settings action.
  const host = action === 'Enable' && !systemDnsConfigured ? get('dot-host').value.trim() : null;
  if (action === 'Enable' && !host && !systemDnsConfigured) {
    openTab('settings');
    get('dot-host').focus();
    get('system-dns-message').textContent =
      'Введите персональный DoT-адрес. Затем вернитесь на главную и нажмите «Включить».';
    return;
  }
  if (action === 'Enable' && !['disabled', 'not-installed'].includes(systemDnsState)) return;
  if (action === 'Disable' && !['active', 'error', 'unknown'].includes(systemDnsState)) return;
  systemDnsLoading = true;
  systemDnsOperationPending = true;
  systemDnsPendingAction = action;
  const generation = ++systemDnsPollGeneration;
  renderHomeConnection();
  try {
    const message = await invoke('launch_system_dns_action', { action, host: host || null });
    get('system-dns-message').textContent = message;
    systemDnsLoading = false;
    renderHomeConnection();
    void watchSystemDnsAction(action, generation);
  } catch (error) {
    systemDnsOperationPending = false;
    systemDnsPendingAction = null;
    get('system-dns-message').textContent = 'Не удалось управлять DNS: ' + String(error);
    systemDnsLoading = false;
    await refreshSystemDns();
    get('home-action-hint').textContent = 'Ошибка управления DNS: ' + String(error)
      + '. Проверьте раздел «Настройки» для аварийного восстановления.';
  }
}

get('apply-new-dot').addEventListener('click', async () => {
  const host = get('dot-host').value.trim();
  if (!host) {
    get('system-dns-message').textContent = 'Введите адрес персонального DoT-сервера.';
    get('dot-host').focus();
    return;
  }
  if (systemDnsOperationPending || systemDnsLoading || systemDnsState === 'active') {
    get('system-dns-message').textContent =
      'Отключите Smart DNS перед сменой сервера и дождитесь восстановления DNS.';
    return;
  }
  if (!['disabled', 'not-installed'].includes(systemDnsState)) {
    get('system-dns-message').textContent =
      'Состояние службы не подтверждено. Сначала проверьте его, прежде чем менять DNS.';
    return;
  }
  systemDnsOperationPending = true;
  systemDnsPendingAction = 'Enable';
  const generation = ++systemDnsPollGeneration;
  renderHomeConnection();
  try {
    const message = await invoke('launch_system_dns_action', { action: 'Enable', host });
    get('system-dns-message').textContent = message;
    void watchSystemDnsAction('Enable', generation);
  } catch (error) {
    systemDnsOperationPending = false;
    systemDnsPendingAction = null;
    get('system-dns-message').textContent = 'Не удалось сохранить DNS-сервер: ' + String(error);
    renderHomeConnection();
  }
});

get('repair-system-dns').addEventListener('click', async () => {
  if (systemDnsOperationPending || systemDnsLoading) return;
  const button = get('repair-system-dns');
  button.disabled = true;
  get('upgrade-system-message').textContent =
    'Точное восстановление возможно только после остановки службы Windows…';
  try {
    const message = await invoke('launch_system_dns_action', { action: 'Repair', host: null });
    get('upgrade-system-message').textContent = message;
    await refreshSystemDns();
  } catch (error) {
    get('upgrade-system-message').textContent =
      'Аварийное восстановление не подтверждено: ' + String(error)
      + '. Защищённые резервные записи сохранены.';
  } finally {
    button.disabled = false;
  }
});

get('upgrade-system-service').addEventListener('click', async () => {
  if (systemDnsOperationPending || systemDnsLoading) return;
  const button = get('upgrade-system-service');
  if (systemDnsState === 'active' || systemDnsState === 'starting' || systemDnsState === 'restoring') {
    get('upgrade-system-message').textContent =
      'Сначала отключите Smart DNS и проверьте восстановление исходных настроек.';
    return;
  }
  button.disabled = true;
  get('upgrade-system-message').textContent =
    'Проверяю защищённый журнал и состояние службы перед обновлением…';
  try {
    const message = await invoke('launch_system_dns_action', { action: 'Upgrade', host: null });
    get('upgrade-system-message').textContent = message;
    await refreshSystemDns();
  } catch (error) {
    get('upgrade-system-message').textContent =
      'Не удалось безопасно обновить службу: ' + String(error);
  } finally {
    button.disabled = false;
  }
});

get('toggle-system-dns').addEventListener('click', () => {
  const recoveryNeeded = ['active', 'error', 'unknown'].includes(systemDnsState);
  void requestSystemDns(recoveryNeeded ? 'Disable' : 'Enable');
});
get('restore-system-dns').addEventListener('click', () => {
  if (systemDnsOperationPending) return;
  // Manual recovery is available even when service status is unknown.
  // The elevated helper always restores from its protected journal.
  const generation = ++systemDnsPollGeneration;
  systemDnsOperationPending = true;
  systemDnsPendingAction = 'Disable';
  renderHomeConnection();
  invoke('launch_system_dns_action', { action: 'Disable', host: null })
    .then(() => watchSystemDnsAction('Disable', generation))
    .catch(error => {
      systemDnsOperationPending = false;
      systemDnsPendingAction = null;
      get('system-dns-message').textContent = 'Не удалось начать восстановление: ' + String(error);
      renderHomeConnection();
    });
});
get('refresh-system-dns').addEventListener('click', () => { void refreshSystemDns(); });
// No background polling: refresh when the user returns to the window.
window.addEventListener('focus', () => {
  if (document.visibilityState !== 'hidden' && !systemDnsOperationPending) void refreshSystemDns();
});

get('refresh-dns').addEventListener('click', refreshStatus);
get('refresh-adapters').addEventListener('click', refreshAdapters);
get('toggle-all-adapters').addEventListener('click', () => {
  showAllAdapters = !showAllAdapters;
  renderAdapters();
});
get('preflight-dns').addEventListener('click', preflightDns);

async function smokeProxy() {
  if (proxySmokeLoading || dotLoading) return;
  const host = get('dot-host').value.trim();
  const revision = dotInputRevision;
  const button = get('check-proxy');
  const result = get('proxy-status');
  const diagnostic = get('proxy-diag-state');
  if (!host) {
    result.textContent = 'Укажите имя персонального DoT-сервера.';
    return;
  }
  if (typeof invoke !== 'function') {
    result.textContent = 'Проверка доступна только в Windows-приложении.';
    return;
  }
  proxySmokeLoading = true;
  button.disabled = true;
  result.classList.remove('good', 'bad');
  result.textContent = 'Запускаю временный UDP-порт и проверяю передачу через TLS…';
  try {
    const report = await invoke('smoke_local_dot_proxy', { host });
    if (dotInputRevision !== revision) {
      result.textContent = 'Имя сервера изменилось — выполните новую проверку.';
      diagnostic.textContent = 'Нужна повторная проверка';
      return;
    }
    if (!report.success) throw new Error('Положительный DNS-ответ не подтверждён');
    result.textContent = 'UDP → DoT работает. A-ответов: ' + report.answer_count
      + ', тестовый порт: ' + report.local_port
      + ', время: ' + report.elapsed_ms + ' мс. Прокси остановлен.';
    diagnostic.textContent = 'Тест UDP → DoT успешен';
    result.classList.add('good');
  } catch (error) {
    if (dotInputRevision !== revision) {
      result.textContent = 'Имя сервера изменилось — выполните новую проверку.';
      return;
    }
    result.textContent = 'Локальный прокси: ' + String(error);
    diagnostic.textContent = 'Тест не пройден';
    result.classList.add('bad');
  } finally {
    proxySmokeLoading = false;
    button.disabled = false;
  }
}


function showTestHeading(title, hint) {
  get('connection-title').textContent = title;
  get('connection-hint').textContent = hint;
}

function setTestStep(id, diagnosticId, message, status) {
  const result = get(id);
  result.textContent = message;
  result.classList.toggle('good', status === 'good');
  result.classList.toggle('bad', status === 'bad');
  get(diagnosticId).textContent = status === 'good' ? 'Успешно' :
    status === 'bad' ? 'Ошибка' : 'Не проверено';
}

async function runAllTests() {
  if (fullTestLoading || dotLoading || proxySmokeLoading) return;
  const input = get('dot-host');
  const host = input.value.trim();
  if (!host) {
    input.setAttribute('aria-invalid', 'true');
    showTestHeading('Нужен адрес DNS', 'Введите персональный DoT-адрес из подписки и повторите проверку.');
    input.focus();
    return;
  }
  if (typeof invoke !== 'function') {
    showTestHeading('Запустите EXE на Windows', 'В браузерном просмотре реальные сетевые проверки недоступны.');
    return;
  }
  const revision = dotInputRevision;
  const buttons = [get('run-all-tests'), get('check-dot'), get('check-proxy')];
  fullTestLoading = true;
  buttons.forEach(button => { button.disabled = true; });
  let phase = 'dot';
  setTestStep('dot-status', 'dot-diag-state', 'Проверяю сертификат TLS и DNS-ответы…', 'pending');
  setTestStep('proxy-status', 'proxy-diag-state', 'Ожидает защищённого DNS', 'pending');
  showTestHeading('Проверяю защищённый DNS…', 'Первый этап: TLS и ответы A / AAAA через порт 853.');
  try {
    const tls = await invoke('probe_personal_dot', { host });
    if (revision !== dotInputRevision) return;
    if (!tls.complete) {
      const reason = tls.ipv4.ok ? tls.ipv6.error : tls.ipv4.error;
      setTestStep('dot-status', 'dot-diag-state', 'TLS проверен, но DNS-запрос не прошёл: ' + (reason || 'нет ответа'), 'bad');
      setTestStep('proxy-status', 'proxy-diag-state', 'Пропущен: сначала нужен DoT', 'pending');
      showTestHeading('DoT не прошёл проверку', 'Адрес верный? Посмотрите сообщение первого этапа.');
      return;
    }
    setTestStep('dot-status', 'dot-diag-state', 'TLS и DNS A/AAAA подтверждены · ' + tls.elapsed_ms + ' мс', 'good');
    phase = 'proxy';
    showTestHeading('Проверяю DNS-прокси…', 'Второй этап: временный UDP → DoT, без изменения настроек Windows.');
    setTestStep('proxy-status', 'proxy-diag-state', 'Проверяю локальную передачу DNS…', 'pending');
    const proxy = await invoke('smoke_local_dot_proxy', { host });
    if (revision !== dotInputRevision) return;
    if (!proxy.success) {
      setTestStep('proxy-status', 'proxy-diag-state', 'Положительный ответ DNS не получен', 'bad');
      showTestHeading('Прокси не прошёл проверку', 'DoT работает, но локальная передача DNS не подтверждена.');
      return;
    }
    setTestStep('proxy-status', 'proxy-diag-state',
      'UDP → DoT подтверждён · ' + proxy.elapsed_ms + ' мс · прокси закрыт', 'good');
    showTestHeading('Проверки пройдены', 'DoT и UDP-прокси отвечают. Текущее состояние системного DNS показано на главной.');
  } catch (error) {
    if (revision !== dotInputRevision) return;
    if (phase === 'dot') {
      setTestStep('dot-status', 'dot-diag-state', 'DoT: ' + String(error), 'bad');
      setTestStep('proxy-status', 'proxy-diag-state', 'Пропущен: сначала нужен DoT', 'pending');
      showTestHeading('DoT не прошёл проверку', 'Проверьте DNS-имя и доступность порта TCP 853.');
    } else {
      setTestStep('proxy-status', 'proxy-diag-state', 'Прокси: ' + String(error), 'bad');
      showTestHeading('Прокси не прошёл проверку', 'DoT работает, но локальный UDP-тест не подтвердился.');
    }
  } finally {
    fullTestLoading = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

get('run-all-tests').addEventListener('click', runAllTests);
get('check-dot').addEventListener('click', checkPersonalDot);
get('check-proxy').addEventListener('click', smokeProxy);
get('dot-host').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runAllTests();
});
get('dot-host').addEventListener('input', () => {
  dotInputRevision += 1;
  get('dot-host').removeAttribute('aria-invalid');
  showTestHeading('Проверка нового DNS-адреса', 'Проверьте новый адрес перед включением на главной.');
  get('dot-status').textContent = 'Адрес изменён — проверка требуется заново.';
  renderHomeConnection();
  get('dot-status').classList.remove('good', 'bad');
  get('dot-diag-state').textContent = 'Не проверено';
  get('proxy-status').textContent = 'Адрес изменился — проверка локального прокси сброшена.';
  get('proxy-status').classList.remove('good', 'bad');
  get('proxy-diag-state').textContent = 'Не проверено';
});

if (typeof invoke === 'function') {
  invoke('get_ui_mode').then((mode) => {
    get('status').textContent = mode;
  }).catch(() => {
    get('status').textContent = 'Нет связи с Rust-интерфейсом';
  });
  // The only operation on startup is a read-only status refresh.
  renderHomeConnection();
  void refreshSystemDns();
}
