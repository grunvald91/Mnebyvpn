'use strict';

const get = (id) => document.getElementById(id);
const invoke = window.__TAURI__?.core?.invoke;
let adapters = [];
let selectedAdapterGuid = null;

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => {
    for (const candidate of document.querySelectorAll('[data-tab]')) {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      if (active) candidate.setAttribute('aria-current', 'page');
      else candidate.removeAttribute('aria-current');
    }
    for (const panel of document.querySelectorAll('.view')) {
      panel.classList.toggle('hidden', panel.id !== button.dataset.tab);
    }
    if (button.dataset.tab === 'diagnostics') refreshAdapters();
  });
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
  if (!adapters.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Windows не вернула сетевые адаптеры.';
    target.append(empty);
    renderAdapterDetails(null);
    return;
  }
  for (const adapter of adapters) {
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
      renderAdapters();
      renderAdapterDetails(adapter);
    });
    target.append(button);
  }
  renderAdapterDetails(adapters.find(item => item.guid === selectedAdapterGuid) || null);
}

async function refreshAdapters() {
  const button = get('refresh-adapters');
  button.disabled = true;
  get('adapters-list').textContent = 'Получаю список адаптеров Windows…';
  if (typeof invoke !== 'function') {
    get('adapters-list').textContent = 'Список доступен только в приложении Windows.';
    button.disabled = false;
    return;
  }
  try {
    adapters = await invoke('list_network_adapters');
    if (!adapters.some(item => item.guid === selectedAdapterGuid)) selectedAdapterGuid = null;
    renderAdapters();
    get('status').textContent = 'Список адаптеров обновлён. Сетевые настройки не менялись.';
  } catch (error) {
    get('adapters-list').textContent = 'Не удалось получить список адаптеров: ' + String(error);
  } finally {
    button.disabled = false;
  }
}

async function refreshStatus() {
  const refresh = get('refresh-dns');
  refresh.disabled = true;
  get('connection-title').textContent = 'Проверяю локальный DNS…';
  if (typeof invoke !== 'function') {
    get('connection-title').textContent = 'Недоступно в браузере';
    get('status').textContent = 'Проверка доступна только в Windows-приложении.';
    refresh.disabled = false;
    return;
  }
  try {
    const response = await invoke('inspect_dns');
    const v4 = response.local.ipv4.ok;
    const v6 = response.local.ipv6.ok;
    get('connection-title').textContent = v4 || v6
      ? 'Локальный DNS отвечает'
      : 'Локальный DNS не отвечает';
    get('connection-hint').textContent = response.caution;
    updateEndpoint('ipv4', response.local.ipv4);
    updateEndpoint('ipv6', response.local.ipv6);
    get('service-state').textContent = response.service
      ? 'Служба диагностики сообщает о работе'
      : 'Нет актуальных данных службы';
    get('status').textContent = 'Проверка выполнена. Защищённый DoT ещё не подтверждён.';
  } catch (error) {
    get('connection-title').textContent = 'Ошибка диагностики';
    get('status').textContent = 'Не удалось проверить DNS: ' + String(error);
  } finally {
    refresh.disabled = false;
  }
}

get('tray-button').addEventListener('click', hideToTray);
get('settings-tray').addEventListener('click', hideToTray);
get('refresh-dns').addEventListener('click', refreshStatus);
get('refresh-adapters').addEventListener('click', refreshAdapters);

if (typeof invoke === 'function') {
  invoke('get_ui_mode').then((mode) => {
    get('status').textContent = mode;
  }).catch(() => {
    get('status').textContent = 'Нет связи с Rust-интерфейсом';
  });
  // No background polling while the window is hidden; keep CPU usage low.
  refreshStatus();
}
