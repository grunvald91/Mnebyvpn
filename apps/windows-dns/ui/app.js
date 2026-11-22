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

get('tray-button').addEventListener('click', hideToTray);
get('settings-tray').addEventListener('click', hideToTray);

if (typeof invoke === 'function') {
  invoke('get_ui_mode').then((mode) => {
    get('status').textContent = mode;
  }).catch(() => {
    get('status').textContent = 'Нет связи с Rust-интерфейсом';
  });
}
