'use strict';

const get = (id) => document.getElementById(id);
const invoke = window.__TAURI__?.core?.invoke;

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

if (typeof invoke === 'function') {
  invoke('get_ui_mode').then((mode) => {
    get('status').textContent = mode;
  }).catch(() => {
    get('status').textContent = 'Нет связи с Rust-интерфейсом';
  });
  // No background polling while the window is hidden; keep CPU usage low.
  refreshStatus();
}
