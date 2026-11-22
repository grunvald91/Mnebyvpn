'use strict';

const get = (id) => document.getElementById(id);
const invoke = window.__TAURI__?.core?.invoke;
let adapters = [];
let selectedAdapterGuid = null;
let preflightLoading = false;
let adaptersLoading = false;
let dnsLoading = false;
let dotLoading = false;
let proxySmokeLoading = false;
let dotInputRevision = 0;

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
      get('preflight-result').textContent = 'Для нового адаптера предпроверка ещё не выполнена.';
      renderAdapters();
      renderAdapterDetails(adapter);
    });
    target.append(button);
  }
  renderAdapterDetails(adapters.find(item => item.guid === selectedAdapterGuid) || null);
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
  get('connection-title').textContent = 'Проверяю локальный DNS…';
  if (typeof invoke !== 'function') {
    get('connection-title').textContent = 'Недоступно в браузере';
    get('status').textContent = 'Проверка доступна только в Windows-приложении.';
    dnsLoading = false;
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
    get('connection-title').textContent = 'Ошибка диагностики';
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
get('refresh-dns').addEventListener('click', refreshStatus);
get('refresh-adapters').addEventListener('click', refreshAdapters);
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

get('check-dot').addEventListener('click', checkPersonalDot);
get('check-proxy').addEventListener('click', smokeProxy);
get('dot-host').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') checkPersonalDot();
});
get('dot-host').addEventListener('input', () => {
  dotInputRevision += 1;
  get('dot-status').textContent = 'Адрес изменён — проверка требуется заново.';
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
  // No background polling while the window is hidden; keep CPU usage low.
  refreshStatus();
}
