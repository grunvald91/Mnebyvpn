import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DNS_QUERY_LIMIT_PER_30D,
  PERSONAL_DOT_LABEL_LENGTH,
  makePersonalDoTIdentity,
  parsePersonalDoTHostname,
} from '../packages/dns-policy/src/personal-dot-identity.ts';

test('compact DoT bearer label is 12 base36 characters, not a URL',()=>{
  const p=makePersonalDoTIdentity(undefined,new Uint8Array(16));
  assert.equal(p.label,'0'.repeat(12));
  assert.equal(p.hostname,p.label+'.dns.mnebyvpn.site');
  assert.match(p.tokenSha256,/^[a-f0-9]{64}$/);
  assert.equal(p.queryLimitPer30d,DEFAULT_DNS_QUERY_LIMIT_PER_30D);
  assert.equal(PERSONAL_DOT_LABEL_LENGTH,12);
  assert.equal(parsePersonalDoTHostname(p.hostname),p.label);
  assert.equal(p.hostname.includes('://'),false);
  assert.equal(p.hostname.includes('/'),false);
});

test('random 128-bit source produces independent compact identifiers',()=>{
  const a=makePersonalDoTIdentity(undefined,new Uint8Array(16));
  const b=makePersonalDoTIdentity(undefined,Uint8Array.from({length:16},()=>1));
  assert.notEqual(a.label,b.label);
  assert.notEqual(a.tokenSha256,b.tokenSha256);
  assert.equal(makePersonalDoTIdentity().label.length,12);
  for(let i=0;i<100;i++)assert.match(makePersonalDoTIdentity().label,/^[a-z0-9]{12}$/);
});

test('test entropy is never padded, truncated or silently substituted',()=>{
  assert.throws(()=>makePersonalDoTIdentity('example.org'));
  assert.throws(()=>makePersonalDoTIdentity(undefined,new Uint8Array(15)));
  assert.throws(()=>makePersonalDoTIdentity(undefined,new Uint8Array(17)));
  assert.throws(()=>makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(255)));
  assert.throws(()=>makePersonalDoTIdentity(undefined,'unsafe' as never));
});

test('parse only exact DNS zone, exact label length and legal case-insensitive hostname',()=>{
  const good=makePersonalDoTIdentity(undefined,new Uint8Array(16)).hostname;
  assert.equal(parsePersonalDoTHostname(good.toUpperCase()),'0'.repeat(12));
  assert.equal(parsePersonalDoTHostname(good+'.'),'0'.repeat(12));
  for(const bad of [
    'dns.mnebyvpn.site',
    'https://'+good,
    good+':853',
    good+'/dns-query',
    'evil.'+good,
    good+'.evil.com',
    '*.dns.mnebyvpn.site',
    'a'.repeat(11)+'.dns.mnebyvpn.site',
    'a'.repeat(13)+'.dns.mnebyvpn.site',
    'a'.repeat(12)+'.dns.mnebyvpn.site@evil.org',
    'a'.repeat(12)+'.dns.mnebyvpn.site:853',
    'a'.repeat(12)+'.dns.mnebyvpn.site\\\\evil',
  ])assert.equal(parsePersonalDoTHostname(bad),null,bad);
  assert.equal(parsePersonalDoTHostname(good,'example.org'),null);
});

test('one million counts DNS requests, not user devices or video connections',()=>{
  assert.equal(DEFAULT_DNS_QUERY_LIMIT_PER_30D,1_000_000);
});
