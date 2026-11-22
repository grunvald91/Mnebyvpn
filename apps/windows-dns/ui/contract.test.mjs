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
assert.ok(html.includes('id="run-all-tests"'));
assert.ok(html.includes('id="dot-host"'));
assert.ok(html.includes('Тестовый режим'));
assert.ok(js.includes('async function runAllTests()'));
console.log('UI contract OK: ' + ids.length + ' DOM IDs');
