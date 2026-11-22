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
assert.equal((home.match(/<button\\b/g) || []).length, 1, 'Home must have exactly one control button');
assert.ok(home.includes('id="toggle-system-dns"'), 'Missing one-button DNS control');
assert.ok(!home.includes('Тестовый режим'), 'Home must not pretend to be a test screen');
assert.ok(!home.includes('run-all-tests'), 'Connection tests belong in Settings');
assert.ok(settings.includes('id="dot-host"'), 'DoT profile belongs in Settings');
assert.ok(settings.includes('id="run-all-tests"'), 'Diagnostics must remain available');
assert.ok(!settings.includes('id="enable-system-dns"'), 'No duplicate enable button in Settings');
assert.ok(!settings.includes('id="disable-system-dns"'), 'No duplicate disable button in Settings');
assert.ok(js.includes('async function runAllTests()'));
assert.ok(js.includes('async function requestSystemDns(action)'));
assert.ok(js.includes("systemDnsState === 'active' ? 'Disable' : 'Enable'"));
console.log('UI contract OK: ' + ids.length + ' DOM IDs; single control on main page');
