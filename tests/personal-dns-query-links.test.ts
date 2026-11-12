import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {
  DNS_MONTHLY_QUERY_ALLOWANCE,personalDnsLinks,
  credentialDigestFromDoT,credentialDigestFromDoH,
  countableProxiedQuestion,queryQuotaView,
} from '../packages/dns-policy/src/personal-dns-links.ts';

const id='c0c0c0c0-0000-4000-8000-000000000020';
const another='c0c0c0c0-0000-4000-8000-000000000021';
const key=Buffer.alloc(32,7);
const link=personalDnsLinks(id,1,key);

test('one million is a lookup budget, not claimed to be TCP connections',()=>{
  assert.equal(DNS_MONTHLY_QUERY_ALLOWANCE,1_000_000);
  const v=queryQuotaView(999999,1_000_000,new Date('2026-12-12T00:00:00Z'));
  assert.equal(v.metric,'proxied_dns_queries');
  assert.equal(v.remaining,1);
  assert.equal(v.exhausted,false);
  assert.equal(queryQuotaView(1_000_000,1_000_000,new Date()).renewalAction,'renew_dns_package');
});

test('one personal hostname works in Android Private DNS; DoH uses a personal path',()=>{
  assert.match(link.dotHostname,/^p-[a-z2-7]{32}\.dns\.mnebyvpn\.site$/);
  assert.match(link.dohUrl,/^https:\/\/dns\.mnebyvpn\.site\/dns-query\/p-[a-z2-7]{32}$/);
  assert.equal(credentialDigestFromDoT(link.dotHostname),link.tokenDigest);
  assert.equal(credentialDigestFromDoT(link.dotHostname.toUpperCase()+'.'),link.tokenDigest);
  assert.equal(credentialDigestFromDoH(new URL(link.dohUrl).pathname),link.tokenDigest);
  assert.equal(link.tokenDigest.length,64);
});

test('link is stable on same entitlement and revision, rotates to a new secret identity',()=>{
  assert.deepEqual(personalDnsLinks(id,1,key),link);
  assert.notEqual(personalDnsLinks(id,2,key).tokenDigest,link.tokenDigest);
  assert.notEqual(personalDnsLinks(another,1,key).tokenDigest,link.tokenDigest);
  assert.notEqual(personalDnsLinks(id,1,randomBytes(32)).tokenDigest,link.tokenDigest);
  assert.throws(()=>personalDnsLinks(id,0,key));
  assert.throws(()=>personalDnsLinks(id,1,Buffer.alloc(8)));
  assert.throws(()=>personalDnsLinks('not-a-uuid',1,key));
});

test('DoT and DoH credential formats cannot accept wildcards, injections or other hosts',()=>{
  for(const d of [
    'dns.mnebyvpn.site','*.dns.mnebyvpn.site',
    'p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.other.invalid',
    'x.p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dns.mnebyvpn.site',
    'p-aaaaaaa.invalid.dns.mnebyvpn.site',
  ])assert.equal(credentialDigestFromDoT(d),null,d);
  for(const p of [
    '/dns-query','/dns-query/p-not-valid',
    '/dns-query/p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/more',
    '/dns-query/p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%2Fmore',
    '/other/p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '/dns-query/p-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ])assert.equal(credentialDigestFromDoH(p),null,p);
});

test('only exact proxied A answers consume allowance; ordinary websites stay direct',()=>{
  const routes=new Set(['claude.ai','gemini.google.com','www.tiktok.com']);
  assert.equal(countableProxiedQuestion('claude.ai',1,routes),true);
  assert.equal(countableProxiedQuestion('CLAUDE.AI.',1,routes),true);
  assert.equal(countableProxiedQuestion('www.tiktok.com',1,routes),true);
  assert.equal(countableProxiedQuestion('yandex.ru',1,routes),false);
  assert.equal(countableProxiedQuestion('claude.ai',28,routes),false);
  assert.equal(countableProxiedQuestion('claude.ai',65,routes),false);
  assert.equal(countableProxiedQuestion('evilclaude.ai',1,routes),false);
  assert.equal(countableProxiedQuestion('sub.claude.ai',1,routes),false);
  assert.equal(countableProxiedQuestion('claude.ai.evil.invalid',1,routes),false);
});

test('counter never overflows and fails on contradictory balance',()=>{
  const end=new Date('2027-01-01T00:00:00Z');
  for(const [used,limit] of [[-1,10],[0,-1],[Number.MAX_SAFE_INTEGER+1,1000000]]){
    assert.throws(()=>queryQuotaView(used,limit,end));
  }
  assert.equal(queryQuotaView(0,1_000_000,end).remaining,1_000_000);
  const afterRefund=queryQuotaView(1_000_001,1_000_000,end);
  assert.equal(afterRefund.used,1_000_001);
  assert.equal(afterRefund.remaining,0);
  assert.equal(afterRefund.renewalAction,'renew_dns_package');
  assert.equal(queryQuotaView(5,1_000_000,new Date('2020-01-01')).expired,true);
});
