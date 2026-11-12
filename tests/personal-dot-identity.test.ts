import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DNS_QUERY_LIMIT_PER_30D,
  encodeBase32,
  makePersonalDoTIdentity,
  parsePersonalDoTHostname,
} from '../packages/dns-policy/src/personal-dot-identity.ts';

test('personal DoT identity uses 128 bits of randomness and is an Android hostname, not URL',()=>{
  const profile=makePersonalDoTIdentity(undefined,new Uint8Array(16));
  assert.equal(profile.label,'d'+'a'.repeat(26));
  assert.equal(profile.hostname,profile.label+'.dns.mnebyvpn.site');
  assert.match(profile.tokenSha256,/^[a-f0-9]{64}$/);
  assert.equal(profile.queryLimitPer30d,DEFAULT_DNS_QUERY_LIMIT_PER_30D);
  assert.equal(parsePersonalDoTHostname(profile.hostname),profile.label);
  assert.equal(profile.hostname.includes('://'),false);
  assert.equal(profile.hostname.includes('/'),false);
});

test('different entropy creates distinct labels and does not encode user or device ID',()=>{
  const a=makePersonalDoTIdentity(undefined,new Uint8Array(16));
  const b=makePersonalDoTIdentity(undefined,Uint8Array.from({length:16},()=>1));
  assert.notEqual(a.label,b.label);
  assert.notEqual(a.tokenSha256,b.tokenSha256);
  assert.equal(encodeBase32(new Uint8Array(16)).length,26);
  assert.equal(makePersonalDoTIdentity().label.length,27);
});

test('unapproved domains, invalid lengths and malformed SNI cannot issue identities',()=>{
  assert.throws(()=>makePersonalDoTIdentity('example.org'));
  assert.throws(()=>makePersonalDoTIdentity(undefined,new Uint8Array(15)));
  assert.throws(()=>makePersonalDoTIdentity(undefined,new Uint8Array(17)));
  const good=makePersonalDoTIdentity(undefined,new Uint8Array(16)).hostname;
  for(const bad of [
    'dns.mnebyvpn.site',
    'https://'+good,
    good+':853',
    good+'/dns-query',
    'evil.'+good,
    good+'.evil.com',
    good.toUpperCase(),
    '*.dns.mnebyvpn.site',
    'd'+'a'.repeat(25)+'.dns.mnebyvpn.site',
    'd'+'1'.repeat(26)+'.dns.mnebyvpn.site',
  ])assert.equal(parsePersonalDoTHostname(bad),null,bad);
});

test('fixed default query budget is a DNS message count, not device binding',()=>{
  assert.equal(DEFAULT_DNS_QUERY_LIMIT_PER_30D,1000000);
  assert.equal(
    parsePersonalDoTHostname('d'+'a'.repeat(26)+'.dns.mnebyvpn.site'),
    'd'+'a'.repeat(26),
  );
});
