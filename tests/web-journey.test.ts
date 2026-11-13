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
test('trial screen groups header controls, compacts footer, and keeps VPN install gate',()=>{
  assert.match(index,/class="header-actions"/);
  assert.match(index,/id="journey-trial-auth"/);
  assert.match(css,/data-journey-view="trial-auth"\] \.header-inner/);
  assert.match(css,/data-journey-view="trial-auth"\] \.journey-trial-auth-card/);
  assert.match(css,/not\(\[data-journey-view="plans"\]\) \.footer-inner/);
  assert.match(css,/\.footer-links\{/);
  assert.match(css,/#journey-trial-telegram\[aria-disabled="true"\]/);
  assert.match(index,/id="journey-installed"/);
  assert.match(journey,/el\('journey-installed'\)\.addEventListener/);
});
test('free trial chooser replaces the existing strip without changing page height',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/class="trial-slot" id="trial-slot"/);
  assert.match(art,/class="trial-options" id="trial-options"/);
  assert.match(art,/class="trial-close" id="trial-close"/);
  assert.match(art,/\.trial-slot \.trial-options\{/);
  assert.match(art,/position:absolute;inset:0;z-index:3/);
  assert.match(art,/setTrialChooser\(trialOptions\.hidden\)/);
  assert.doesNotMatch(art,/trialOptions\.hidden=!trialOptions\.hidden/);
});
test('trial authorization matches main header and does not reserve room for disabled Telegram',()=>{
  assert.match(css,/data-journey-view="trial-auth"\] \.header\{/);
  assert.match(css,/border:0!important/);
  assert.match(css,/data-journey-view="trial-auth"\] \.header-inner\{/);
  assert.match(css,/data-journey-view="trial-auth"\] \.journey-trial-auth\{/);
  assert.match(journey,/method\.hidden=!enabled/);
  assert.match(journey,/pointer:coarse/);
});
test('illustrated storefront keeps lock clear and payment fine print in a dialog',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/id="payment-info-open"/);
  assert.match(art,/id="payment-info-dialog"/);
  assert.match(art,/\.hero\{min-height:clamp\(177px,calc\(63vw - 25px\),280px\)!important\}/);
  assert.match(art,/\.app>footer\{margin-top:auto!important/);
  assert.doesNotMatch(art,/<p class="note"/);
  assert.doesNotMatch(art,/<p class="note2"/);
});
test('payment helper is non-modal and video retry is user-initiated',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/id="payment-info-dialog" class="payment-popover" role="dialog" aria-modal="false"/);
  assert.match(art,/\.payment-popover\[hidden\],\.video-retry\[hidden\]/);
  assert.match(art,/id="video-retry" hidden/);
  assert.match(art,/dataSaver=Boolean\(navigator\.connection\?\.saveData\)/);
  assert.match(art,/retry\.addEventListener\('click'/);
  assert.doesNotMatch(art,/paymentInfoDialog\.showModal/);
});
test('trial footer includes all landing links and seller details',()=>{
  const art=file('apps/web/public/landing-art.html');
  for(const phrase of ['Оферта','Соглашение','Обработка данных','Кунавина Анна Александровна']){
    assert.match(index,new RegExp(phrase));
    assert.match(art,new RegExp(phrase));
  }
  assert.match(css,/data-journey-view="trial-auth"\] \.footer-seller\{/);
});
test('trial back arrow is an SVG centered within a centered control',()=>{
  const html=file('apps/web/public/index.html');
  const css=file('apps/web/public/journey.css');
  assert.match(html,/<span class="journey-back-icon"[^>]*><svg viewBox="0 0 20 20"/);
  assert.match(css,/journey-back-icon svg\{/);
  assert.match(css,/width:max-content;max-width:100%/);
  assert.match(css,/margin:6px auto 0/);
});
test('payment return is a compact status, never an automatic settlement or duplicate login',()=>{
  assert.match(index,/class="journey-payment-card"/);
  assert.match(index,/id="journey-payment-to-account"/);
  assert.match(css,/data-journey-view="payment"\] \.account-section\{/);
  assert.match(css,/display:none!important/);
  assert.match(journey,/function updatePaymentAction\(\)/);
  assert.match(journey,/Войти и проверить заказ/);
  assert.match(journey,/if\(next==='payment'\)updatePaymentAction\(\)/);
  assert.match(journey,/\/api\/me owns the actual order/);
});
test('device detection only preselects app and never bypasses install confirmation',()=>{
  assert.match(index,/id="journey-selected-platform"/);
  assert.match(index,/id="journey-platform-change"/);
  assert.match(index,/id="journey-platform-grid"[^>]*hidden/);
  assert.match(journey,/const platformNames=\{/);
  assert.match(journey,/grid\.hidden=!grid\.hidden/);
  assert.match(journey,/installed=false/);
  assert.match(journey,/installButton\.setAttribute\('aria-pressed',String\(installed\)\)/);
  assert.match(journey,/el\('journey-import-step'\)\.hidden=!installed/);
  assert.match(css,/#journey-platform-grid\[hidden\]/);
  assert.match(css,/#guest-trial-card\{display:none!important\}/);
});
test('mobile native header stays branded and toast stays clear of install controls',()=>{
  assert.match(css,/body\.journey-active:not\(\[data-journey-view="plans"\]\) \.header .brand-text\{/);
  assert.match(css,/display:inline!important/);
  assert.match(css,/body\.journey-active:not\(\[data-journey-view="plans"\]\) #toast:not\(\.hidden\)/);
  assert.match(file('apps/web/public/app.js'),/if\(!document\.body\?\.classList\?\.contains\('journey-active'\)\)/);
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
  assert.match(art,/connection\?\.saveData/);
  assert.match(art,/autoplayAllowed=!R&&!dataSaver/);
  assert.match(art,/if\(!scene\|\|!video\|\|!retry\)return/);
  assert.doesNotMatch(art,/\/_blob\//);
  assert.match(server,/media-src 'self'/);
  assert.match(art,/class="legal-links"/);
  assert.match(art,/\.pill\{flex:0 0 auto;white-space:nowrap/);
  assert.match(art,/\.hero\{min-height:clamp\(165px,23svh,210px\)/);
  assert.match(art,/video\.playbackRate=\.85;/);

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
  assert.match(art,/let vpnDays=15,vpnSelected=true,dnsDays=null/);
  assert.match(art,/setPressed\(el,vpnSelected&&days===vpnDays\)/);
  assert.match(art,/setPressed\(el,Number\(el\.dataset\.d\)===dnsDays\)/);
  assert.match(art,/dnsDays=dnsDays===day\?null:day/);
  assert.match(art,/if\(vpnSelected&&!button\.disabled\)send\('buy'\)/);
  assert.match(art,/Оформить только VPN/);
  assert.match(art,/trialDnsStatus\.hidden=false/);
  assert.match(art,/send\('trial'\)/);
  assert.doesNotMatch(art,/send\('trial-dns'\)/);
  assert.match(art,/выдача индивидуальной ссылки Smart DNS ещё разрабатывается/i);
});


test('foreground taps avoid continuous expensive canvas, gyroscope and SVG DOM loops',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.doesNotMatch(art,/requestAnimationFrame\(f\)/);
  assert.doesNotMatch(art,/deviceorientation/);
  assert.doesNotMatch(art,/for\(let i=0;i<110;i\+\+\)/);
  assert.doesNotMatch(art,/setInterval\(\(\)=>\{\s*const a=N/);
  assert.match(art,/backdrop-filter:none!important/);
  assert.match(art,/touch-action:manipulation/);
  assert.match(art,/class="dns-popover-tags"/);
  assert.match(art,/role="dialog" aria-modal="false" aria-labelledby="dns-modal-title" hidden/);
  assert.match(art,/id="dns-info-open"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(art,/<dialog class="dns-dialog" id="dns-info-dialog"/);
  assert.doesNotMatch(art,/Сервисы, для которых планируется и проверяется поддержка/);
});

test('storefront caches original 130KB Earth image separately and restores mobile video autoplay',()=>{
  const art=file('apps/web/public/landing-art.html');
  const image=readFileSync(new URL('../apps/web/public/landing-earth.webp',import.meta.url));
  assert.ok(art.length<60_000,'HTML must stay small: no base64 background in CSS');
  assert.ok(image.byteLength>100_000 && image.byteLength<180_000);
  assert.equal(image.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(image.subarray(8,12).toString('ascii'),'WEBP');
  assert.doesNotMatch(art,/data:image\/webp;base64,/);
  assert.match(art,/\/landing-earth\.webp/);
  assert.match(server,/landingEarth/);
  assert.match(server,/url\.pathname === '\/landing-earth\.webp'/);
  assert.match(art,/id="bgv"[^>]*autoplay muted loop playsinline/);
  assert.match(art,/video\.addEventListener\('playing'/);
  assert.match(art,/document\.addEventListener\('DOMContentLoaded',init/);
  assert.match(art,/retry\.addEventListener\('click'/);
  assert.match(art,/type!=='visual'/);
  assert.doesNotMatch(art,/hardwareConcurrency/);
  assert.doesNotMatch(art,/effectiveType/);
  assert.match(art,/\.bg::before\{animation:none!important;opacity:\.3\}/);
  assert.match(art,/\.bg>i\{display:none!important\}/);
  assert.match(art,/\.scene\.vid #fx/);
  assert.match(art,/@keyframes solar-breath/);
});
test('cabinet uses the same branded styling and pauses hidden landing video',()=>{
  const html=file('apps/web/public/index.html');
  const css=file('apps/web/public/journey.css');
  const journey=file('apps/web/public/journey.js');
  assert.match(html,/class="account-back-to-plans" href="#plans"/);
  assert.match(css,/Account is the same MNEBYVPN product/);
  assert.match(css,/data-journey-view="account"/);
  assert.match(css,/\/landing-earth\.webp/);
  assert.match(journey,/function syncVisual\(\)/);
  assert.match(journey,/type:'visual',active:view==='plans'/);
  assert.match(journey,/syncVisual\(\);/);
});
