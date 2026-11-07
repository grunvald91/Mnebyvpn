import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL('../ops/smart-dns-poc/' + path, import.meta.url), 'utf8');

test('Smart DNS test container stays loopback-only and away from production ports', () => {
  const compose = read('compose.yaml');
  assert.match(compose, /127\.0\.0\.1:1853:8853\/tcp/);
  assert.doesNotMatch(compose, /(?:0\.0\.0\.0:|["']853:853|["']443:443|["']53:53)/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:\s*\["ALL"\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /restart:\s*["']no["']/);
  assert.match(compose, /image:\s*coredns\/coredns:1\.15\.0/);
  assert.doesNotMatch(compose, /:latest/);
});

test('PoC speaks TLS both ways with upstream identity checking and no rewriting', () => {
  const corefile = read('Corefile');
  assert.match(corefile, /tls:\/\/\.:8853\s*\{/);
  assert.match(corefile, /tls\s+\/certs\/dns\.test\.invalid\.crt\s+\/certs\/dns\.test\.invalid\.key/);
  assert.match(corefile, /forward\s+\.\s+tls:\/\/9\.9\.9\.9\s*\{/);
  assert.match(corefile, /tls_servername\s+dns\.quad9\.net/);
  assert.match(corefile, /max_concurrent\s+64/);
  assert.doesNotMatch(corefile, /^\s*(?:rewrite|template|hosts|log|errors)\s+/m);
});
