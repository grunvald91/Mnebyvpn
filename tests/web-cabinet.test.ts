import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  createLoginChallenge, consumeLoginChallenge, issueSession, readSession,
  csrfForSession, isValidCsrf, verifyTelegramIdToken,
} from '../packages/web/src/security.ts';
import { publicEntitlement } from '../packages/web/src/dashboard.ts';

const secret = 'offline-web-session-secret-with-over-32-characters';
const now = Date.UTC(2026,10,6,9,0,0);
test('OIDC PKCE state is one-browser-bound and expires in five minutes',()=>{
  const a=createLoginChallenge(secret,now);
  const b=createLoginChallenge(secret,now);
  assert.match(a.state,/^[A-Za-z0-9_-]{32}$/);
  assert.match(a.codeChallenge,/^[A-Za-z0-9_-]{43}$/);
  const verifier=consumeLoginChallenge(a.cookie,a.state,secret,now+1000);
  assert.ok(verifier);
  assert.equal(consumeLoginChallenge(a.cookie,b.state,secret,now+1000),null);
  assert.equal(consumeLoginChallenge(a.cookie,a.state,secret,now+300_001),null);
  assert.equal(consumeLoginChallenge(a.cookie,a.state,secret,now-1),null);
  assert.equal(consumeLoginChallenge(a.cookie+'x',a.state,secret,now),null);
});
test('authenticated session and CSRF are signed, time-bounded and account-specific',()=>{
  const s=issueSession(121232343,secret,now);
  assert.equal(readSession(s,secret,now+1000),121232343);
  assert.equal(readSession(s,secret,now+12*60*60_000+1),null);
  assert.equal(readSession(s,secret,now-61_000),null);
  assert.equal(readSession(s.slice(0,-1)+(s.endsWith('a')?'b':'a'),secret,now),null);
  assert.equal(isValidCsrf(csrfForSession(s,secret),s,secret),true);
  assert.equal(isValidCsrf(csrfForSession(s,secret),issueSession(2,secret,now),secret),false);
});
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-telegram-oidc',alg:'RS256',use:'sig'};
function issueToken(claimOverrides:Record<string,unknown>={},signingKey=privateKey):string {
  const h=Buffer.from(JSON.stringify({typ:'JWT',alg:'RS256',kid:jwk.kid})).toString('base64url');
  const p=Buffer.from(JSON.stringify({
    iss:'https://oauth.telegram.org',aud:'123456',sub:'opaque-subject',
    id:121232343,iat:Math.floor(now/1000)-10,exp:Math.floor(now/1000)+3600,
    ...claimOverrides,
  })).toString('base64url');
  const s=sign('RSA-SHA256',Buffer.from(h+'.'+p),signingKey).toString('base64url');
  return h+'.'+p+'.'+s;
}
test('Telegram OIDC requires trusted RSA key, correct issuer, audience, expiry and signature',()=>{
  assert.equal(verifyTelegramIdToken(issueToken(),{keys:[jwk]},'123456',now),121232343);
  assert.throws(()=>verifyTelegramIdToken(issueToken({aud:'elsewhere'}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken({iss:'https://attacker.invalid'}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken({exp:Math.floor(now/1000)-1}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken({id:'1'}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken(),{keys:[]},'123456',now));
  const other=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>verifyTelegramIdToken(issueToken({},other.privateKey),{keys:[jwk]},'123456',now));
});
const dnsRow={
  id:'11111111-1111-4111-8111-111111111111',
  product:'smart_dns' as const,state:'ACTIVE',starts_at:new Date(now-86400_000),
  expires_at:new Date(now+86400_000),
  quota_limit_bytes:String(10*1024*1024*1024),quota_used_bytes:String(4*1024*1024*1024),
  quota_state:'AVAILABLE',
};
test('DNS usage is NOT presented as accurate before real ingress metering is verified',()=>{
  const hidden=publicEntitlement(dnsRow,false,now);
  assert.equal(hidden.quotaLimitBytes,dnsRow.quota_limit_bytes);
  assert.equal(hidden.quotaUsedBytes,null);
  assert.equal(hidden.quotaRemainingBytes,null);
  assert.equal(hidden.meteringVerified,false);
  const measured=publicEntitlement(dnsRow,true,now);
  assert.equal(measured.quotaUsedBytes,dnsRow.quota_used_bytes);
  assert.equal(measured.quotaRemainingBytes,String(6*1024*1024*1024));
  assert.equal(measured.secondsRemaining,86400);
});
test('unactivated trial never shows a fabricated expiry or quota amount',()=>{
  const trial=publicEntitlement({...dnsRow,state:'PAID_PENDING_PROVISIONING',
    starts_at:null,expires_at:null,quota_used_bytes:'0'},false,now);
  assert.equal(trial.expiresAt,null);
  assert.equal(trial.secondsRemaining,null);
  assert.equal(trial.quotaUsedBytes,null);
});

test('public website references the configured Telegram bot in navigation, hero and footer',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const links=html.match(/https:\/\/t\.me\/MnebyVPN_bot/g)||[];
  assert.ok(links.length>=4);
  assert.match(html,/id="trial-hero-button"/);
  assert.match(html,/id="guest-trial-card"/);
  assert.match(html,/@MnebyVPN_bot/);
  assert.match(html,/rel="noopener noreferrer"/);
});

test('web cabinet reserves OIDC login for explicit BotFather integration',async()=>{
  const {readFileSync}=await import('node:fs');
  const backend=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(backend,/WEB_TELEGRAM_OIDC_ENABLED/);
  assert.match(backend,/TELEGRAM_LOGIN_NOT_READY/);
  assert.match(backend,/loginEnabled.*checkoutEnabled|checkoutEnabled.*loginEnabled/s);
  assert.match(ui,/syncLoginLinks/);
  assert.match(ui,/cabinet-login-link/);
});

test('mobile VPN purchase is compact and unlaunched features are clearly unavailable',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../apps/web/public/site.css',import.meta.url),'utf8');
  const client=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(html,/Выберите тариф VPN/);
  assert.match(html,/Обычный интернет при ограничениях мобильной сети/);
  assert.match(html,/Планируем отдельный режим для ситуаций/);
  assert.match(html,/data-product="smart_dns"[^>]*disabled/);
  assert.match(html,/data-product="bundle"[^>]*disabled/);
  assert.match(css,/VPN-first mobile checkout/);
  const neoCss=readFileSync(new URL('../apps/web/public/neo.css',import.meta.url),'utf8');
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.match(html,/href="\/neo\.css"/);
  assert.match(server,/url\.pathname === '\/neo\.css'/);
  assert.match(neoCss,/\.portal-art/);
  assert.match(neoCss,/@media\(max-width:680px\)/);
  assert.match(html,/<h1>VPN без<span> лишних шагов<\/span><\/h1>/);
  assert.match(html,/<p class="hero-lead">/);
  assert.match(neoCss,/\.hero\{display:block;position:relative;min-height:82px;padding:10px 0 5px/);
  assert.match(neoCss,/\.portal-avatar/);
  assert.match(html,/<img class="portal-avatar" src="\/brand-avatar\.webp"/);
  assert.match(html,/<img class="brand-avatar" src="\/brand-avatar\.webp"/);
  assert.match(html,/rel="icon" type="image\/webp" href="\/brand-avatar\.webp"/);
  assert.match(server,/url\.pathname === '\/brand-avatar\.webp'/);
  assert.match(server,/brandAvatar, 'image\/webp'/);
  const avatar=readFileSync(new URL('../apps/web/public/brand-avatar.webp',import.meta.url));
  assert.equal(avatar.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(avatar.subarray(8,12).toString('ascii'),'WEBP');
  assert.ok(avatar.byteLength > 1000 && avatar.byteLength < 20000);
  assert.match(html,/В тариф входит/);
  assert.match(html,/VPN-подключение<\/span><strong id="selected-quota">Входит/);
  assert.doesNotMatch(html,/Не входит|↗|→/);
  assert.doesNotMatch(client,/Перейти к оплате →|Не входит/);
  assert.match(css,/\.hero-art,\.hero-actions,\.hero-notes,\.features\{display:none\}/);
  assert.match(client,/const inDevelopment=state\.product!=='vpn'/);
  assert.match(client,/if\(state\.product!=='vpn'\|\|!plan/);
  assert.match(client,/Способ оплаты выбирается на защищённой странице/);
});


test('mobile hero trial CTA stays hidden while tariff-card trial remains visible',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const skin=readFileSync(new URL('../apps/web/public/neo.css',import.meta.url),'utf8');
  const base=readFileSync(new URL('../apps/web/public/site.css',import.meta.url),'utf8');
  assert.match(html,/id="trial-hero-button"[^>]*aria-hidden="true"/);
  assert.match(html,/id="trial-button"/);
  assert.match(base,/\.hero-art,\.hero-actions,\.hero-notes,\.features\{display:none\}/);
  const mobileFix=skin.slice(skin.lastIndexOf('Mobile trial CTA:'));
  assert.ok(mobileFix.includes('@media (max-width: 680px)'));
  assert.match(mobileFix,/\.hero \.hero-actions\s*\{\s*display:\s*none/);
  assert.match(mobileFix,/#trial-button\.trial-button\s*\{\s*display:\s*flex/);
  assert.match(mobileFix,/min-height:\s*44px/);
  // neo.css loads after site.css: the last mobile rule overrides both hide rules.
  assert.ok(html.indexOf('href="/site.css"')<html.indexOf('href="/neo.css"'));
});

test('website keeps support form accessible without Telegram login and brands it MnebyVPN',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const js=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(html,/id="support-form"/);
  assert.match(html,/href="#contact-support"/);
  assert.match(server,/url\.pathname==='\/api\/support'/);
  assert.match(server,/url\.pathname==='\/api\/support\/status'/);
  assert.match(js,/submitSupport/);
  assert.doesNotMatch(html,/Мне бы VPN|МНЕ БЫ/);
  assert.match(html,/<title>MnebyVPN/);
});
