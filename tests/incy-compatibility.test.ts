import test from 'node:test';
import assert from 'node:assert/strict';
import {stageIncyPrivateDnsCompatibility} from '../packages/dns-policy/src/incy-compatibility.ts';

const profile={
  Name:'MNEBYVPN original',
  GlobalProxy:'true',
  RemoteDNSType:'DoH',
  RemoteDNSDomain:'https://cloudflare-dns.com/dns-query',
  RemoteDNSIP:'1.1.1.1',
  DomesticDNSType:'DoH',
  DomesticDNSDomain:'https://dns.google/dns-query',
  DomesticDNSIP:'8.8.8.8',
  FakeDNS:'false',
  DirectSites:['geosite:ru'],
  DirectIp:['geoip:ru'],
  ProxySites:['gemini.google.com','aistudio.google.com'],
  ProxyIp:[],
  BlockSites:['geosite:category-ads-all'],
};

test('stage minimal Private DNS route without touching VPN or DNS policy',()=>{
  const before=JSON.stringify(profile);
  const result=stageIncyPrivateDnsCompatibility(profile);
  assert.equal(result.verifiedOnDevice,false);
  assert.equal(result.profile.GlobalProxy,profile.GlobalProxy);
  assert.equal(result.profile.RemoteDNSType,profile.RemoteDNSType);
  assert.equal(result.profile.RemoteDNSDomain,profile.RemoteDNSDomain);
  assert.equal(result.profile.DomesticDNSDomain,profile.DomesticDNSDomain);
  assert.equal(result.profile.FakeDNS,profile.FakeDNS);
  assert.deepEqual(result.profile.ProxySites,profile.ProxySites);
  assert.deepEqual(result.profile.BlockSites,profile.BlockSites);
  assert.deepEqual(result.profile.DirectSites,['geosite:ru','dns.mnebyvpn.site']);
  assert.deepEqual(result.profile.DirectIp,['geoip:ru','89.125.90.101/32']);
  assert.equal(JSON.stringify(profile),before);
  assert.equal(result.changes.length,2);
});
test('idempotent re-stage has no duplicate rules and no diff',()=>{
  const once=stageIncyPrivateDnsCompatibility(profile);
  const twice=stageIncyPrivateDnsCompatibility(once.profile);
  assert.deepEqual(twice.profile,once.profile);
  assert.deepEqual(twice.changes,[]);
});
test('reject full Xray config and ambiguous existing ProxyIp rules',()=>{
  assert.throws(()=>stageIncyPrivateDnsCompatibility({...profile,inbounds:[],outbounds:[]}),/Unsupported/);
  assert.throws(()=>stageIncyPrivateDnsCompatibility({...profile,ProxyIp:['0.0.0.0/0']}),/conflicting/);
  assert.throws(()=>stageIncyPrivateDnsCompatibility({...profile,ProxySites:['dns.mnebyvpn.site']}),/conflicting/);
});
test('does not silently produce default full/direct routing',()=>{
  assert.throws(()=>stageIncyPrivateDnsCompatibility({...profile,GlobalProxy:undefined}),/GlobalProxy/);
  assert.throws(()=>stageIncyPrivateDnsCompatibility({...profile,GlobalProxy:'false',ProxySites:'all'}),/Invalid/);
});
test('invalid prototype keys are rejected without pollution',()=>{
  const profileWithOwnProto=JSON.parse('{"Name":"foo","GlobalProxy":"true","__proto__":{"polluted":true}}');
  assert.throws(()=>stageIncyPrivateDnsCompatibility(profileWithOwnProto),/Unsafe|Unsupported/);
  assert.equal(({} as {polluted?:boolean}).polluted,undefined);
});
