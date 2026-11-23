// Dependency-free check of frontend IDs, commands and main test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as flush } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';
const base = new URL('./', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const js = readFileSync(new URL('app.js', base), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', base), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate DOM IDs');
for (const m of js.matchAll(/\bget\(['"]([^'"]+)['"]\)/g)) {
  assert.ok(ids.includes(m[1]), 'Missing DOM ID: ' + m[1]);
}
for (const m of js.matchAll(/\binvoke\(['"]([a-z_]+)'/g)) {
  assert.ok(rust.includes('fn ' + m[1] + '('), 'Missing Tauri command: ' + m[1]);
}
const home = html.split('<section id="home" class="view home-view">')[1]?.split('<section id="diagnostics"')[0];
const settings = html.split('<section id="settings" class="view hidden">')[1];
assert.ok(home, 'Missing home dashboard');
assert.ok(settings, 'Missing Settings');
assert.equal((home.match(/<button\b/g) || []).length, 1, 'Home must have exactly one control button');
assert.ok(home.includes('id="toggle-system-dns"'), 'Missing one-button DNS control');
assert.ok(!home.includes('Тестовый режим'), 'Home must not pretend to be a test screen');
assert.ok(!home.includes('run-all-tests'), 'Connection tests belong in Settings');
assert.ok(settings.includes('id="dot-host"'), 'DoT profile belongs in Settings');
assert.ok(settings.includes('id="run-all-tests"'), 'Diagnostics must remain available');
assert.ok(!settings.includes('id="enable-system-dns"'), 'No duplicate enable button in Settings');
assert.ok(!settings.includes('id="disable-system-dns"'), 'No duplicate disable button in Settings');
assert.ok(js.includes('async function runAllTests()'));
assert.ok(js.includes('async function requestSystemDns('));
const css = readFileSync(new URL('styles.css', base), 'utf8');
const service = readFileSync(new URL('../service/src/main.rs', base), 'utf8');
const ipc = readFileSync(new URL('../ipc/src/windows.rs', base), 'utf8');
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', base), 'utf8'));
const buttons = [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"[^>]*>/g)];
for (const [button, id] of buttons) {
  if (button.includes('type="submit"')) {
    assert.equal(id, 'apply-new-dot', 'Unexpected submit button');
    assert.ok(js.includes("get('dot-profile-form').addEventListener('submit'"));
    continue;
  }
  assert.ok(js.includes("get('" + id + "').addEventListener"),
    'Visible button missing listener: ' + id);
}
assert.ok(html.includes('<details class="fold" id="maintenance-panel">'),
  'Maintenance should be collapsed by default');
assert.ok(!html.includes('id="repair-system-dns"'), 'Duplicate restore button');
assert.ok(!html.includes('id="settings-tray"'), 'Duplicate tray button');
assert.ok(!html.includes('Маршрутизация Smart DNS'), 'Remove never-checked diagnostic row');
assert.ok(!html.includes('Сохранить и включить'), 'Settings must never enable DNS');
assert.ok(html.includes('>Сохранить адрес</button>'), 'Settings Save affordance missing');
assert.ok(js.includes("requestSystemDns('Save', host)"), 'Save must use a non-activating IPC command');
assert.ok(ipc.includes('ConfigureOnly(String)'), 'Save-only opcode missing');
assert.ok(service.includes('ControlRequest::ConfigureOnly(host) => save_profile(host, false)'),
  'Saving an address must persist with DNS disabled');
assert.ok(rust.includes('ControlRequest::ConfigureOnly(hostname.to_ascii_lowercase())'),
  'Save must not send ConfigureAndEnable');
assert.ok(css.includes('prefers-reduced-motion') && css.includes('focus-visible'),
  'Motion accessibility or keyboard focus styling missing');
assert.ok(!css.includes('min-height:min(560px'), 'Old oversize home panel still present');
assert.ok(config.app.windows[0].height <= 550, 'Default window too tall for compact home');
assert.ok(js.includes("const recoveryNeeded = ['active', 'degraded', 'error', 'unknown'].includes(systemDnsState);"), 'Failure state must expose DNS recovery');
assert.ok(js.includes("recoveryNeeded ? 'Disable' : 'Enable'"), 'Recovery button must send Disable');
assert.ok(js.includes("'Восстановить DNS'"), 'One-button recovery label missing');

// Exercise the tray transition and rollback status without a Windows service.
const nodes = new Map();
const listeners = new Map();
const timers = [];
const runtimeDocument = {
  visibilityState: 'visible',
  getElementById(id) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        textContent: '',
        setAttribute() {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {}
      });
    }
    return nodes.get(id);
  },
  querySelector() { return this.getElementById('placeholder'); },
  querySelectorAll() { return []; },
  addEventListener(name, listener) { listeners.set(name, listener); },
  removeEventListener(name) { listeners.delete(name); }
};
const probe = { ipv4: { ok: true }, ipv6: { ok: true } };
let report = { dns_state: 'disabled', recovery_state: 'clear', probe, configured: true };
let statusReads = 0;
const context = createContext({
  document: runtimeDocument,
  window: {
    addEventListener() {},
    setTimeout(callback) { timers.push(callback); },
    __TAURI__: { core: { async invoke(name) {
      if (name === 'launch_system_dns_action') return 'Accepted';
      assert.equal(name, 'system_dns_status');
      statusReads += 1;
      return report;
    } } }
  }
});
runInContext(js, context);
await flush();
const enable = runInContext("requestSystemDns('Enable')", context);
await flush();
runtimeDocument.visibilityState = 'hidden';
timers.shift()();
await flush();
assert.equal(statusReads, 1, 'No status polling while hidden in the tray');
assert.equal(runInContext('systemDnsPendingAction', context), 'Enable', 'The command remains pending');
report = { ...report, dns_state: 'active', recovery_state: 'pending' };
runtimeDocument.visibilityState = 'visible';
listeners.get('visibilitychange')();
await flush();
timers.shift()();
await enable;
assert.equal(nodes.get('home-summary').textContent, 'Включён');
assert.equal(nodes.get('system-dns-message').textContent, '', 'An active backup is not a rollback failure');
report = { ...report, dns_state: 'disabled' };
await runInContext('refreshSystemDns()', context);
assert.equal(nodes.get('system-dns-state').textContent, 'Нужен откат');

console.log('UI contract OK: ' + ids.length + ' DOM IDs; single control on main page');
