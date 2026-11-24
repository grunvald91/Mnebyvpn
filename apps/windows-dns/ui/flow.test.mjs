// Dependency-free simulated interaction test: actual frontend event handlers,
// mocked Tauri IPC, and no network or system DNS mutations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const base = new URL('./', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const source = readFileSync(new URL('app.js', base), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.title = '';
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  async click() { await Promise.all((this.listeners.click || []).map(fn => fn())); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  replaceChildren() {}
  append() {}
}
const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
elements['profile-saved'].hidden = true;
const tabs = ['home', 'diagnostics', 'settings'].map(tab => {
  const button = new Element();
  button.dataset.tab = tab;
  return button;
});
const homeCard = new Element();
const adapterSection = new Element();
const document = {
  visibilityState: 'visible',
  getElementById: id => elements[id] ?? null,
  querySelector: selector => ({
    '.home-dashboard': homeCard,
    '.adapter-section': adapterSection
  })[selector] ?? null,
  querySelectorAll: selector => ({
    '[data-tab]': tabs,
    '.view': [elements.home, elements.diagnostics, elements.settings]
  })[selector] || []
};
const actions = [];
const status = { dns_state: 'disabled', configured: false, recovery_state: 'clear', last_error: null };
let statusUnavailable = false;
let finishUpgrade = null;
let statusReads = 0;
let idleTick = null;
const invoke = async (command, args = {}) => {
  if (command === 'system_dns_status') {
    statusReads += 1;
    if (statusUnavailable) throw new Error('SERVICE_DOWN');
    return { ...status };
  }
  if (command === 'launch_system_dns_action') {
    actions.push({ ...args });
    if (args.action === 'Save') status.configured = true;
    if (args.action === 'Enable') status.dns_state = 'active';
    if (args.action === 'Disable' || args.action === 'Repair') status.dns_state = 'disabled';
    if (args.action === 'Upgrade') {
      return new Promise(resolve => { finishUpgrade = resolve; });
    }
    return 'Подтверждено';
  }
  if (command === 'inspect_dns') {
    return {
      local: {
        ipv4: { ok: true, latency_ms: 8 },
        ipv6: { ok: true, latency_ms: 9 }
      },
      service: { recovery_state: 'clear' }
    };
  }
  throw new Error('Unexpected IPC command: ' + command);
};
const window = {
  __TAURI__: { core: { invoke } },
  setTimeout: fn => Promise.resolve().then(fn),
  setInterval: (fn, ms) => { assert.equal(ms, 5000); idleTick = fn; return 1; },
  addEventListener() {}
};
runInNewContext(source, { document, window, console, Promise }, { timeout: 3000 });
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
await flush();
assert.equal(elements['home-summary'].textContent, 'Выключен');

// First click opens the only input, without silently enabling DNS.
await elements['toggle-system-dns'].click();
await flush();
assert.ok(elements['dot-host'].focused, 'First-time user should land on DNS input');
assert.equal(actions.length, 0, 'Home must not enable an unsaved address');

// Saving stores the profile but leaves system DNS disabled.
elements['dot-host'].value = 'user.dns.example.net';
await elements['apply-new-dot'].click();
await flush();
assert.deepEqual(actions.map(action => action.action), ['Save']);
assert.equal(status.dns_state, 'disabled');
assert.equal(elements['profile-saved'].hidden, false);
assert.equal(elements['profile-editor'].hidden, true);
assert.equal(elements['dot-host'].value, '', 'Personal host should not remain in the form');

// A single Home click now activates the saved profile.
await elements['toggle-system-dns'].click();
await flush();
assert.equal(actions[1].action, 'Enable');
assert.equal(actions[1].host, null);
assert.equal(status.dns_state, 'active');
status.recovery_state = 'pending';
await idleTick();
assert.equal(elements['system-dns-message'].textContent, '', 'Active backups are normal');
status.recovery_state = 'clear';

// A service-side automatic rollback is reflected without reopening the app.
const beforeIdle = actions.length;
status.dns_state = 'disabled';
status.last_error = 'DoT unavailable; restored';
await idleTick();
assert.equal(elements['home-summary'].textContent, 'Выключен');
assert.equal(elements['toggle-system-dns'].textContent, 'Включить');
assert.ok(elements['home-action-hint'].textContent.includes('DoT unavailable'));
status.last_error = null;
assert.equal(actions.length, beforeIdle, 'Idle status must never mutate DNS');
document.visibilityState = 'hidden';
const beforeHidden = statusReads;
await idleTick();
assert.equal(statusReads, beforeHidden, 'Hidden UI must not poll');
document.visibilityState = 'visible';
await elements['toggle-system-dns'].click();
await flush();
assert.equal(status.dns_state, 'active');

// A pending startup (for example after Windows reboot) can be cancelled.
status.dns_state = 'starting';
await idleTick();
assert.equal(elements['toggle-system-dns'].disabled, false);
assert.equal(elements['toggle-system-dns'].textContent, 'Выключить');
await elements['toggle-system-dns'].click();
await flush();
assert.equal(status.dns_state, 'disabled');
await elements['toggle-system-dns'].click();
await flush();
assert.equal(status.dns_state, 'active');

// A saved-profile test uses LocalSystem IPC, not re-entered hostname.
await elements['run-all-tests'].click();
assert.ok(actions.some(action => action.action === 'TestSaved'));
assert.equal(elements['dot-status'].textContent, 'TLS и DNS A/AAAA подтверждены');
assert.ok(elements['proxy-status'].textContent.includes('Локальный DNS'));

// Power off from Home. Status and protected profile are kept separately.
await elements['toggle-system-dns'].click();
await flush();
assert.ok(actions.some(action => action.action === 'Disable'));
assert.equal(status.dns_state, 'disabled');
assert.equal(status.configured, true);

// A long-running service upgrade must lock the main power action.
const beforeUpgrade = actions.length;
const upgrading = elements['upgrade-system-service'].click();
await flush();
assert.equal(elements['toggle-system-dns'].disabled, true);
const beforeBusy = statusReads;
await idleTick();
assert.equal(statusReads, beforeBusy, 'Idle status must not race with upgrade');
await elements['toggle-system-dns'].click();
await flush();
assert.equal(actions.length, beforeUpgrade + 1, 'Power action must not interleave with upgrade');
assert.equal(actions.at(-1).action, 'Upgrade');
finishUpgrade('Обновлено');
await upgrading;
await flush();
assert.equal(elements['toggle-system-dns'].disabled, false);

// Recovery can never claim fully verified state if status is unreachable.
statusUnavailable = true;
await elements['restore-system-dns'].click();
await flush();
assert.ok(elements['system-dns-message'].textContent.includes('не подтверждено'),
  'Do not falsely claim verified recovery after status failure');

console.log('Flow test OK: onboarding, save-only, Home power, saved DoT, serialized upgrade and recovery uncertainty');
