import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DNS_PAID_REQUIRED_ATTESTATIONS,paidSmartDnsCheckoutReady}
  from '../packages/billing/src/dns-paid-release.ts';

const verified=Object.fromEntries(DNS_PAID_REQUIRED_ATTESTATIONS.map(x=>[x,'yes']));

test('paid DNS release remains closed without ANY one independent approval',()=>{
  assert.equal(paidSmartDnsCheckoutReady({},true,true,true),false);
  assert.equal(paidSmartDnsCheckoutReady(verified,false,true,true),false);
  assert.equal(paidSmartDnsCheckoutReady(verified,true,false,true),false);
  assert.equal(paidSmartDnsCheckoutReady(verified,true,true,false),false);
  for(const flag of DNS_PAID_REQUIRED_ATTESTATIONS){
    const absent={...verified};
    delete absent[flag];
    assert.equal(paidSmartDnsCheckoutReady(absent,true,true,true),false,flag);
  }
  assert.equal(paidSmartDnsCheckoutReady(verified,true,true,true),true);
});

test('network/provider and client gates reject draft words like ready/true/1',()=>{
  for(const bad of ['true','1','ready','PASS','YES','no','']){
    const env={...verified,WEB_DNS_PAID_PROVIDER_PREFIX_ROUTED_E2E:bad};
    assert.equal(paidSmartDnsCheckoutReady(env,true,true,true),false,bad);
  }
});

test('backend hides DNS plans and denies DNS paid checkout/trial before money is taken',()=>{
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.match(server,/const dnsPaidCheckoutEnabled = paidSmartDnsCheckoutReady/);
  assert.match(server,/publishedPlans=dnsPaidCheckoutEnabled\?plans:plans\.filter\(p=>p\.product==='vpn'\)/);
  assert.match(server,/trialOffers: dnsPaidCheckoutEnabled\?trialOffers:trialOffers\.filter\(p=>p==='vpn'\)/);
  assert.match(server,/plan&&plan\.product!=='vpn'/);
  assert.match(server,/const plan=await store\.plan\(body\.planId\)/);
  assert.match(server,/DNS_PAID_NOT_READY/);
  const checkout=server.indexOf("url.pathname === '/api/checkout'");
  const denied=server.indexOf("if(!dnsPaidCheckoutEnabled){",checkout);
  const payment=server.indexOf("prepareWebsiteProdamusCheckout(",checkout);
  assert.ok(checkout<denied && denied<payment,'billing guard must precede payment order');
});

test('production billing store blocks DNS product for BOTH website and Telegram',()=>{
  const store=readFileSync(new URL('../packages/billing/src/store.ts',import.meta.url),'utf8');
  assert.match(store,/process\.env\.MNEBYVPN_ENV==='production' && p\.product!=='vpn'/);
  assert.match(store,/throw new Error\('DNS_PAID_NOT_READY'\)/);
  assert.match(store,/process\.env\.MNEBYVPN_ENV==='production' && product!=='vpn'/);
  assert.match(store,/return \{status:'UNAVAILABLE'\}/);
});
