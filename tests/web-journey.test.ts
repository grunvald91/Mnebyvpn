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
  // journey-history is intentionally generated on first account render.
  existing.add('journey-history');
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
  assert.match(journey,/sessionStorage\.setItem\('mnebyvpn-pending-trial','1'\)/);
  assert.match(journey,/setView\('trial-auth',true\)/);
  assert.doesNotMatch(journey,/if\(!state\.loggedIn\)\{\s*await claimTrial\(\)/);
  assert.match(journey,/view==='setup'&&!state\.guestSubscriptionUrl/);
  assert.match(journey,/lastSetupAttempt\.set\(target\.id,Date\.now\(\)\)/);
});

test('real Earth backdrop is explicitly served by the production HTTP router',()=>{
  assert.match(index,/src="\/world-neon\.webp"/);
  assert.match(server,/readFile\(new URL\('\.\.\/public\/world-neon\.webp'/);
  assert.match(server,/url\.pathname === '\/world-neon\.webp'/);
  assert.match(server,/send\(res, 200, worldNeon, 'image\/webp'\)/);
  const image=readFileSync(new URL('../apps/web/public/world-neon.webp',import.meta.url));
  assert.ok(image.byteLength>10000);
  assert.equal(image.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(image.subarray(8,12).toString('ascii'),'WEBP');
});


test('native checkout preview requires confirmed account and never captures card details',()=>{
  for(const id of ['journey-order','journey-order-pay','journey-order-price','journey-order-period',
    'journey-order-email','journey-order-link','journey-order-error'])
    assert.match(index,new RegExp('id="'+id+'"'));
  assert.match(journey,/setView\('checkout',true\)/);
  assert.match(journey,/if\(el\('journey-order-pay'\)\.disabled\)return;/);
  assert.match(journey,/const verified=state\.loggedIn&&lastAccount\?\.identity\?\.email/);
  assert.doesNotMatch(index,/type="(?:password|tel)"[^>]*name="card/);
  assert.doesNotMatch(index,/Prodamus/i);
  assert.doesNotMatch(journey,/Prodamus/i);
});
test('real-world neon halo is visible without replacing the original globe',()=>{
  assert.match(index,/class="journey-world-halo"/);
  assert.match(css,/journey-world-halo/);
  assert.match(index,/src="\/world-neon\.webp"/);
});


test('original background videos are bundled and served only by the public web route',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/id="bgv"/);
  assert.match(art,/\['\/bg3\.webm\?v=6e816d6e','video\/webm/);
  assert.match(art,/\['\/bg3\.mp4\?v=30d2f12d','video\/mp4/);
  assert.match(art,/connection\.saveData/);
  assert.match(art,/if\(!sc\|\|!v\|\|R/);
  assert.doesNotMatch(art,/\/_blob\//);
  assert.match(server,/media-src 'self'/);
  assert.match(art,/class="legal-links"/);
  assert.match(art,/\.pill\{flex:0 0 auto;white-space:nowrap/);
  assert.match(art,/\.hero\{min-height:clamp\(165px,23svh,210px\)/);
  assert.match(art,/const rate=\.85;/);

  for (const [name,signature,mime] of [
    ['bg3.webm','1a45dfa3','video/webm'],
    ['bg3.mp4','0000002066747970','video/mp4']
  ] as const) {
    const bytes=readFileSync(new URL('../apps/web/public/'+name,import.meta.url));
    assert.ok(bytes.byteLength>100_000 && bytes.byteLength<300_000);
    assert.equal(bytes.subarray(0,signature.length/2).toString('hex'),signature);
    assert.ok(server.includes("'/" + name + "'"));
    assert.ok(server.includes("'"+mime+"'"));
  }
});


test('Smart DNS is preview-only while VPN checkout and trial remain server-authoritative',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/class="plans plans-vpn"/);
  assert.match(art,/class="plans plans-dns"/);
  assert.match(art,/id="dns-info-dialog"/);
  assert.match(art,/id="trial-options"/);
  assert.match(art,/id="trial-dns"/);
  for(const [days,price] of [[15,120],[30,199],[60,379],[90,549]]){
    assert.ok(art.includes('data-d="'+days+'" data-p="'+price+' ₽"'),
      'Missing proposed DNS tariff '+days+'d');
  }
  for(const service of ['YouTube','ChatGPT','Gemini','Claude','Antigravity','Grok','TikTok']){
    assert.ok(art.includes(service));
  }
  assert.match(art,/if\(isDns\)\{/);
  assert.match(art,/button\.disabled=true;/);
  assert.match(art,/if\(activeProduct==='vpn'&&!button\.disabled\)send\('buy'\)/);
  assert.match(art,/trialDnsStatus\.hidden=false/);
  assert.match(art,/send\('trial'\)/);
  assert.doesNotMatch(art,/send\('trial-dns'\)/);
  assert.match(art,/выдача индивидуальной ссылки Smart DNS ещё разрабатывается/i);
});
