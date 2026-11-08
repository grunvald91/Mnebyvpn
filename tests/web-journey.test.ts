import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const file=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const index=file('apps/web/public/index.html');
const journey=file('apps/web/public/journey.js');
const css=file('apps/web/public/journey.css');
const server=file('apps/web/src/server.ts');
const prodamus=file('packages/billing/src/prodamus.ts');

test('journey assets are valid JavaScript and served by the same-origin website',()=>{
  const check=spawnSync(process.execPath,['--check',new URL('../apps/web/public/journey.js',import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);
  for(const path of ['journey.css','journey.js']){
    assert.ok(index.includes('/'+path));
    assert.ok(server.includes("'/'"+path+"'")||server.includes("'\/".concat(path,"'")));
  }
  assert.match(css,/body\.journey-active/);
});
test('storefront has exactly four tariff actions and preserves legacy APIs',()=>{
  for(const days of [15,30,60,90])
    assert.match(index,new RegExp('data-journey-days="'+days+'"'));
  assert.match(index,/id="journey-buy"/);
  assert.match(index,/id="buy-button"/);
  assert.match(index,/id="journey-setup"/);
  assert.match(index,/id="guest-trial-card"/);
  assert.match(index,/id="account"/);
});
test('setup has all platform choices, installation gate and manual copy',()=>{
  for(const os of ['android','ios','windows','macos','linux'])
    assert.match(index,new RegExp('data-journey-platform="'+os+'"'));
  for(const id of ['journey-installed','journey-auto','journey-url','journey-copy'])
    assert.match(index,new RegExp('id="'+id+'"'));
  assert.match(journey,/safeSubscriptionUrl/);
});
test('browser return is only an order hint and never proof of payment',()=>{
  assert.match(journey,/Untrusted navigation is only a lookup hint/);
  assert.match(journey,/\/api\/me owns the actual order/);
  assert.match(server,/url\.pathname === '\/payment\/success'/);
  assert.match(prodamus,/success\.searchParams\.set\('order',order\.id\)/);
});
test('checkout email comes only from authenticated session',()=>{
  assert.match(server,/email:auth\.email/);
  assert.match(server,/VERIFIED_EMAIL_REQUIRED/);
  assert.match(prodamus,/customer_email: customerEmail/);
  assert.doesNotMatch(server,/customerEmail:\s*body\./);
});


test('all referenced journey element IDs exist in the real HTML',()=>{
  const referenced=[...journey.matchAll(/\bel\('([a-z][a-z0-9-]+)'\)/g)].map(x=>x[1]);
  const existing=new Set([...index.matchAll(/\bid="([a-z][a-z0-9-]+)"/g)].map(x=>x[1]));
  for(const name of referenced)assert.ok(existing.has(name),'Missing DOM node: '+name);
  assert.ok(existing.has('journey-payment-heading'));
  assert.ok(existing.has('journey-payment-to-account'));
  assert.ok(existing.has('journey-payment-link'));
});
test('payment return shows own server-confirmed order and auto-opens ACTIVE subscription',()=>{
  assert.match(journey,/Untrusted navigation is only a lookup hint/);
  assert.match(journey,/order\?\.state==='PAID'/);
  assert.match(journey,/autoSetupOrders\.add\(order\.id\)/);
  assert.match(journey,/loadSubscription\(entitlement\.id\)/);
  assert.match(journey,/paymentIntro\.hidden=next!=='payment'/);
  assert.match(journey,/originalShowPaymentLink\(url\)/);
});
test('trial flow preserves pending login and automatically opens activated access',()=>{
  assert.match(journey,/if\(!state\.loggedIn\)\{\s*await claimTrial\(\)/);
  assert.match(journey,/view==='setup'&&!state\.guestSubscriptionUrl/);
  assert.match(journey,/lastSetupAttempt\.set\(target\.id,Date\.now\(\)\)/);
});
