import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const index=file('apps/web/public/index.html');
const journey=file('apps/web/public/journey.js');
const css=file('apps/web/public/journey.css');
const server=file('apps/web/src/server.ts');
const yookassa=file('packages/billing/src/yookassa.ts');

test('journey assets are valid JavaScript and served by the same-origin website',()=>{
  const check=spawnSync(process.execPath,['--check',fileURLToPath(new URL('../apps/web/public/journey.js',import.meta.url))],{encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);
  for(const path of ['journey.css','journey.js']){
    assert.ok(index.includes('/'+path));
    assert.ok(server.includes("'/'"+path+"'")||server.includes("'\/".concat(path,"'")));
  }
  assert.match(css,/body\.journey-active/);
});
test('public HTML bootstrap and in-place retry preserve live DB authority',()=>{
  const app=file('apps/web/public/app.js');
  const art=file('apps/web/public/landing-art.html');
  assert.match(server,/publicCatalog\(\)/);
  assert.match(server,/name="mnebyvpn-public-catalog"/);
  assert.match(server,/Buffer\.from\(JSON\.stringify\(payload\),'utf8'\)/);
  assert.match(app,/function embeddedPublicCatalog\(\)/);
  assert.match(app,/function applyPublicCatalog\(data\)/);
  assert.match(app,/window\.addEventListener\('online'/);
  assert.match(art,/send\('refresh'\)/);
  assert.match(journey,/if\(msg\.type==='refresh'\)\{void loadCatalog\(\);return;\}/);
  assert.doesNotMatch(server,/staticVpnPrices|mockVpnPrices/);
});
test('main storefront preserves 3-in-1 products, idempotent selection and cabinet fallback',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/href="\/#account" target="_top"/);
  assert.match(art,/if\(ready\)\{e\.preventDefault\(\);send\('account'\);\}/);
  assert.match(art,/send\('select',\{product,days\}\)/);
  assert.match(server,/url\.pathname === '\/api\/auth\/options'/);
  assert.match(file('apps/web/public/app.js'),/Promise\.all\(\[loadLoginOptions\(\),loadCatalog\(\),refresh\(\)\]\)/);
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
  assert.match(art,/\.trial-options\{/);
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
test('illustrated storefront keeps responsive geometry and payment fine print in a dialog',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/id="payment-info-open"/);
  assert.match(art,/id="payment-info-dialog"/);
  assert.match(art,/\.hero\{position:relative;padding:/);
  assert.match(art,/footer\{margin-top:auto/);
  assert.doesNotMatch(art,/<p class="note"/);
  assert.doesNotMatch(art,/<p class="note2"/);
});
test('payment helper stays non-modal and video has no manual replay button',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/id="payment-info-dialog" class="payment-popover" role="dialog" aria-modal="false"/);
  assert.match(art,/\.payment-popover\[hidden\]/);
  assert.match(art,/autoplayAllowed=!R&&!navigator\.connection\?\.saveData/);
  assert.doesNotMatch(art,/video-retry|Включить фон|optedIn/);
  assert.doesNotMatch(art,/paymentInfoDialog\.showModal/);
});
test('trial footer includes all landing links without seller INN or full name',()=>{
  const art=file('apps/web/public/landing-art.html');
  for(const phrase of ['Оферта','Соглашение','Обработка данных']){
    assert.match(index,new RegExp(phrase));
    assert.match(art,new RegExp(phrase));
  }
  assert.doesNotMatch(index,/Кунавина Анна Александровна|745214444705|footer-seller/);
  assert.doesNotMatch(art,/Кунавина Анна Александровна|745214444705|seller-details/);
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
test('native routes share bottom-anchored footer and centered content without forced clipping',()=>{
  const html=file('apps/web/public/index.html');
  const css=file('apps/web/public/journey.css');
  assert.match(html,/href="\/#plans" class="brand" aria-label="Мне бы VPN \(MNEBYVPN\) — на главную к тарифам"/);
  assert.match(css,/\/\* Unified geometry for every native screen/);
  assert.match(css,/min-height:100dvh!important/);
  assert.match(css,/justify-content:safe center!important/);
  assert.match(css,/body\.journey-active:not\(\[data-journey-view="plans"\]\) > \.footer\{/);
  assert.match(css,/margin-top:auto!important/);
  for(const cls of ['journey-setup','journey-order','journey-payment-intro','journey-trial-auth','account-section'])
    assert.match(css,new RegExp('> main > \\.'+cls));
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/grid-template-columns:minmax\(0,1fr\)!important/);
  const visual=file('tests/visual-journey-preview.mjs');
  assert.match(visual,/async function auditNativeGeometry\(/);
  assert.match(visual,/NATIVE_LAYOUT_/);
  assert.match(visual,/\[\[320,700\],\[390,700\],\[390,1000\],\[1280,800\]\]/);
  assert.match(visual,/shouldFitViewport/);
  assert.match(css,/@media\(max-height:820px\)/);
  assert.match(css,/@media\(max-width:680px\) and \(max-height:760px\)/);
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
  assert.match(server,/url\.pathname === '\/api\/orders\/verify'/);
  assert.match(yookassa,/returnUrl\.searchParams\.set\('order', order\.id\)/);
});
test('checkout email comes only from authenticated session',()=>{
  assert.match(server,/email:auth\.email/);
  assert.match(server,/VERIFIED_EMAIL_REQUIRED/);
  assert.match(yookassa,/body\.receipt = receipt;/);
  assert.match(yookassa,/customer: \{ email: customerEmail \}/);
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
  assert.match(server,/sendStatic\(req,res,worldNeon,'image\/webp'\)/);
  const image=readFileSync(new URL('../apps/web/public/world-neon.webp',import.meta.url));
  assert.ok(image.byteLength>10000);
  assert.equal(image.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(image.subarray(8,12).toString('ascii'),'WEBP');
});


test('native checkout preview supports inline tariff changes and never captures card details',()=>{
  for(const id of ['journey-order','journey-order-switch','journey-order-pay','journey-order-price',
    'journey-order-period','journey-order-email','journey-order-link','journey-order-error'])
    assert.match(index,new RegExp('id="'+id+'"'));
  for(const p of ['vpn','bundle','smart_dns'])
    assert.match(index,new RegExp('data-order-product="'+p+'"'));
  for(const d of [15,30,60,90])
    assert.match(index,new RegExp('data-order-days="'+d+'"'));
  assert.match(journey,/setView\('checkout',true\)/);
  assert.match(journey,/if\(el\('journey-order-pay'\)\.disabled\)return;/);
  assert.match(journey,/const verified=state\.loggedIn&&lastAccount\?\.identity\?\.email/);
  assert.doesNotMatch(index,/type="(?:password|tel)"[^>]*name="card/);
  assert.doesNotMatch(index,/Prodamus/i);
  assert.doesNotMatch(journey,/Prodamus/i);
});
test('post-purchase setup includes VPN app guides, Smart DNS Apple/DoT and WebSocket proxy',()=>{
  const appJs=file('apps/web/public/app.js');
  for(const id of ['journey-app-note','journey-download-alt','journey-vpn-guide',
    'journey-dns-proxy-setup','journey-dns-setup-slot','journey-proxy-setup-slot'])
    assert.match(index,new RegExp('id="'+id+'"'));
  assert.match(appJs,/ensurePersonalDnsCredentials/);
  assert.match(appJs,/ensureProxyCredentials/);
  assert.match(appJs,/tg:.*webproxy/);
  assert.match(appJs,/MNEBYDNS-Apple\.mobileconfig/);
});
test('real-world neon halo is visible without replacing the original globe',()=>{
  assert.match(index,/class="journey-world-halo"/);
  assert.match(css,/journey-world-halo/);
  assert.match(index,/src="\/world-neon\.webp"/);
});


test('mobile and desktop background videos are bundled and served only by the public web route',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/id="bgv"/);
  assert.match(art,/id="bgv-desktop"/);
  assert.match(art,/\['\/bg3\.webm\?v=6e816d6e','video\/webm/);
  assert.match(art,/\['\/bg3\.mp4\?v=30d2f12d','video\/mp4/);
  assert.match(art,/\['\/bg-desktop\.webm\?v=1','video\/webm/);
  assert.match(art,/\['\/bg-desktop\.mp4\?v=1','video\/mp4/);
  assert.match(art,/\/bg-desktop-poster\.webp/);
  assert.match(art,/connection\?\.saveData/);
  assert.match(art,/autoplayAllowed=!R&&!navigator\.connection\?\.saveData/);
  assert.doesNotMatch(art,/video-retry/);
  assert.doesNotMatch(art,/\/_blob\//);
  assert.match(server,/media-src 'self'/);
  assert.match(art,/class="legal-links"/);
  assert.match(art,/playbackRate=\.85/);

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
  const deskMp4=readFileSync(new URL('../apps/web/public/bg-desktop.mp4',import.meta.url));
  const deskWebm=readFileSync(new URL('../apps/web/public/bg-desktop.webm',import.meta.url));
  const deskPoster=readFileSync(new URL('../apps/web/public/bg-desktop-poster.webp',import.meta.url));
  assert.ok(deskMp4.byteLength>200_000 && deskMp4.byteLength<1_500_000);
  assert.ok(deskWebm.byteLength>200_000 && deskWebm.byteLength<2_000_000);
  assert.equal(deskWebm.subarray(0,4).toString('hex'),'1a45dfa3');
  assert.equal(deskPoster.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(deskPoster.subarray(8,12).toString('ascii'),'WEBP');
  assert.ok(server.includes("'/bg-desktop.mp4'") && server.includes("'/bg-desktop.webm'") && server.includes("'/bg-desktop-poster.webp'"));
});


test('desktop and mobile storefront present all 3 RUB products without Stars or Prodamus',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/class="desk-grid"/);
  assert.match(art,/data-card-product="vpn"/);
  assert.match(art,/data-card-product="bundle"/);
  assert.match(art,/data-card-product="smart_dns"/);
  assert.match(art,/class="desk-durations"/);
  assert.match(art,/id="dns-info-dialog"/);
  assert.match(art,/id="trial-options"/);
  assert.match(art,/id="trial-dns"/);
  assert.match(art,/isDesktopViewport/);
  const appJs=file('apps/web/public/app.js');
  assert.match(appJs,/res\?\.state==='PAID'/);
  assert.match(appJs,/applyInitialSelectionFromUrl/);
  assert.doesNotMatch(art,/YouTube/i);
  for(const service of ['ChatGPT','Gemini','Claude','Antigravity','Grok','TikTok','Telegram','и другие']){
    assert.ok(art.includes(service));
  }
  assert.doesNotMatch(art,/РФ|Россий|Росси/i);
  assert.match(art,/правил сервиса/);
  assert.match(art,/сетевыми ограничениями|сетевых ограничениях/);
  assert.doesNotMatch(art,/⭐|Prodamus|payform/i);
  assert.doesNotMatch(art,/id="old-bundle"|>499 ₽</);
  assert.match(art,/133 ₽\/устройство/);
  assert.match(art,/send\('trial'\)/);
  assert.doesNotMatch(art,/send\('trial-dns'\)/);
  assert.match(art,/выдаются только после подтверждённой оплаты/i);
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
  assert.match(art,/mobVideo\.addEventListener\('playing'/);
  assert.match(art,/document\.addEventListener\('DOMContentLoaded',syncPlayback/);
  assert.doesNotMatch(art,/id="video-retry"|Включить фон/);
  assert.match(art,/retry\.addEventListener\('click'/);
  assert.match(art,/type!=='visual'/);
  assert.doesNotMatch(art,/hardwareConcurrency/);
  assert.doesNotMatch(art,/effectiveType/);
  assert.match(art,/\.bg::before\{[^}]*opacity:\.28\}/);
  assert.match(art,/\.scene\.vid #fx/);
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


test('mobile storefront downloads only the background media matching its own CSS viewport',()=>{
  const art=file('apps/web/public/landing-art.html');
  assert.match(art,/const isDesktopViewport=\(\)=>mqlDesk\.matches/);
  assert.doesNotMatch(art,/window\.parent\.innerWidth/);
  assert.match(art,/let hostActive=window\.parent===window/);
  assert.match(art,/class="desk-poster" data-src="\/bg-desktop-poster\.webp"/);
  assert.doesNotMatch(art,/class="desk-poster" src=/);
  assert.doesNotMatch(art,/id="bgv-desktop"[^>]*poster=/);
  assert.match(art,/if\(isDesk&&hostActive\)ensureDeskPoster\(\)/);
  assert.match(index,/class="journey-world-image"[^>]*loading="lazy" fetchpriority="low"/);
});

test('static website resources revalidate with ETag while personalized responses stay no-store',()=>{
  assert.match(server,/function sendStatic\(req: IncomingMessage, res: ServerResponse/);
  assert.match(server,/const cache='public, no-cache, must-revalidate'/);
  assert.match(server,/req\.headers\['if-none-match'\]/);
  assert.match(server,/send\(res,304,'',type,cache\)/);
  assert.match(server,/function sendArt\(req: IncomingMessage, res: ServerResponse\)/);
  assert.match(server,/res\.setHeader\('X-Robots-Tag','noindex, follow'\)/);
  assert.match(server,/function send\(res: ServerResponse, status: number, body: string\|Buffer, type = 'application\/json; charset=utf-8', cacheControl = 'no-store'\)/);
  for(const name of ['css','neoCss','journeyCss','js','journeyJs','aboutJs','brandAvatar','worldNeon'])
    assert.ok(server.includes('sendStatic(req,res,'+name+','),name);
  // Authenticated/personalized HTML must never pass through a public cache.
  assert.match(server,/send\(res, 200, page, 'text\/html; charset=utf-8'\)/);
});

test('marketing copy avoids unmeasured performance and universal unblocking guarantees',()=>{
  const home=file('apps/web/public/index.html');
  const art=file('apps/web/public/landing-art.html');
  const joined=home+'\n'+art;
  for(const unsupported of [
    '90% времени','всегда на связи','для любых блокировок',
    'работает без любых ограничений','вне зависимости от любых ограничений',
    'без тормозов','без конфликтов','Доступ ко всему, где есть ограничения',
    'сами не пускают подключения из вашего региона','Оплата в 1 клик',
    'ВЫГОДНЕЕ · 3 В 1'
  ]) assert.ok(!joined.includes(unsupported),'unsupported claim: '+unsupported);
  for(const required of ['зависит от сети','зависит от устройства','правил сервиса'])
    assert.ok(joined.includes(required),required);
});

test('promotional duration discounts are computed from live per-product minor-unit prices',()=>{
  const art=file('apps/web/public/landing-art.html');
  const js=file('apps/web/public/journey.js');
  assert.match(js,/priceMinor:Number\.isSafeInteger\(plan\?\.rubMinor\)\?plan\.rubMinor:null/);
  assert.match(art,/data-discount-days="60" hidden/);
  assert.match(art,/data-discount-days="90" hidden/);
  assert.match(art,/const base=findOffer\(selectedProduct,30\)/);
  assert.match(art,/offerMinor\/baseline/);
  assert.match(art,/badge\.hidden=!show/);
  assert.doesNotMatch(art,/−12%|−21%|<em>ХИТ<\/em>/);
});
