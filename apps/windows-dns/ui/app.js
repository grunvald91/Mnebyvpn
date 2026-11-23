'use strict';

const get = (id) => document.getElementById(id);
const invoke = window.__TAURI__?.core?.invoke;
let adapters = [];
let selectedAdapterGuid = null;
let adapterSelectionRevision = 0;
let showAllAdapters = false;
let preflightLoading = false;
let adaptersLoading = false;
let dnsLoading = false;
let dotLoading = false;
let proxySmokeLoading = false;
let dotInputRevision = 0;
let dotProfileDirty = false;
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
  if (tab === 'diagnostics') void refreshStatus();
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
    empty.textContent = 'Выберите адаптер';
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
  note.textContent = adapter.note;
  target.append(note);
}

function renderAdapters() {
  const target = get('adapters-list');
  target.replaceChildren();
  const visible = showAllAdapters ? adapters : adapters.filter(item => item.operational && item.likely_physical);
  const toggle = get('toggle-all-adapters');
  toggle.setAttribute('aria-pressed', String(showAllAdapters));
  if (selectedAdapterGuid && !visible.some(item => item.guid === selectedAdapterGuid)) {
    selectedAdapterGuid = null;
    adapterSelectionRevision += 1;
    get('preflight-result').textContent = '';
  }
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
  for (const adapter of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'adapter-card' + (adapter.guid === selectedAdapterGuid ? ' selected' : '');
    button.dataset.adapterGuid = adapter.guid;
    button.setAttribute('aria-pressed', String(adapter.guid === selectedAdapterGuid));
    const name = document.createElement('strong');
    name.textContent = adapter.name;
    const meta = document.createElement('span');
    meta.textContent = adapter.operational ? 'Активен' : 'Отключён';
    button.append(name, meta);
    button.addEventListener('click', () => {
      if (selectedAdapterGuid === adapter.guid) return;
      selectedAdapterGuid = adapter.guid;
      adapterSelectionRevision += 1;
      get('preflight-result').textContent = '';
      for (const card of target.querySelectorAll('.adapter-card')) {
        const selected = card.dataset.adapterGuid === selectedAdapterGuid;
        card.classList.toggle('selected', selected);
        card.setAttribute('aria-pressed', String(selected));
      }
      renderAdapterDetails(adapter);
      get('preflight-dns').disabled = preflightLoading;
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
  get('toggle-all-adapters').disabled = true;
  get('preflight-dns').disabled = true;
  adapterSelectionRevision += 1;
  get('preflight-result').textContent = '';
  get('adapters-list').textContent = 'Загрузка…';
  try {
    if (typeof invoke !== 'function') throw new Error('Список доступен только в приложении Windows.');
    adapters = await invoke('list_network_adapters');
    renderAdapters();
    get('status').textContent = '';
  } catch (error) {
    adapters = [];
    selectedAdapterGuid = null;
    renderAdapterDetails(null);
    get('adapters-list').textContent = 'Не удалось получить список адаптеров: ' + String(error);
  } finally {
    adaptersLoading = false;
    button.disabled = false;
    get('toggle-all-adapters').disabled = !adapters.length;
    get('preflight-dns').disabled = !selectedAdapterGuid || preflightLoading;
  }
}

async function preflightDns() {
  if (adaptersLoading || preflightLoading || !selectedAdapterGuid) return;
  preflightLoading = true;
  const selectedGuid = selectedAdapterGuid;
  const revision = adapterSelectionRevision;
  const button = get('preflight-dns');
  button.disabled = true;
  const result = get('preflight-result');
  result.replaceChildren();
  result.textContent = 'Читаю настройки DNS выбранного адаптера…';
  try {
    if (typeof invoke !== 'function') throw new Error('Доступно только в Windows-приложении.');
    const snapshot = await invoke('preflight_dns_adapter', { guid: selectedGuid });
    if (revision !== adapterSelectionRevision) return;
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
    note.textContent = snapshot.warning;
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
    if (revision === adapterSelectionRevision) {
      result.textContent = 'Ошибка предпроверки: ' + String(error);
    }
  } finally {
    preflightLoading = false;
    button.disabled = adaptersLoading || !selectedAdapterGuid;
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
    updateEndpoint('ipv4', response.local.ipv4);
    updateEndpoint('ipv6', response.local.ipv6);
    if (response.service) {
      const state = response.service.recovery_state;
      const rollbackNeeded = needsDnsRecovery(response.service);
      const label = state === 'unreadable' ? 'Ошибка журнала'
        : rollbackNeeded ? 'Нужен откат' : 'Работает';
      get('service-state').textContent = label;
      get('service-state').removeAttribute('title');
      get('service-state').classList.toggle('bad', rollbackNeeded);
      get('service-state').classList.toggle('good', !rollbackNeeded);
    } else {
      get('service-state').textContent = 'Нет связи';
      get('service-state').title = String(response.service_error || 'Служба не отвечает');
      get('service-state').classList.remove('good');
      get('service-state').classList.add('bad');
    }
    get('status').textContent = '';
  } catch (error) {
    for (const id of ['ipv4-state', 'ipv6-state', 'service-state']) {
      const indicator = get(id);
      indicator.textContent = 'Не проверено';
      indicator.classList.remove('good', 'bad');
      indicator.removeAttribute('title');
    }
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

let systemDnsStatusRequest = null;
let systemDnsPendingAction = null;
let systemDnsState = 'checking';
let systemDnsConfigured = false;
let systemDnsLastError = null;
let homeActionMessage = '';
const SYSTEM_DNS_POLL_INTERVAL_MS = 2000;
const SYSTEM_DNS_POLL_MAX_ATTEMPTS = 24;

function needsDnsRecovery(report) {
  // Active DNS keeps rollback snapshots until it is disabled. During a
  // transition the service is already responsible for reconciling them.
  return report.recovery_state === 'unreadable' ||
    (report.recovery_state === 'pending' &&
      !['active', 'starting', 'restoring'].includes(report.dns_state));
}

function renderHomeConnection() {
  const button = get('toggle-system-dns');
  const summary = get('home-summary');
  const hint = get('home-action-hint');
  const home = document.querySelector('.home-dashboard');
  const labels = {
    checking: 'Проверка…',
    'not-installed': 'Выключен',
    disabled: 'Выключен',
    starting: 'Подключение…',
    active: 'Включён',
    degraded: 'DNS не отвечает',
    restoring: 'Отключение…',
    error: 'Ошибка подключения',
    unknown: 'Служба недоступна'
  };
  const actionLabels = {
    Enable: 'Подключение…',
    Disable: 'Отключение…',
    Save: 'Сохранение…',
    Repair: 'Восстановление…',
    Upgrade: 'Обновление службы…'
  };
  const pending = systemDnsPendingAction !== null;
  const unavailable = typeof invoke !== 'function';
  const busy = pending || ['starting', 'restoring', 'checking'].includes(systemDnsState);
  const active = systemDnsState === 'active';
  const recoveryNeeded = ['error', 'unknown'].includes(systemDnsState);
  const canDisable = active || systemDnsState === 'degraded';
  const label = labels[systemDnsState] || labels.unknown;
  const buttonLabel = actionLabels[systemDnsPendingAction] ||
    (busy ? label : recoveryNeeded ? 'Восстановить DNS' : canDisable ? 'Выключить' : 'Включить');
  if (summary.textContent !== label) summary.textContent = label;
  if (button.textContent !== buttonLabel) button.textContent = buttonLabel;
  button.setAttribute('aria-disabled', String(busy || unavailable));
  home.classList.toggle('is-active', active);
  home.classList.toggle('is-error', recoveryNeeded || systemDnsState === 'degraded');
  get('apply-new-dot').disabled = pending;
  get('dot-host').readOnly = systemDnsPendingAction === 'Save';
  get('restore-system-dns').disabled = pending;
  get('upgrade-system-service').disabled = pending;

  let detail = homeActionMessage;
  if (unavailable) {
    detail = 'Откройте Windows-приложение.';
  } else if (pending) {
    detail = ['Enable', 'Save'].includes(systemDnsPendingAction) && systemDnsState === 'not-installed'
      ? 'Подтвердите установку Windows' : '';
  } else if (!detail) {
    if (systemDnsLastError) detail = systemDnsLastError;
    else if (recoveryNeeded || systemDnsState === 'degraded') detail = 'Откройте «Проверка».';
    else if (['not-installed', 'disabled'].includes(systemDnsState) && !systemDnsConfigured) {
      detail = 'Сохраните адрес DNS в настройках.';
    }
  }
  if (hint.textContent !== detail) hint.textContent = detail;
}

function refreshSystemDns() {
  if (!systemDnsStatusRequest) {
    systemDnsStatusRequest = readSystemDnsStatus().finally(() => { systemDnsStatusRequest = null; });
  }
  return systemDnsStatusRequest;
}

async function readSystemDnsStatus() {
  const indicator = get('system-dns-state');
  const message = get('system-dns-message');
  try {
    if (typeof invoke !== 'function') throw new Error('Откройте Windows-приложение.');
    const report = await invoke('system_dns_status');
    const rollbackNeeded = needsDnsRecovery(report);
    const localDnsHealthy = report.probe?.ipv4?.ok && report.probe?.ipv6?.ok;
    const state = rollbackNeeded ? 'error' :
      report.dns_state === 'active' && !localDnsHealthy ? 'degraded' :
        report.dns_state || 'unknown';
    const labels = {
      disabled: 'Выключен',
      starting: 'Настраивается',
      active: 'Включён',
      degraded: 'DNS не отвечает',
      restoring: 'Восстановление',
      error: 'Ошибка',
      unknown: 'Неизвестно'
    };
    systemDnsState = state;
    systemDnsConfigured = report.configured === true;
    systemDnsLastError = report.last_error ||
      (rollbackNeeded ? 'Восстановление DNS не завершено' : null);
    indicator.textContent = rollbackNeeded ? 'Нужен откат' : labels[state];
    indicator.classList.toggle('good', state === 'active');
    indicator.classList.toggle('bad', ['error', 'degraded'].includes(state));
    if (message.textContent !== (systemDnsLastError || '')) {
      message.textContent = systemDnsLastError || '';
    }
  } catch (error) {
    const uninstalled = String(error).includes('SERVICE_NOT_INSTALLED');
    systemDnsState = uninstalled ? 'not-installed' : 'unknown';
    systemDnsConfigured = false;
    systemDnsLastError = uninstalled ? null : String(error);
    indicator.textContent = uninstalled ? 'Не установлена' : 'Служба недоступна';
    indicator.classList.remove('good');
    indicator.classList.toggle('bad', !uninstalled);
    message.textContent = systemDnsLastError || '';
  }
  renderHomeConnection();
  return systemDnsState;
}

function waitForVisibleWindow() {
  return new Promise(resolve => {
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', resume);
      resolve();
    };
    document.addEventListener('visibilitychange', resume);
    resume();
  });
}

async function watchSystemDnsAction(action) {
  const expected = action === 'Enable' ? 'active' : 'disabled';
  for (let attempt = 0; attempt < SYSTEM_DNS_POLL_MAX_ATTEMPTS;) {
    if (document.visibilityState === 'hidden') await waitForVisibleWindow();
    await new Promise(resolve => window.setTimeout(resolve, SYSTEM_DNS_POLL_INTERVAL_MS));
    if (document.visibilityState === 'hidden') continue;
    attempt += 1;
    const state = await refreshSystemDns();
    if (state === expected) return;
    if (action === 'Enable' && state === 'error') return;
  }
  homeActionMessage = systemDnsLastError || 'Не удалось подтвердить изменение. Откройте «Проверка».';
}

async function requestSystemDns(action, host = null) {
  if (systemDnsPendingAction || typeof invoke !== 'function') return;
  if (action === 'Enable' && !['disabled', 'not-installed'].includes(systemDnsState)) return;
  if (action === 'Disable' && !['active', 'degraded', 'error', 'unknown'].includes(systemDnsState)) return;
  const actionMessages = {
    Save: 'dot-profile-message',
    Repair: 'repair-system-message',
    Upgrade: 'upgrade-system-message'
  };
  const target = actionMessages[action] ? get(actionMessages[action]) : null;
  if (target) {
    target.textContent = {
      Save: 'Сохраняю адрес DNS…',
      Repair: 'Восстанавливаю DNS…',
      Upgrade: 'Проверяю состояние службы перед обновлением…'
    }[action];
  }
  systemDnsPendingAction = action;
  homeActionMessage = '';
  renderHomeConnection();
  try {
    const message = await invoke('launch_system_dns_action', { action, host });
    if (action === 'Enable' || action === 'Disable') {
      await watchSystemDnsAction(action);
    } else {
      await refreshSystemDns();
      if (action === 'Save') {
        // The control ACK can arrive before configured appears in status.
        systemDnsConfigured = true;
        dotProfileDirty = false;
      }
      target.textContent = message;
    }
  } catch (error) {
    await refreshSystemDns();
    const message = 'Ошибка: ' + String(error);
    if (target) target.textContent = message;
    else homeActionMessage = message;
  } finally {
    systemDnsPendingAction = null;
    renderHomeConnection();
  }
}

get('dot-profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = get('dot-host');
  const host = input.value.trim();
  const status = get('dot-profile-message');
  if (!host) {
    status.textContent = 'Введите адрес DNS.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  if (typeof invoke !== 'function') {
    status.textContent = 'Откройте Windows-приложение.';
    return;
  }
  if (!['disabled', 'not-installed'].includes(systemDnsState)) {
    status.textContent = 'Сначала выключите DNS на главной.';
    return;
  }
  void requestSystemDns('Save', host);
});

get('upgrade-system-service').addEventListener('click', () => {
  if (['active', 'degraded', 'starting', 'restoring'].includes(systemDnsState)) {
    get('upgrade-system-message').textContent =
      'Сначала отключите Smart DNS и проверьте восстановление исходных настроек.';
    return;
  }
  void requestSystemDns('Upgrade');
});

get('toggle-system-dns').addEventListener('click', (event) => {
  if (event.currentTarget.getAttribute('aria-disabled') === 'true') return;
  const recoveryNeeded = ['active', 'degraded', 'error', 'unknown'].includes(systemDnsState);
  if (!recoveryNeeded &&
    (!systemDnsConfigured || (dotProfileDirty && get('dot-host').value.trim()))) {
    openTab('settings');
    get('dot-host').focus();
    get('dot-profile-message').textContent = 'Введите адрес DNS и нажмите «Сохранить адрес».';
    return;
  }
  void requestSystemDns(recoveryNeeded ? 'Disable' : 'Enable');
});
get('restore-system-dns').addEventListener('click', () => {
  void requestSystemDns('Repair');
});
get('refresh-system-dns').addEventListener('click', () => { void refreshSystemDns(); });
// No background polling: refresh when the user returns to the window.
window.addEventListener('focus', () => {
  if (document.visibilityState !== 'hidden' && !systemDnsPendingAction) void refreshSystemDns();
});

get('refresh-dns').addEventListener('click', refreshStatus);
document.querySelector('.adapter-section').addEventListener('toggle', (event) => {
  if (event.currentTarget.open && !adapters.length && !adaptersLoading) {
    void refreshAdapters();
  }
});
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
get('dot-host').addEventListener('input', () => {
  dotInputRevision += 1;
  dotProfileDirty = true;
  get('dot-profile-message').textContent = '';
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

// Startup is read-only. No redundant Rust round-trip or adapter enumeration.
renderHomeConnection();
void refreshSystemDns();
