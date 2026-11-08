import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  createLoginChallenge, consumeLoginChallenge, issueSession, readSession,
  issueAccountSession, readAccountSession,
  csrfForSession, isValidCsrf, verifyTelegramIdToken,
} from '../packages/web/src/security.ts';
import { publicEntitlement } from '../packages/web/src/dashboard.ts';
import {normalizeLoginEmail,otpHash,otpMatches,deliverEmailOtp} from '../packages/web/src/email-otp.ts';

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
test('provider-specific PKCE and account session cannot be reused across identities',()=>{
  const tg=createLoginChallenge(secret,now,'telegram');
  const ya=createLoginChallenge(secret,now,'yandex');
  assert.ok(consumeLoginChallenge(tg.cookie,tg.state,secret,now,'telegram'));
  assert.equal(consumeLoginChallenge(tg.cookie,tg.state,secret,now,'yandex'),null);
  assert.equal(consumeLoginChallenge(ya.cookie,ya.state,secret,now,'telegram'),null);
  const id='11111111-1111-4111-8111-111111111111';
  const raw=issueAccountSession(id,secret,now);
  assert.equal(readAccountSession(raw,secret,now+60_000),id);
  assert.equal(readAccountSession(raw,secret,now+12*60*60_000+1),null);
  assert.equal(readAccountSession(raw+'x',secret,now),null);
  assert.throws(()=>issueAccountSession('not-an-uuid',secret,now));
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
  const links=html.match(/https:\/\/t\.me\/MNEBYVPN_bot/g)||[];
  assert.ok(links.length>=2);
  assert.match(html,/id="trial-hero-button"[^>]*aria-hidden="true"/);
  assert.match(html,/id="guest-trial-card"/);
  assert.match(html,/@MNEBYVPN_bot/);
  assert.match(html,/rel="noopener noreferrer"/);
});

test('web cabinet reserves OIDC login for explicit BotFather integration',async()=>{
  const {readFileSync}=await import('node:fs');
  const backend=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(backend,/WEB_TELEGRAM_OIDC_ENABLED/);
  assert.match(backend,/TELEGRAM_LOGIN_NOT_READY/);
  assert.match(backend,/WEB_EMAIL_LOGIN_ENABLED/);
  assert.match(backend,/loginEnabled.*checkoutEnabled|checkoutEnabled.*loginEnabled/s);
  assert.match(ui,/syncLoginLinks/);
  assert.match(ui,/cabinet-login-link/);
});

test('mobile checkout remains compact while DNS purchases stay gated until release',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../apps/web/public/site.css',import.meta.url),'utf8');
  const client=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(html,/Выберите VPN или Smart DNS/);
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
  assert.match(html,/<h1>VPN и Smart DNS<span> без лишних шагов<\/span><\/h1>/);
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
  assert.match(html,/Тип доступа<\/span><strong id="selected-quota">Входит/);
  assert.doesNotMatch(html,/Не входит/);
  assert.doesNotMatch(client,/Перейти к оплате →|Не входит/);
  assert.match(css,/\.hero-art,\.hero-actions,\.hero-notes,\.features\{display:none\}/);
  assert.match(client,/const inDevelopment=state\.product!=='vpn'/);
  assert.match(client,/if\(state\.product!=='vpn'\|\|!plan/);
  assert.match(client,/Способ оплаты выбирается на защищённой странице/);
});


