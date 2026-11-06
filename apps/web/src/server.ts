/**
 * Independent website: Telegram OIDC login, read-only customer dashboard,
 * and gated external-web Prodamus checkout. NO deployment or live credentials.
 * Bind to loopback behind a separately hardened HTTPS reverse proxy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { PgBillingStore } from '../../../packages/billing/src/store.ts';
import {subscriptionOwner,subscriptionLink}
  from '../../../packages/provisioning/src/subscription-links.ts';
import {
  prepareWebsiteProdamusCheckout, type PayformLinkTransport,
} from '../../../packages/billing/src/website-checkout.ts';
import type { ProdamusConfig } from '../../../packages/billing/src/prodamus.ts';
import {
  consumeLoginChallenge, createLoginChallenge, csrfForSession, isValidCsrf,
  issueSession, readSession, verifyTelegramIdToken, type Jwks,
} from '../../../packages/web/src/security.ts';
import { loadDashboard } from '../../../packages/web/src/dashboard.ts';
import { parseProdamusFormData } from '../../../packages/billing/src/multipart.ts';
import { handleProdamusDelivery } from '../../../packages/billing/src/handlers.ts';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error('Missing configuration: ' + name);
  return v;
};
const base = new URL(required('WEB_BASE_URL'));
const offline = process.env.MNEBYVPN_ENV === 'offline-test';
if (!offline && process.env.MNEBYVPN_ENV !== 'production')
  throw new Error('MNEBYVPN_ENV must be offline-test or production');
if (!offline && (base.protocol !== 'https:' || process.env.WEB_RELEASE_APPROVED !== 'yes'))
  throw new Error('Production website requires HTTPS and explicit release approval');
if (offline && !['http:', 'https:'].includes(base.protocol))
  throw new Error('Unsupported offline origin');
if (base.pathname !== '/' || base.search || base.hash || base.username || base.password)
  throw new Error('WEB_BASE_URL must be a bare origin');
const publicOrigin = base.origin;
const sessionSecret = required('WEB_SESSION_SECRET');
if (sessionSecret.length < 32) throw new Error('WEB_SESSION_SECRET too short');
// A public informational site can be deployed before BotFather issues OIDC
// credentials. Login is unavailable until explicitly enabled with real keys.
const loginEnabled = process.env.WEB_TELEGRAM_OIDC_ENABLED === 'yes';
const clientId = process.env.TELEGRAM_OIDC_CLIENT_ID ?? '';
const clientSecret = process.env.TELEGRAM_OIDC_CLIENT_SECRET ?? '';
if (loginEnabled && (!/^[0-9]{5,20}$/.test(clientId) || clientSecret.length < 16))
  throw new Error('Invalid Telegram OIDC client configuration');

const tls = base.protocol === 'https:';
const sessionCookie = tls ? '__Host-mnebyvpn_session' : 'mnebyvpn_session';
const challengeCookie = tls ? '__Host-mnebyvpn_oidc' : 'mnebyvpn_oidc';
const networkVerified = process.env.WEB_NETWORK_PROVISIONING_VERIFIED === 'yes';
// Never stop receiving previously-created payment notifications merely
// because new sales were disabled. Both flags default to fail-closed.
const webhookEnabled = process.env.WEB_PRODAMUS_WEBHOOK_ENABLED === 'yes' &&
  process.env.WEB_PAYMENT_PROVIDER_TESTED === 'yes';
const checkoutEnabled = loginEnabled && webhookEnabled && networkVerified &&
  process.env.WEB_CHECKOUT_ENABLED === '1' &&
  process.env.WEB_LEGAL_PAGES_PUBLISHED === 'yes';
const trialEnabled = loginEnabled && networkVerified &&
  process.env.WEB_TRIAL_ENABLED === 'yes';
const meteringVerified = networkVerified && process.env.WEB_DNS_METERING_VERIFIED === 'yes';
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 5, connectionTimeoutMillis: 3000 });
const store = new PgBillingStore(pool);
let payform: ProdamusConfig | undefined;
if (webhookEnabled) {
  payform = {
    formUrl: required('PRODAMUS_FORM_URL'),
    notificationUrl: required('PRODAMUS_NOTIFICATION_URL'),
    successUrl: required('PRODAMUS_SUCCESS_URL'),
    returnUrl: required('PRODAMUS_RETURN_URL'),
    secret: required('PRODAMUS_SIGN_SECRET'),
  };
  if (new URL(payform.notificationUrl).toString() !== publicOrigin + '/webhooks/prodamus')
    throw new Error('Notification URL must target the website signed webhook route');
  const url = new URL(payform.formUrl);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !url.hostname.endsWith('.payform.ru')) throw new Error('Unsafe Prodamus merchant origin');
}

class MerchantTransport implements PayformLinkTransport {
  async getLink(signedUrl: string): Promise<string> {
    if (!payform) throw new Error('Prodamus is disabled');
    const target = new URL(signedUrl), merchant = new URL(payform.formUrl);
    if (target.origin !== merchant.origin || target.pathname !== merchant.pathname ||
        target.protocol !== 'https:') throw new Error('Unapproved merchant request');
    const response = await fetch(target, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) throw new Error('Merchant checkout unavailable');
    const data = await response.text();
    if (data.length > 2048) throw new Error('Merchant response too large');
    return data;
  }
}

const html = await readFile(new URL('../public/index.html', import.meta.url));
const css = await readFile(new URL('../public/site.css', import.meta.url));
const neoCss = await readFile(new URL('../public/neo.css', import.meta.url));
const brandAvatar = await readFile(new URL('../public/brand-avatar.webp', import.meta.url));
const js = await readFile(new URL('../public/app.js', import.meta.url));
const vpnInstallJs=await readFile(new URL('../public/vpn-install.js',import.meta.url));
const workerProfileToken=process.env.VPN_WORKER_PROFILE_TOKEN??'';
const policy = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "connect-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

function send(res: ServerResponse, status: number, body: string|Buffer, type = 'application/json; charset=utf-8') {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', policy);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.writeHead(status).end(body);
}
function json(res: ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data));
}
function redirect(res: ServerResponse, destination: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Location', destination);
  res.writeHead(303).end();
}
function cookie(req: IncomingMessage, key: string): string|undefined {
  const matches = (req.headers.cookie ?? '').split(';').map(v=>v.trim())
    .filter(v => v.startsWith(key + '='));
  if (matches.length !== 1) return undefined;
  return matches[0].slice(key.length + 1);
}
function setCookie(res: ServerResponse, name: string, value: string, maxAge: number) {
  res.appendHeader('Set-Cookie',
    name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax' +
    (tls ? '; Secure' : '') + '; Max-Age=' + maxAge);
}
const sessionHash = (raw:string):string =>
  createHash('sha256').update(raw).digest('hex');
async function authorized(req:IncomingMessage):Promise<{userId:number;raw:string}|null> {
  const raw=cookie(req,sessionCookie);
  const userId=readSession(raw,sessionSecret);
  if(!userId||!raw)return null;
  // Statelessly signed cookies alone are NOT enough for logout/revocation.
  const {rowCount}=await pool.query(`SELECT 1 FROM website_sessions s
    JOIN accounts a ON a.id=s.account_id
    WHERE s.token_sha256=$1 AND a.telegram_user_id=$2
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
    [sessionHash(raw),String(userId)]);
  return rowCount===1 ? {userId,raw} : null;
}
function csrfAllowed(req: IncomingMessage, raw: string): boolean {
  return req.headers.origin === publicOrigin &&
    isValidCsrf(req.headers['x-csrf-token'] as string|undefined, raw, sessionSecret) &&
    req.headers['content-type']?.startsWith('application/json') === true;
}
async function readPaymentBody(req: IncomingMessage): Promise<Buffer> {
  const chunks:Buffer[]=[]; let total=0;
  for await(const chunk of req){
    const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    total+=part.length;
    if(total>128*1024)throw new Error('Payment notification too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
async function bodyJson(req: IncomingMessage): Promise<Record<string,unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > 4096) throw new Error('Request too large');
    chunks.push(part);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object');
  return body as Record<string,unknown>;
}
async function readRemoteJson(url: string, init?: RequestInit): Promise<Record<string,any>> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(7500) });
  if (!response.ok) throw new Error('Telegram OIDC service unavailable');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 65_536) throw new Error('Oversized provider response');
  const txt = await response.text();
  if (txt.length > 65_536) throw new Error('Oversized provider response');
  const data: unknown = JSON.parse(txt);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider response');
  return data as Record<string,any>;
}
async function login(req: IncomingMessage, res: ServerResponse) {
  const challenge = createLoginChallenge(sessionSecret);
  setCookie(res, challengeCookie, challenge.cookie, 300);
  const oauth = new URL('https://oauth.telegram.org/auth');
  oauth.searchParams.set('client_id', clientId);
  oauth.searchParams.set('redirect_uri', publicOrigin + '/auth/callback');
  oauth.searchParams.set('response_type', 'code');
  oauth.searchParams.set('scope', 'openid profile');
  oauth.searchParams.set('state', challenge.state);
  oauth.searchParams.set('code_challenge', challenge.codeChallenge);
  oauth.searchParams.set('code_challenge_method', 'S256');
  redirect(res, oauth.toString());
}
async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const verifier = consumeLoginChallenge(
    cookie(req, challengeCookie), url.searchParams.get('state'), sessionSecret);
  setCookie(res, challengeCookie, '', 0);
  const code = url.searchParams.get('code');
  if (!verifier || !code || code.length > 2048) {
    redirect(res, '/?login=failed'); return;
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code, redirect_uri: publicOrigin + '/auth/callback',
      client_id: clientId, code_verifier: verifier,
    });
    const token = await readRemoteJson('https://oauth.telegram.org/token', {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
      }, body: params.toString(),
    });
    if (typeof token.id_token !== 'string') throw new Error('Missing verified identity');
    const jwks = await readRemoteJson('https://oauth.telegram.org/.well-known/jwks.json');
    const telegramId = verifyTelegramIdToken(token.id_token, jwks as Jwks, clientId);
    // Link the existing Telegram bot's account, never accept accountId from a browser.
    const account=await pool.query(`INSERT INTO accounts(id,telegram_user_id) VALUES(gen_random_uuid(),$1)
      ON CONFLICT(telegram_user_id) DO UPDATE
      SET telegram_user_id=EXCLUDED.telegram_user_id RETURNING id`,
      [String(telegramId)]);
    const issuedAt=Date.now();
    const raw=issueSession(telegramId,sessionSecret,issuedAt);
    await pool.query(`INSERT INTO website_sessions(token_sha256,account_id,expires_at)
      VALUES($1,$2,$3)`,
      [sessionHash(raw),account.rows[0].id,new Date(issuedAt+12*60*60_000)]);
    setCookie(res, sessionCookie, raw, 12*60*60);
    redirect(res, '/#account');
  } catch {
    // Do not disclose OIDC codes, token claims or provider secrets.
    redirect(res, '/?login=failed');
  }
}

async function liveVpnProfile(owner:{
  telegramUserId:number;entitlementId:string;
}):Promise<string>{
  if(!/^[a-f0-9]{64}$/i.test(workerProfileToken))
    throw Error('Private VPN subscription bridge not deployed');
  const response=await fetch('http://127.0.0.1:8794/profile',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(6500),
    headers:{Authorization:'Bearer '+workerProfileToken,
      'Content-Type':'application/json'},
    body:JSON.stringify({telegramUserId:owner.telegramUserId,
      entitlementId:owner.entitlementId}),
  });
  if(!response.ok)throw Error('VPN node subscription unavailable');
  const result:unknown=await response.json();
  const profile=(result as {profile?:unknown})?.profile;
  if(typeof profile!=='string'||profile.length>4096||
     !/^vless:\/\/[0-9a-f-]{36}@cdn\.servgo\.ru:8443\?/.test(profile))
    throw Error('Unexpected VPN node configuration');
  return profile;
}
function installHtml(subUrl:string,client:'incy'|'karing'):string {
  // Both URL and client have already passed strict token/enum validation.
  const app=client==='incy'?'INCY':'Karing';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="referrer" content="no-referrer">'+
    '<title>Подключение «Мне бы VPN»</title>'+
    '<link rel="stylesheet" href="/neo.css"></head>'+
    '<body style="margin:0"><main data-client="'+client+'" data-sub="'+subUrl+'">'+
    '<h1>Подключить VPN в '+app+'</h1>'+
    '<p>Установите '+app+', затем нажмите кнопку ниже для импорта подписки.</p>'+
    '<p><button id="open-app" type="button">Открыть в '+app+'</button></p>'+
    '<p>Если приложение не открылось — скопируйте ссылку и вставьте её в '+app+
      ' через «Добавить подписку / Импорт из URL».</p>'+
    '<p><input id="subscription-url" aria-label="Ссылка подписки" value="'+subUrl+
      '" readonly><button id="copy-url" type="button">Копировать</button></p>'+
    '<p>Подписка персональная. Не пересылайте ссылку другим людям.</p>'+
    '<script src="/vpn-install.js" defer></script></main></body></html>';
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', publicOrigin);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    send(res, 200, html, 'text/html; charset=utf-8'); return;
  }
  if (req.method === 'GET' && url.pathname === '/site.css') {
    send(res, 200, css, 'text/css; charset=utf-8'); return;
  }
  if (req.method === 'GET' && url.pathname === '/neo.css') {
    send(res, 200, neoCss, 'text/css; charset=utf-8'); return;
  }
  if (req.method === 'GET' && url.pathname === '/brand-avatar.webp') {
    send(res, 200, brandAvatar, 'image/webp'); return;
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    send(res, 200, js, 'text/javascript; charset=utf-8'); return;
  }
  if(req.method==='GET' && url.pathname==='/vpn-install.js'){
    send(res,200,vpnInstallJs,'text/javascript; charset=utf-8');return;
  }
  const subMatch=/^\/sub\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if(req.method==='GET'&&subMatch){
    const owner=await subscriptionOwner(pool,subMatch[1]);
    if(!owner){json(res,404,{code:'SUBSCRIPTION_NOT_ACTIVE'});return;}
    try{
      const profile=await liveVpnProfile(owner);
      // Standard V2Ray base64 subscription: clients repeatedly fetch this URL.
      // Network revocation is enforced both in DB and by the real Xray node.
      res.setHeader('subscription-userinfo',
        'upload=0; download=0; total=0; expire='+
        Math.floor(owner.expiresAt.getTime()/1000));
      res.setHeader('profile-title','base64:'+Buffer.from('Мне бы VPN').toString('base64'));
      send(res,200,Buffer.from(profile+'\n','utf8').toString('base64')+'\n',
        'text/plain; charset=utf-8');
    }catch{
      json(res,503,{code:'VPN_SUBSCRIPTION_UNAVAILABLE'});
    }
    return;
  }
  const installMatch=/^\/install\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if(req.method==='GET'&&installMatch){
    const owner=await subscriptionOwner(pool,installMatch[1]);
    if(!owner){json(res,404,{code:'SUBSCRIPTION_NOT_ACTIVE'});return;}
    const client=url.searchParams.get('client');
    if(client!=='incy'&&client!=='karing'){
      json(res,400,{code:'UNSUPPORTED_VPN_CLIENT'});return;
    }
    send(res,200,installHtml(subscriptionLink(installMatch[1]),client),
      'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, { status: 'ok', component: 'web-cabinet' }); return;
  }
  if (req.method === 'GET' && url.pathname === '/readyz') {
    json(res, 503, { ready: false, gates: [
      'VPN_NODE_AND_DNS_INGRESS_NOT_VERIFIED',
      'ON_WIRE_DNS_QUOTA_NOT_VERIFIED',
      ...(networkVerified ? [] : ['NETWORK_PROVISIONING_NOT_VERIFIED']),
      ...(checkoutEnabled ? [] : ['PAYMENT_PROVIDER_NOT_VERIFIED']),
    ] }); return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/login') {
    if (!loginEnabled) { json(res,503,{code:'TELEGRAM_LOGIN_NOT_READY'});return; }
    await login(req,res); return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    if (!loginEnabled) { json(res,503,{code:'TELEGRAM_LOGIN_NOT_READY'});return; }
    await callback(req,res,url); return;
  }
  // Prodamus's server-to-server POST is the ONLY payment proof, never /success.
  // The original FormData and Sign header are verified before SQL settlement.
  if (req.method === 'POST' && url.pathname === '/webhooks/prodamus') {
    if (!webhookEnabled || !payform) {send(res,503,'NOT_READY','text/plain; charset=utf-8');return;}
    const sign=req.headers.sign;
    const ct=req.headers['content-type'];
    if (typeof sign!=='string' || !/^[0-9a-f]{64}$/i.test(sign)) {
      send(res,401,'UNSIGNED','text/plain; charset=utf-8');return;
    }
    // The Prodamus payload parser accepts multipart ONLY. Do not advertise
    // urlencoded input that would otherwise fail with a misleading HTTP 503.
    if (typeof ct!=='string' ||
        !/^multipart\/form-data;\s*boundary=/i.test(ct)) {
      send(res,415,'UNSUPPORTED_MEDIA_TYPE','text/plain; charset=utf-8');return;
    }
    const fields=await parseProdamusFormData(ct,await readPaymentBody(req));
    const answer=await handleProdamusDelivery(fields,sign,store,payform);
    send(res,answer.statusCode,answer.text,'text/plain; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/plans') {
    const plans = await store.plans('prodamus');
    const trialOffers = trialEnabled
      ? (await pool.query('SELECT product FROM trial_offers WHERE enabled=true')).rows.map(r=>r.product as string)
      : [];
    json(res,200,{ loginEnabled, checkoutEnabled, trialOffers, plans: plans.map(p => ({
      id: p.planId, title: p.title, product: p.product,
      durationDays: p.durationSeconds / 86400, rubMinor: p.rubMinor,
      dnsQuotaBytes: p.dnsQuotaBytes?.toString() ?? null,
    })) }); return;
  }
  const auth = await authorized(req);
  if (!auth) { json(res, 401, { code: 'LOGIN_REQUIRED' }); return; }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const dashboard = await loadDashboard(pool, auth.userId, meteringVerified);
    json(res,200,{ ...dashboard, csrf: csrfForSession(auth.raw,sessionSecret) }); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    if (!csrfAllowed(req,auth.raw)) { json(res,403,{code:'FORBIDDEN'});return; }
    await pool.query(`UPDATE website_sessions SET revoked_at=clock_timestamp()
      WHERE token_sha256=$1 AND revoked_at IS NULL`,[sessionHash(auth.raw)]);
    setCookie(res,sessionCookie,'',0);
    json(res,200,{ok:true});return;
  }
  if (req.method === 'POST' && url.pathname === '/api/trial') {
    if (!csrfAllowed(req,auth.raw)) { json(res,403,{code:'FORBIDDEN'});return; }
    if (!trialEnabled) { json(res,503,{code:'TRIAL_NOT_AVAILABLE'});return; }
    const body = await bodyJson(req);
    if (!['vpn','smart_dns','bundle'].includes(String(body.product)) ||
      typeof body.product !== 'string' ||
      (body.inviteToken !== undefined &&
        (typeof body.inviteToken !== 'string' ||
         !/^[A-Za-z0-9_-]{16,24}$/.test(body.inviteToken)))) {
      json(res,400,{code:'INVALID_TRIAL'});return;
    }
    const result = await store.grantTrial(auth.userId,
      body.product as 'vpn'|'smart_dns'|'bundle',body.inviteToken as string|undefined);
    json(res,200,{status:result.status,expiresAt:result.expiresAt?.toISOString()??null});
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/api/checkout' || url.pathname === '/api/renew')) {
    if (!csrfAllowed(req,auth.raw)) { json(res,403,{code:'FORBIDDEN'});return; }
    if (!checkoutEnabled || !payform) {
      json(res,503,{code:'PAYMENT_NOT_AVAILABLE'});return;
    }
    const body = await bodyJson(req);
    const isRenewal=url.pathname==='/api/renew';
    const validTarget=typeof body.renewalTargetId==='string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.renewalTargetId);
    if (isRenewal!==validTarget ||
        typeof body.planId !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.planId) ||
        typeof body.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(body.requestId) ||
        (body.inviteToken !== undefined &&
          (typeof body.inviteToken !== 'string' ||
           !/^[A-Za-z0-9_-]{16,24}$/.test(body.inviteToken)))) {
      json(res,400,{code:'INVALID_CHECKOUT'});return;
    }
    const owner = await pool.query('SELECT id FROM accounts WHERE telegram_user_id=$1',[String(auth.userId)]);
    if (owner.rowCount !== 1) { json(res,401,{code:'LOGIN_REQUIRED'});return; }
    const purchase = await prepareWebsiteProdamusCheckout({
      accountId: owner.rows[0].id as string, planId: body.planId,
      requestId: 'web:' + body.requestId,
      inviteToken: body.inviteToken as string|undefined,
      renewalTargetId: isRenewal ? body.renewalTargetId as string : undefined,
    },store,payform,new MerchantTransport());
    json(res,200,{orderId:purchase.orderId,paymentUrl:purchase.paymentUrl});
    return;
  }
  json(res,404,{code:'NOT_FOUND'});
}
const port = Number(process.env.WEB_PORT ?? '8791');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEB_PORT');
const server = createServer((req,res) => {
  handle(req,res).catch(() => json(res,503,{code:'SERVICE_UNAVAILABLE'}));
});
server.listen(port, '127.0.0.1', () => {
  console.info('MNEBYVPN website listening on loopback port ' + port);
});
