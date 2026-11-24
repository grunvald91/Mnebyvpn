// Dependency-free check of frontend IDs, commands and main test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
assert.ok(js.includes('async function requestSystemDns(action)'));
const css = readFileSync(new URL('styles.css', base), 'utf8');
const service = readFileSync(new URL('../service/src/main.rs', base), 'utf8');
const ipc = readFileSync(new URL('../ipc/src/windows.rs', base), 'utf8');
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', base), 'utf8'));
const buttons = [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
for (const id of buttons) {
  assert.ok(js.includes("get('" + id + "').addEventListener"),
    'Visible button missing listener: ' + id);
}
assert.ok(html.includes('<details class="fold" id="maintenance-panel">'),
  'Maintenance should be collapsed by default');
assert.ok(!html.includes('id="repair-system-dns"'), 'Duplicate restore button');
assert.ok(!html.includes('id="settings-tray"'), 'Duplicate tray button');
assert.ok(!html.includes('id="refresh-system-dns"'), 'Redundant settings refresh button');
assert.ok(!html.includes('Маршрутизация Smart DNS'), 'Remove never-checked diagnostic row');
assert.ok(!html.includes('Сохранить и включить'), 'Settings must never enable DNS');
assert.ok(html.includes('>Сохранить</button>'), 'Settings Save affordance missing');
assert.ok(html.includes('id="profile-saved"') && html.includes('id="edit-profile"'),
  'Configured profile must have a concise edit affordance');
assert.ok(js.includes("action: 'Save', host"), 'Save must use a non-activating IPC command');
assert.ok(js.includes("if (action === 'Enable' && !systemDnsConfigured)"),
  'Home must require a saved profile before enabling');
assert.ok(!js.includes('Сохранить и включить'), 'Obsolete first-run instruction');
assert.ok(js.includes("const state = await refreshSystemDns();"),
  'Recovery result must be checked rather than showing unconditional success');
assert.ok(ipc.includes('ConfigureOnly(String)'), 'Save-only opcode missing');
assert.ok(service.includes('ControlRequest::ConfigureOnly(host) => save_profile(host, false)'),
  'Saving an address must persist with DNS disabled');
assert.ok(rust.includes('ControlRequest::ConfigureOnly(hostname.to_ascii_lowercase())'),
  'Save must not send ConfigureAndEnable');
assert.ok(css.includes('prefers-reduced-motion') && css.includes('focus-visible'),
  'Motion accessibility or keyboard focus styling missing');
assert.ok(!css.includes('min-height:min(560px'), 'Old oversize home panel still present');
assert.ok(config.app.windows[0].height <= 550, 'Default window too tall for compact home');
assert.ok(js.includes("const recoveryNeeded = ['active', 'error', 'unknown'].includes(systemDnsState);"), 'Failure state must expose DNS recovery');
assert.ok(js.includes("recoveryNeeded ? 'Disable' : 'Enable'"), 'Recovery button must send Disable');
assert.ok(js.includes("'Восстановить DNS'"), 'One-button recovery label missing');
console.log('UI contract OK: ' + ids.length + ' DOM IDs; single control on main page');