test('trial is behind email OTP or Telegram OAuth, never an anonymous cookie',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const backend=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const skin=readFileSync(new URL('../apps/web/public/neo.css',import.meta.url),'utf8');
  assert.match(html,/id="trial-hero-button"[^>]*aria-hidden="true"/);
  assert.match(html,/id="trial-button"/);
  assert.match(html,/id="email-start-form"/);
  assert.match(html,/id="cabinet-login-link"/);
  assert.match(html,/id="guest-trial-card"/);
  assert.match(html,/Скачайте приложение/);
  assert.match(html,/Добавьте подписку/);
  assert.match(html,/Импорт из URL/);
  assert.match(skin,/\.hero\{overflow:visible;min-height:100px/);
  assert.match(backend,/AUTH_REQUIRED_FOR_TRIAL/);
  assert.doesNotMatch(backend,/guestWorker\(/);
  assert.match(backend,/await authorized\(req\)/);
  assert.match(backend,/grantTrial\(auth.accountId/);
  assert.match(backend,/issueAccountSession\(/);
  assert.match(backend,/issueSubscriptionLinkForAccount\(/);
  assert.match(backend,/\/api\/auth\/email\/start/);
  assert.match(backend,/\/auth\/callback/);
  assert.doesNotMatch(backend,/process\.env\.YANDEX_OAUTH_CLIENT_SECRET/);
  assert.doesNotMatch(ui,/api\/guest\/trial/);
  assert.doesNotMatch(ui,/api\/guest\/status/);
  assert.match(ui,/api\/vpn\/subscription/);
});


test('email OTP is normalized, constant-time-checked and delivered only via signed ServGo HTTPS gateway',async()=>{
  assert.equal(normalizeLoginEmail('  User+trial@Example.COM  '),'user+trial@example.com');
  for(const invalid of ['not-an-email','bad\r\nBcc:fake@example.org','a@b','a@@example.org',null]){
    assert.equal(normalizeLoginEmail(invalid),null);
  }
  const email='user@example.org',code='003021';
  const hashed=otpHash(email,code,secret);
  assert.match(hashed,/^[a-f0-9]{64}$/);
  assert.equal(otpMatches(hashed,email,code,secret),true);
  assert.equal(otpMatches(hashed,email,'003022',secret),false);
  assert.equal(otpMatches(hashed,email,'003021','wrong-secret'),false);
  let dispatched=false;
  const fake=async(url:unknown,opts?:RequestInit)=>{
    assert.equal(url,'https://servgo.ru/api/auth/mnebyvpn/email-code');
    assert.equal(opts?.method,'POST');
    assert.equal(opts?.redirect,'error');
    const headers=opts?.headers as Record<string,string>;
    const payload=JSON.parse(opts?.body as string);
    assert.deepEqual(payload,{email,code});
    assert.match(headers['X-Mnebyvpn-Signature'],/^[a-f0-9]{64}$/);
    assert.equal(headers['Content-Type'],'application/json');
    dispatched=true;
    return {status:200} as Response;
  };
  assert.equal(await deliverEmailOtp(email,code,secret,fake as typeof fetch),true);
  assert.equal(dispatched,true);
  await assert.rejects(deliverEmailOtp('bad@example.org\r\nBcc:malicious',code,secret,
    fake as typeof fetch));
});
test('website requires email sign-in, explicit Telegram link, and a per-browser trial claim',async()=>{
  const {readFileSync}=await import('node:fs');
  const backend=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const billing=readFileSync(new URL('../packages/billing/src/store.ts',import.meta.url),'utf8');
  assert.match(html,/mnebyvpn@servgo\.ru/);
  assert.match(html,/id="email-start-form"/);
  assert.match(html,/id="email-verify-form"/);
  assert.match(html,/id="link-telegram"/);
  assert.doesNotMatch(html,/id="yandex-login-link"/);
  assert.match(backend,/WEB_EMAIL_LOGIN_ENABLED/);
  assert.match(backend,/\/api\/auth\/email\/start/);
  assert.match(backend,/\/api\/auth\/email\/verify/);
  assert.match(backend,/BROWSER_VERIFICATION_REQUIRED/);
  assert.match(backend,/createHash\('sha256'\)\.update\('trial-device-v1:'/);
  assert.match(backend,/SELECT id FROM accounts WHERE telegram_user_id=\$1/);
  assert.match(billing,/DEVICE_ALREADY_USED/);
  assert.match(ui,/EMAIL_RATE_LIMIT/);
});

test('website keeps support form accessible without Telegram login and brands it MNEBYVPN',async()=>{
  const {readFileSync}=await import('node:fs');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const js=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(html,/id="support-form"/);
  assert.match(html,/href="#contact-support"/);
  assert.match(server,/url\.pathname==='\/api\/support'/);
  assert.match(server,/url\.pathname==='\/api\/support\/status'/);
  assert.match(js,/submitSupport/);
  assert.doesNotMatch(html,/Мне бы VPN|МНЕ БЫ|MnebyVPN/);
  assert.match(html,/<title>MNEBYVPN/);
});

test('production email login uses canonical narrowly scoped auth DB, not public brochure DB',async()=>{
  const backend=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.match(backend,/WEB_AUTH_DATABASE_URL/);
  assert.match(backend,/sameCanonicalPostgresDb\(authDbUrl,subscriptionDbUrl\)/);
  assert.match(backend,/beginEmailCode\(authPool,/);
  assert.match(backend,/verifyEmailCode\(authPool,/);
  assert.match(backend,/loadDashboard\(authPool,/);
  assert.match(backend,/FROM website_sessions s JOIN accounts a/);
  assert.match(backend,/const store = new PgBillingStore\(billingPool\)/);
  assert.match(backend,/WEB_BILLING_DATABASE_URL/);
  assert.match(backend,/sameCanonicalPostgresDb\(billingDbUrl/);
});

test('checkout provides actionable errors and a manual Prodamus link if WebView navigation fails',()=>{
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const backend=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.match(html,/id="checkout-error"[^>]*role="alert"/);
  assert.match(html,/id="payment-link"/);
  assert.match(ui,/showPaymentLink\(target\.toString\(\)\)/);
  assert.match(ui,/checkoutError\(message\)/);
  assert.match(ui,/state\.requestId \|\|= newRequestId\(\)/);
  assert.match(backend,/code:'PAYMENT_PROVIDER_UNAVAILABLE'/);
  assert.match(backend,/code:'CHECKOUT_RETRY_LIMIT'/);
  assert.match(backend,/MNEBYVPN_CHECKOUT_DB_ERROR_SQLSTATE_/);
});
