/**
 * Independent website: Telegram OIDC / email login, customer dashboard,
 * and gated YooKassa checkout (plus optional legacy Prodamus webhook fallback).
 * NO deployment or live credentials. Bind to loopback behind a hardened HTTPS reverse proxy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import {canonicalAlias,requiresNoindex,renderRobots,renderSitemap} from './seo-core.ts';
import {renderSeoPage} from './seo-pages.ts';
import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import {supportConfig,supportLimiter,telegramSupportSend,validSupportContact,validSupportText}
  from '../../../packages/support/src/telegram-relay.ts';
import {verifyGscOwnerRelaySignature} from '../../../packages/support/src/gsc-owner-relay.ts';
import { PgBillingStore } from '../../../packages/billing/src/store.ts';
import {subscriptionOwner,subscriptionLink,issueSubscriptionLinkForAccount}
  from '../../../packages/provisioning/src/subscription-links.ts';
import {additionalNodeVerificationKey,loadAdditionalVpnLinks}
  from '../../../packages/provisioning/src/multi-node-subscriptions.ts';
import {isCanonicalAwgPublicKey,loadVerifiedAwgMaterial}
  from '../../../packages/provisioning/src/awg-subscriber-material.ts';
import {
  prepareWebsiteProdamusCheckout, prepareWebsiteYookassaCheckout, type PayformLinkTransport,
} from '../../../packages/billing/src/website-checkout.ts';
import type { ProdamusConfig } from '../../../packages/billing/src/prodamus.ts';
import {
  HttpYookassaTransport, isAllowedYookassaWebhookIp, verifyYookassaPaymentObject,
  type YookassaConfig,
} from '../../../packages/billing/src/yookassa.ts';
import { yookassaOrderFromDB } from '../../../packages/billing/src/store.ts';
import {
  consumeLoginChallenge, createLoginChallenge, csrfForSession, isValidCsrf,
  issueAccountSession, readAccountSession, verifyEnvelope, verifyTelegramIdToken, type Jwks,
} from '../../../packages/web/src/security.ts';
import { loadDashboard } from '../../../packages/web/src/dashboard.ts';
import {
  bonusReleaseReady,loadCustomerProxyBonus,loadCustomerWsProxy,parseBonusRoutes,
  parseWsProxyRoutes,wsProxyReleaseReady,
}
  from '../../../packages/web/src/telegram-proxy-bonus.ts';
import {websitePersonalDnsStatus,issueWebsitePersonalDnsProfile}
  from '../../../packages/web/src/personal-dns-apple.ts';
import {normalizeLoginEmail} from '../../../packages/web/src/email-otp.ts';
import {beginEmailCode,verifyEmailCode} from '../../../packages/web/src/email-auth-service.ts';
import {isReviewEmail,isReviewAccount,beginReviewCode,verifyReviewCode}
  from '../../../packages/web/src/review-login.ts';
import { parseProdamusFormData, isProdamusContentType } from '../../../packages/billing/src/multipart.ts';
import { handleProdamusDelivery, handleYookassaDelivery } from '../../../packages/billing/src/handlers.ts';

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
const support=supportConfig();
const bridgeSecret=process.env.SUPPORT_BRIDGE_SECRET??'';
const supportAuthKey=/^[a-f0-9]{64}$/.test(bridgeSecret)
  ?bridgeSecret:(support?.botToken??'');
// No public operator API may ever authenticate with an empty HMAC key.
const contactLimit=supportLimiter(3,15*60_000);
const globalSupportLimit=supportLimiter(120,60_000);
const gscRelayReplayLimit=supportLimiter(1,10*60_000);
const sessionSecret = required('WEB_SESSION_SECRET');
if (sessionSecret.length < 32) throw new Error('WEB_SESSION_SECRET too short');
// A public informational site can be deployed before BotFather issues OIDC
// credentials. Login is unavailable until explicitly enabled with real keys.
const telegramLoginEnabled = process.env.WEB_TELEGRAM_OIDC_ENABLED === 'yes';
const emailLoginEnabled = process.env.WEB_EMAIL_LOGIN_ENABLED === 'yes';
const mailGatewaySecret = process.env.MNEBYVPN_MAIL_GATEWAY_SECRET ?? '';
if(emailLoginEnabled && mailGatewaySecret.length<32)
  throw Error('MNEBYVPN email OTP requires a configured private ServGo mail gateway secret');
const loginEnabled = telegramLoginEnabled || emailLoginEnabled;
const clientId = process.env.TELEGRAM_OIDC_CLIENT_ID ?? '';
const clientSecret = process.env.TELEGRAM_OIDC_CLIENT_SECRET ?? '';
if (telegramLoginEnabled && (!/^[0-9]{5,20}$/.test(clientId) || clientSecret.length < 16))
  throw new Error('Invalid Telegram OIDC client configuration');

const tls = base.protocol === 'https:';
const sessionCookie = tls ? '__Host-mnebyvpn_session' : 'mnebyvpn_session';
const challengeCookie = tls ? '__Host-mnebyvpn_oidc' : 'mnebyvpn_oidc';
const deviceCookie = tls ? '__Host-mnebyvpn_device' : 'mnebyvpn_device';
const supportCookie=tls?'__Host-mnebyvpn_support':'mnebyvpn_support';
const supportCookiePattern=/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const networkVerified = process.env.WEB_NETWORK_PROVISIONING_VERIFIED === 'yes';
// Never stop receiving previously-created payment notifications merely
// because new sales were disabled. Both flags default to fail-closed.
const yookassaWebhookEnabled = process.env.WEB_YOOKASSA_ENABLED === 'yes' &&
  process.env.WEB_PAYMENT_PROVIDER_TESTED === 'yes';
const webhookEnabled = process.env.WEB_PRODAMUS_WEBHOOK_ENABLED === 'yes' &&
  process.env.WEB_PAYMENT_PROVIDER_TESTED === 'yes';
const activePaymentProvider: 'yookassa' | 'prodamus' | null =
  yookassaWebhookEnabled ? 'yookassa' : (webhookEnabled ? 'prodamus' : null);
const checkoutEnabled = loginEnabled && activePaymentProvider !== null && networkVerified &&
  process.env.WEB_CHECKOUT_ENABLED === '1' &&
  process.env.WEB_LEGAL_PAGES_PUBLISHED === 'yes';
const trialEnabled = loginEnabled && networkVerified &&
  process.env.WEB_TRIAL_ENABLED === 'yes';
// Anonymous guest claims cannot prove a stable user identity.
// Deprecated WEB_GUEST_TRIAL_ENABLED is deliberately ignored. No anonymous grant routes.
const meteringVerified = networkVerified && process.env.WEB_DNS_METERING_VERIFIED === 'yes';
const proxyBonusEnabled=networkVerified&&bonusReleaseReady(process.env);
const wsProxyEnabled=networkVerified&&wsProxyReleaseReady(process.env);
// Apple profile generation is never offered until the real personal DoT ingress is tested.
const appleDnsProfileEnabled=networkVerified &&
  process.env.WEB_PERSONAL_DNS_APPLE_ENABLED==='yes' &&
  process.env.WEB_PERSONAL_DNS_DOT_E2E_VERIFIED==='yes';
// Brochure/support data remains isolated from the real VPN billing ledger.
// Public checkout, signed callbacks and paid entitlements MUST use the
// canonical VPN node database with an independent least-privilege role.
const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 5, connectionTimeoutMillis: 3000 });
const billingDbUrl=process.env.WEB_BILLING_DATABASE_URL;
const billingPool=billingDbUrl
  ?new Pool({connectionString:billingDbUrl,max:4,connectionTimeoutMillis:3000})
  :pool;
const store = new PgBillingStore(billingPool);
// Public website and Telegram bot have independent databases. Never silently
// look up a Telegram subscription token in the public website's database.
// Only subscription routes may use the private read connection to the bot DB.
const subscriptionDbUrl=process.env.VPN_SUBSCRIPTION_DATABASE_URL;
const subscriptionPool=subscriptionDbUrl
  ?new Pool({connectionString:subscriptionDbUrl,max:3,connectionTimeoutMillis:3000})
  :offline?pool:null;
// Extra servers are double-gated: env opt-in + DB release flag. The website
// sees only an Ed25519 verification key; signing keys stay with the controller.
const extraVpnNodeKey=process.env.VPN_ADDITIONAL_NODES_ENABLED==='yes'
  ?additionalNodeVerificationKey(required('VPN_ADDITIONAL_NODE_VERIFY_KEY')):null;
// Separate native AmneziaWG protocol: never append a .conf to VLESS /sub.
// Disabled until FI node is verified, signed grant/ACK is real and admin
// explicitly releases native AWG material for an EXISTING device key.
const awgMaterialEnabled=process.env.WEB_FI_AWG_MATERIAL_ENABLED==='yes';
const fiAwgRegistrationAvailable=networkVerified&&loginEnabled&&awgMaterialEnabled&&
  process.env.WEB_FI_AWG_REGISTRATION_ENABLED==='yes';
const awgHeaderProtectionKey=awgMaterialEnabled
  ?required('WEB_FI_AWG_HEADER_PROTECTION_KEY'):'';
const awgServerPublicKey=awgMaterialEnabled
  ?required('WEB_FI_AWG_SERVER_PUBLIC_KEY'):'';
if(awgMaterialEnabled&&
   (!isCanonicalAwgPublicKey(awgHeaderProtectionKey)||
    !isCanonicalAwgPublicKey(awgServerPublicKey)))
  throw Error('Independently verified FI AWG server/header keys are required');
// Login identities must live in the same canonical DB as the VPN node.
// Never give the brochure site the bot's unrestricted writer credentials.
const authDbUrl=process.env.WEB_AUTH_DATABASE_URL;
if(loginEnabled&&!offline &&
   (!authDbUrl||!sameCanonicalPostgresDb(authDbUrl,subscriptionDbUrl)))
  throw Error('Live website authentication requires a canonical least-privilege auth database');
const authPool=authDbUrl
  ?new Pool({connectionString:authDbUrl,max:3,connectionTimeoutMillis:3000})
  :pool;
// Trial and paid provisioning must write to the SAME canonical billing DB as
// the VPN node worker. A separate web-only account cannot activate a VPN.
// Do not enable trial/checkout while the data stores are isolated.
function sameCanonicalPostgresDb(writer:string,reader:string|undefined):boolean{
  // Reader and writer may use DIFFERENT DB users/passwords for least privilege.
  // Require the identical database network endpoint, not identical credentials.
  if(!reader)return false;
  try{
    const a=new URL(writer),b=new URL(reader);
    const valid=(u:URL)=>['postgresql:','postgres:'].includes(u.protocol) &&
      !!u.hostname && /^\/[A-Za-z0-9_-]{1,63}$/.test(u.pathname);
    const port=(u:URL)=>u.port||'5432';
    return valid(a)&&valid(b)&&a.protocol===b.protocol &&
      a.hostname.toLowerCase()===b.hostname.toLowerCase() &&
      port(a)===port(b)&&a.pathname===b.pathname &&
      a.search===''&&b.search===''&&a.hash===''&&b.hash==='';
  }catch{return false;}
}
if(!offline && (trialEnabled||checkoutEnabled||yookassaWebhookEnabled||webhookEnabled) &&
   !sameCanonicalPostgresDb(billingDbUrl??'',subscriptionDbUrl))
  throw Error('Live VPN paid checkout and webhooks require the canonical least-privilege billing database');
if(!offline && billingDbUrl && !sameCanonicalPostgresDb(billingDbUrl,subscriptionDbUrl))
  throw Error('Invalid configured VPN billing database target');
let yookassa: YookassaConfig | undefined;
if (yookassaWebhookEnabled) {
  const vatRaw = process.env.YOOKASSA_VAT_CODE;
  const taxRaw = process.env.YOOKASSA_TAX_SYSTEM_CODE;
  yookassa = {
    shopId: required('YOOKASSA_SHOP_ID'),
    secretKey: required('YOOKASSA_SECRET_KEY'),
    returnUrl: process.env.YOOKASSA_RETURN_URL || (publicOrigin + '/payment/return'),
    apiOrigin: offline ? process.env.YOOKASSA_API_ORIGIN : undefined,
    vatCode: vatRaw ? Number(vatRaw) : 1,
    taxSystemCode: taxRaw ? Number(taxRaw) : undefined,
    sendReceipt: process.env.YOOKASSA_SEND_RECEIPT !== 'no',
  };
}
let payform: ProdamusConfig | undefined;
if (webhookEnabled) {
  payform = {
    formUrl: required('PRODAMUS_FORM_URL'),
    notificationUrl: required('PRODAMUS_NOTIFICATION_URL'),
    successUrl: required('PRODAMUS_SUCCESS_URL'),
    returnUrl: required('PRODAMUS_RETURN_URL'),
    secret: required('PRODAMUS_SIGN_SECRET'),
    sys:process.env.PRODAMUS_SYS || undefined,
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
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'text/plain' },
      });
    } catch {
      throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
    let data: string;
    try { data = await response.text(); }
    catch { throw new Error('PAYMENT_PROVIDER_UNAVAILABLE'); }
    if (data.length > 2048) throw new Error('PAYMENT_PROVIDER_INVALID_LINK');
    return data;
  }
}

const html = await readFile(new URL('../public/index.html', import.meta.url));
const fiAwgSetupHtml=await readFile(new URL('../public/awg-setup.html',import.meta.url));
const fiAwgSetupJs=await readFile(new URL('../public/awg-setup.js',import.meta.url));
const fiAwgSetupCss=await readFile(new URL('../public/awg-setup.css',import.meta.url));
const landingArtHtml = await readFile(new URL('../public/landing-art.html', import.meta.url));
const bg3Webm = await readFile(new URL('../public/bg3.webm', import.meta.url));
const bg3Mp4 = await readFile(new URL('../public/bg3.mp4', import.meta.url));
const bgDesktopWebm = await readFile(new URL('../public/bg-desktop.webm', import.meta.url));
const bgDesktopMp4 = await readFile(new URL('../public/bg-desktop.mp4', import.meta.url));
const bgDesktopPoster = await readFile(new URL('../public/bg-desktop-poster.webp', import.meta.url));
const termsHtml = await readFile(new URL('../public/terms.html',import.meta.url));
const privacyHtml = await readFile(new URL('../public/privacy.html',import.meta.url));
const agreementHtml = await readFile(new URL('../public/agreement.html',import.meta.url));
const legalCss = await readFile(new URL('../public/legal.css',import.meta.url));
const seoCss = await readFile(new URL('../public/seo-pages.css',import.meta.url));
const css = await readFile(new URL('../public/site.css', import.meta.url));
const neoCss = await readFile(new URL('../public/neo.css', import.meta.url));
const brandAvatar = await readFile(new URL('../public/brand-avatar.webp', import.meta.url));
const worldNeon = await readFile(new URL('../public/world-neon.webp', import.meta.url));
const landingEarth = await readFile(new URL('../public/landing-earth.webp', import.meta.url));
const js = await readFile(new URL('../public/app.js', import.meta.url));
const journeyCss = await readFile(new URL('../public/journey.css', import.meta.url));
const journeyJs = await readFile(new URL('../public/journey.js', import.meta.url));
const aboutJs = await readFile(new URL('../public/about.js', import.meta.url));
const vpnInstallJs=await readFile(new URL('../public/vpn-install.js',import.meta.url));
const workerProfileToken=process.env.VPN_WORKER_PROFILE_TOKEN??'';
/** Public-only, DB-authoritative catalog. Does not expose a user's orders or secrets. */
async function publicCatalog(){
  const plans=await store.plans(activePaymentProvider??'yookassa');
  const trialOffers=trialEnabled
    ? (await billingPool.query('SELECT product FROM trial_offers WHERE enabled=true')).rows.map(r=>r.product as string)
    : [];
  return {loginEnabled,telegramLoginEnabled,emailLoginEnabled,checkoutEnabled,
    paymentProvider:activePaymentProvider,trialOffers,
    plans:plans.map(p=>({
      id:p.planId,title:p.title,product:p.product,
      durationDays:p.durationSeconds/86400,rubMinor:p.rubMinor,
      deviceLimit:p.deviceLimit??1,
      dnsQuotaBytes:p.dnsQuotaBytes?.toString()??null,
      dnsQuotaQueriesPer30d:p.dnsQuotaQueriesPer30d?.toString()??null,
    }))};
}

const policy = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "connect-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "form-action 'self'", "base-uri 'none'", "frame-src 'self'", "frame-ancestors 'none'",
].join('; ');
/* Only the static, owner-supplied visual frame can run inline animations.
 * The main site, session endpoints and payment flows keep the strict CSP.
 */
const landingArtPolicy = [
  "default-src 'none'", "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "media-src 'self'",
  "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

function sendArt(res: ServerResponse) {
  res.setHeader('X-Robots-Tag','noindex, follow');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', landingArtPolicy);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.writeHead(200).end(landingArtHtml);
}

// Byte-range support is required for reliable MP4 playback in Safari/iOS.
// These two public, static media assets carry no authentication state.
function sendBackgroundVideo(req: IncomingMessage, res: ServerResponse, data: Buffer, type: 'video/webm'|'video/mp4') {
  const total=data.byteLength;
  const raw=req.headers.range;
  let start=0,end=total-1;
  let partial=false;
  res.setHeader('Cache-Control','public, max-age=3600');
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type',type);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  if(raw!==undefined) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(raw);
    let valid=Boolean(match&&(match[1]||match[2]));
    if(valid&&match) {
      if(match[1]) {
        start=Number(match[1]);
        end=match[2]?Number(match[2]):total-1;
      } else {
        const suffix=Number(match[2]);
        valid=Number.isSafeInteger(suffix)&&suffix>0;
        if(valid) start=Math.max(0,total-suffix);
      }
      valid=valid&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&
        start>=0&&start<total&&end>=start;
      if(valid) end=Math.min(end,total-1);
    }
    if(!valid) {
      res.setHeader('Content-Range','bytes */'+total);
      res.setHeader('Content-Length','0');
      res.writeHead(416).end();return;
    }
    partial=true;
    res.setHeader('Content-Range','bytes '+start+'-'+end+'/'+total);
  }
  res.setHeader('Content-Length',String(end-start+1));
  res.writeHead(partial?206:200);
  if(req.method==='HEAD')res.end();
  else res.end(data.subarray(start,end+1));
}

function send(res: ServerResponse, status: number, body: string|Buffer, type = 'application/json; charset=utf-8', cacheControl = 'no-store') {
  res.setHeader('Cache-Control', cacheControl);
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
async function authorized(req:IncomingMessage):Promise<{
  accountId:string;telegramUserId:number|null;email:string|null;raw:string
}|null> {
  const raw=cookie(req,sessionCookie);
  const accountId=readAccountSession(raw,sessionSecret);
  if(!accountId||!raw)return null;
  // Each request verifies its signed account-scoped bearer against revocable DB state.
  const {rows}=await authPool.query(`SELECT a.id,a.telegram_user_id,a.email_address
    FROM website_sessions s JOIN accounts a ON a.id=s.account_id
    LEFT JOIN web_review_login reviewer ON reviewer.account_id=a.id
    WHERE s.token_sha256=$1 AND s.account_id=$2
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (reviewer.account_id IS NULL OR reviewer.enabled=true)`,
    [sessionHash(raw),accountId]);
  if(rows.length!==1)return null;
  const tg=rows[0].telegram_user_id;
  const telegramUserId=tg===null?null:Number(tg);
  if(telegramUserId!==null&&(!Number.isSafeInteger(telegramUserId)||telegramUserId<=0))
    return null;
  return {accountId,telegramUserId,email:rows[0].email_address??null,raw};
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
async function bodyJson(req: IncomingMessage,maxBytes=4096): Promise<Record<string,unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw new Error('Request too large');
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

function sourceAddress(req:IncomingMessage):string{
  const socketIp=req.socket.remoteAddress??'unknown';
  const supplied=req.headers['x-real-ip'];
  // X-Real-IP must be set by the local reverse proxy, which strips inbound copies.
  if((socketIp==='127.0.0.1'||socketIp==='::1'||socketIp==='::ffff:127.0.0.1')&&
     typeof supplied==='string'&&/^[a-f0-9:.]{3,45}$/i.test(supplied))return supplied;
  return socketIp;
}
async function emailStart(req:IncomingMessage,res:ServerResponse):Promise<void>{
  if(!emailLoginEnabled){json(res,503,{code:'EMAIL_LOGIN_NOT_READY'});return;}
  if(req.headers.origin!==publicOrigin||!req.headers['content-type']?.startsWith('application/json')){
    json(res,403,{code:'FORBIDDEN'});return;
  }
  const body=await bodyJson(req);
  const email=normalizeLoginEmail(body.email);
  if(!email || (body.link!==undefined&&typeof body.link!=='boolean')){
    json(res,400,{code:'INVALID_EMAIL'});return;
  }
  const current=body.link===true?await authorized(req):null;
  if(body.link===true&&!current){json(res,401,{code:'LOGIN_REQUIRED'});return;}
  // Reviewer identities cannot be linked to a customer's Telegram/email.
  if(body.link===true&&current&&await isReviewAccount(authPool,current.accountId)){
    json(res,403,{code:'FORBIDDEN'});return;
  }
  if(await isReviewEmail(authPool,email)){
    if(body.link===true){json(res,409,{code:'EMAIL_ALREADY_LINKED'});return;}
    const review=await beginReviewCode(authPool,{
      email,ip:sourceAddress(req),secret:sessionSecret,
    });
    if(review==='RATE_LIMIT'){json(res,429,{code:'EMAIL_RATE_LIMIT'});return;}
    if(review==='DISABLED'){json(res,403,{code:'EMAIL_NOT_AVAILABLE'});return;}
    json(res,200,{status:'REVIEW_CODE_REQUIRED',codeLength:8});
    return;
  }
  const result=await beginEmailCode(authPool,{
    email,ip:sourceAddress(req),linkAccountId:current?.accountId??null,
    secret:sessionSecret,gatewaySecret:mailGatewaySecret,
  });
  if(result==='RATE_LIMIT'){json(res,429,{code:'EMAIL_RATE_LIMIT'});return;}
  if(result==='FAILED'){json(res,503,{code:'EMAIL_NOT_SENT'});return;}
  json(res,200,{status:'CODE_SENT',expiresInSeconds:600});
}
async function emailVerify(req:IncomingMessage,res:ServerResponse):Promise<void>{
  if(!emailLoginEnabled){json(res,503,{code:'EMAIL_LOGIN_NOT_READY'});return;}
  if(req.headers.origin!==publicOrigin||!req.headers['content-type']?.startsWith('application/json')){
    json(res,403,{code:'FORBIDDEN'});return;
  }
  const body=await bodyJson(req);
  const email=normalizeLoginEmail(body.email);
  if(!email||typeof body.code!=='string'){
    json(res,400,{code:'INVALID_EMAIL_CODE'});return;
  }
  const review=await isReviewEmail(authPool,email);
  if(!(review?/^[0-9]{8}$/:/^[0-9]{6}$/).test(body.code)){
    json(res,400,{code:'INVALID_EMAIL_CODE'});return;
  }
  const current=await authorized(req);
  if(current&&await isReviewAccount(authPool,current.accountId)&&current.email!==email){
    json(res,403,{code:'FORBIDDEN'});return;
  }
  const result=review
    ?await verifyReviewCode(authPool,{
      email,code:body.code,ip:sourceAddress(req),secret:sessionSecret,
    })
    :await verifyEmailCode(authPool,{
      email,code:body.code,currentAccountId:current?.accountId??null,secret:sessionSecret,
    });
  if(result.status!=='SIGNED_IN'||!result.accountId){
    json(res,result.status==='CONFLICT'?409:result.status==='RATE_LIMIT'?429:401,{
      code:result.status==='CONFLICT'?'EMAIL_ALREADY_LINKED':
        result.status==='RATE_LIMIT'?'EMAIL_RATE_LIMIT':'INVALID_OR_EXPIRED_CODE',
    });return;
  }
  const token=issueAccountSession(result.accountId,sessionSecret);
  await authPool.query(
    'INSERT INTO website_sessions(token_sha256,account_id,expires_at) VALUES($1,$2,$3)',
    [sessionHash(token),result.accountId,new Date(Date.now()+12*60*60_000)]);
  setCookie(res,sessionCookie,token,12*60*60);
  json(res,200,{status:'SIGNED_IN'});
}

async function login(req:IncomingMessage,res:ServerResponse,query:URL){
  if(!telegramLoginEnabled){json(res,503,{code:'TELEGRAM_LOGIN_NOT_READY'});return;}
  const linking=query.searchParams.get('link')==='1';
  const current=linking?await authorized(req):null;
  if(linking&&!current){redirect(res,'/#account');return;}
  const challenge=createLoginChallenge(sessionSecret,Date.now(),'telegram',
    current?.accountId??null);
  setCookie(res,challengeCookie,challenge.cookie,300);
  // Telegram official OIDC confirmation, no message from VPN bot required.
  const oauth=new URL('https://oauth.telegram.org/auth');
  oauth.searchParams.set('client_id',clientId);
  oauth.searchParams.set('redirect_uri',publicOrigin+'/auth/callback');
  oauth.searchParams.set('response_type','code');
  oauth.searchParams.set('scope','openid profile');
  oauth.searchParams.set('state',challenge.state);
  oauth.searchParams.set('code_challenge',challenge.codeChallenge);
  oauth.searchParams.set('code_challenge_method','S256');
  redirect(res,oauth.toString());
}
async function callback(req:IncomingMessage,res:ServerResponse,url:URL){
  const rawChallenge=cookie(req,challengeCookie);
  const challengeData=verifyEnvelope(rawChallenge,sessionSecret);
  const verifier=consumeLoginChallenge(rawChallenge,url.searchParams.get('state'),
    sessionSecret,Date.now(),'telegram');
  setCookie(res,challengeCookie,'',0);
  const code=url.searchParams.get('code');
  if(!verifier||!code||code.length>2048){
    redirect(res,'/?login=failed#account');return;
  }
  try{
    const params=new URLSearchParams({
      grant_type:'authorization_code',code,
      redirect_uri:publicOrigin+'/auth/callback',
      client_id:clientId,code_verifier:verifier,
    });
    const token=await readRemoteJson('https://oauth.telegram.org/token',{
      method:'POST',headers:{
        'Content-Type':'application/x-www-form-urlencoded',
        'Authorization':'Basic '+Buffer.from(clientId+':'+clientSecret).toString('base64'),
      },body:params.toString(),
    });
    if(typeof token.id_token!=='string')throw Error('Missing verified identity');
    const jwks=await readRemoteJson('https://oauth.telegram.org/.well-known/jwks.json');
    const subject=String(verifyTelegramIdToken(token.id_token,jwks as Jwks,clientId));
    const linkAccountId=challengeData?.linkAccountId;
    let accountId:string;
    if(linkAccountId!==null&&linkAccountId!==undefined){
      if(typeof linkAccountId!=='string')throw Error('Invalid account link');
      const current=await authorized(req);
      if(!current||current.accountId!==linkAccountId)
        throw Error('Account linking requires the same authenticated session');
      if(await isReviewAccount(authPool,current.accountId))
        throw Error('Reviewer account cannot link Telegram');
      const updated=await authPool.query(
        'UPDATE accounts SET telegram_user_id=$1 WHERE id=$2 '+
        'AND (telegram_user_id IS NULL OR telegram_user_id=$1) RETURNING id',
        [subject,linkAccountId]);
      if(updated.rowCount!==1)
        throw Error('Telegram is already linked to another account');
      accountId=linkAccountId;
    }else{
      // Unlinked Telegram subjects cannot mint independent free trial accounts.
      const account=await authPool.query(
        'SELECT id FROM accounts WHERE telegram_user_id=$1',[subject]);
      if(account.rowCount!==1){
        redirect(res,'/?login=email-first#account');return;
      }
      accountId=account.rows[0].id as string;
    }
    const now=Date.now();
    const raw=issueAccountSession(accountId,sessionSecret,now);
    await authPool.query(
      'INSERT INTO website_sessions(token_sha256,account_id,expires_at) VALUES($1,$2,$3)',
      [sessionHash(raw),accountId,new Date(now+12*60*60_000)]);
    setCookie(res,sessionCookie,raw,12*60*60);
    redirect(res,'/#account');
  }catch{redirect(res,'/?login=failed#account');}
}
function validNodeVpnProfile(value:unknown):value is string {
  if(typeof value!=='string'||value.length>6000)return false;
  const links=value.split('\n');
  if(![1,2,3].includes(links.length))return false;
  const credentialPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const variants:string[]=[];
  let credential='';
  let realityKey='';
  for(const link of links){
    let uri:URL;
    try{uri=new URL(link);}catch{return false;}
    if(uri.protocol!=='vless:'||uri.hostname!=='cdn.servgo.ru'||
       !credentialPattern.test(uri.username)||uri.password||
       uri.searchParams.get('encryption')!=='none')return false;
    if(credential&&uri.username!==credential)return false;
    credential=uri.username;
    const p=uri.searchParams;
    const keys=new Set(p.keys());
    if(keys.size!==p.size)return false;
    if(uri.port==='8443'){
      const expected=['encryption','security','type','host','sni','path'];
      if(expected.some(k=>!keys.has(k))||keys.size!==expected.length||
         p.get('security')!=='tls'||p.get('type')!=='ws'||
         p.get('host')!=='cdn.servgo.ru'||p.get('sni')!=='cdn.servgo.ru'||
         p.get('path')!=='/mnebyvpn-vpn/ws')return false;
      variants.push('ws');
    }else if(uri.port==='2053'){
      const expected=['encryption','security','type','flow','sni','fp','pbk','sid','spx'];
      if(expected.some(k=>!keys.has(k))||keys.size!==expected.length||
         p.get('security')!=='reality'||p.get('type')!=='tcp'||
         p.get('flow')!=='xtls-rprx-vision'||
         p.get('sni')!=='www.cloudflare.com'||
         (p.get('fp')!=='chrome'&&p.get('fp')!=='firefox')||
         !/^[A-Za-z0-9_-]{43}$/.test(p.get('pbk')??'')||
         !/^[0-9a-f]{16}$/.test(p.get('sid')??'')||
         p.get('spx')!=='/')return false;
      const signature=p.get('pbk')+':'+p.get('sid');
      if(realityKey&&realityKey!==signature)return false;
      realityKey=signature;
      variants.push('reality_'+p.get('fp'));
    }else return false;
  }
  // One transport per signed node profile, no duplicates or invalid mixes.
  // Accept the old two-line form during a zero-downtime worker rollout.
  const shape=variants.join(',');
  return shape==='ws'||shape==='reality_chrome,ws'||
    shape==='reality_chrome,reality_firefox,ws';
}
/** Preserve the signed node configuration and existing working WS profile.
 * Karing uses type+server+port for disabled-node bookkeeping, which collides
 * for Chrome and Firefox if both Reality fingerprints dial the same host:2053.
 * Use the existing verified public IPv4 only for Chrome; Firefox keeps the
 * canonical domain. Both still reach the same node and use the same UUID/SNI.
 * This changes only subscription import URLs, not any live Xray service.
 */
function stableMultiClientVpnProfile(nodeProfile:string):string {
  return nodeProfile.split('\n').map(link=>{
    const url=new URL(link);
    if(url.port==='2053' && url.hostname==='cdn.servgo.ru' &&
       url.searchParams.get('security')==='reality' &&
       url.searchParams.get('fp')==='chrome'){
      url.hostname='89.125.90.101';
      return url.toString();
    }
    return link;
  }).join('\n');
}
async function liveVpnProfile(owner:{
  telegramUserId:number|null;entitlementId:string;
}):Promise<string>{
  if(!/^[a-f0-9]{64}$/i.test(workerProfileToken))
    throw Error('Private VPN subscription bridge not deployed');
  const response=await fetch('http://127.0.0.1:8794/profile',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(6500),
    headers:{Authorization:'Bearer '+workerProfileToken,
      'Content-Type':'application/json'},
    body:JSON.stringify(owner.telegramUserId===null
      ?{entitlementId:owner.entitlementId}
      :{telegramUserId:owner.telegramUserId,entitlementId:owner.entitlementId}),
  });
  if(!response.ok)throw Error('VPN node subscription unavailable');
  const result:unknown=await response.json();
  const profile=(result as {profile?:unknown})?.profile;
  if(!validNodeVpnProfile(profile))
    throw Error('Unexpected VPN node configuration');
  return profile;
}

function installHtml(subUrl:string,client:'incy'|'karing'):string {
  // Both URL and client have already passed strict token/enum validation.
  const app=client==='incy'?'INCY':'Karing';
  const escapedSubUrl=subUrl.replaceAll('&','&amp;');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="referrer" content="no-referrer">'+
    '<title>Подключение MNEBYVPN</title>'+
    '<link rel="stylesheet" href="/neo.css"></head>'+
    '<body style="margin:0"><main data-client="'+client+'" data-sub="'+escapedSubUrl+'">'+
    '<h1>Подключить VPN в '+app+'</h1>'+
    '<p>Пробуем открыть '+app+' автоматически. Если переход не произошёл, нажмите кнопку ниже.</p>'+
    '<p><button id="open-app" type="button">Открыть в '+app+'</button></p>'+
    '<p>Если приложение не открылось — скопируйте ссылку и вставьте её в '+app+
      ' через «Добавить подписку / Импорт из URL».</p>'+
    '<p><input id="subscription-url" aria-label="Ссылка подписки" value="'+escapedSubUrl+
      '" readonly><button id="copy-url" type="button">Копировать</button></p>'+
    '<p>Подписка персональная. Не пересылайте ссылку другим людям.</p>'+
    '<script src="/vpn-install.js" defer></script></main></body></html>';
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', publicOrigin);
  if (requiresNoindex(url.pathname))
    res.setHeader('X-Robots-Tag','noindex, follow');
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/robots.txt') {
    send(res,200,renderRobots(publicOrigin),'text/plain; charset=utf-8');return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/sitemap.xml') {
    send(res,200,renderSitemap(publicOrigin),'application/xml; charset=utf-8');return;
  }
  const alias=(req.method === 'GET' || req.method === 'HEAD')?canonicalAlias(url.pathname):null;
  if(alias){
    res.setHeader('Location',alias+url.search);
    res.setHeader('Cache-Control','public, max-age=3600');
    res.writeHead(301).end();return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const informationalPage=renderSeoPage(url.pathname);
    if(informationalPage){
      // Public fixed HTML can be cached briefly; account, checkout and APIs stay no-store.
      send(res,200,informationalPage,'text/html; charset=utf-8','public, max-age=300, must-revalidate');return;
    }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/payment/success' || url.pathname === '/payment/return')) {
    const device=cookie(req,deviceCookie);
    if(!device||!/^[A-Za-z0-9_-]{43}$/.test(device))
      setCookie(res,deviceCookie,randomBytes(32).toString('base64url'),365*24*60*60);
    // Public, read-only prices come from the same billing DB as /api/plans.
    // Embedding them in the HTML lets mobile browsers render the catalog when
    // subsequent API fetches are interrupted (VPN/DNS/network switching).
    // Payment always revalidates the plan on the server.
    let page=html;
    try{
      const payload=await publicCatalog();
      const encoded=Buffer.from(JSON.stringify(payload),'utf8').toString('base64');
      page=Buffer.from(html.toString('utf8').replace('</head>',
        '<meta name="mnebyvpn-public-catalog" content="'+encoded+'"></head>'));
    }catch{
      // Never make the informational page or login inaccessible because
      // the pricing database is briefly unavailable.
    }
    send(res, 200, page, 'text/html; charset=utf-8'); return;
  }
  if (req.method === 'GET' && url.pathname === '/landing-art.html') {
    sendArt(res); return;
  }
  if ((req.method === 'GET'||req.method === 'HEAD') && url.pathname === '/bg3.webm') {
    sendBackgroundVideo(req, res, bg3Webm, 'video/webm'); return;
  }
  if ((req.method === 'GET'||req.method === 'HEAD') && url.pathname === '/bg3.mp4') {
    sendBackgroundVideo(req, res, bg3Mp4, 'video/mp4'); return;
  }
  if ((req.method === 'GET'||req.method === 'HEAD') && url.pathname === '/bg-desktop.webm') {
    sendBackgroundVideo(req, res, bgDesktopWebm, 'video/webm'); return;
  }
  if ((req.method === 'GET'||req.method === 'HEAD') && url.pathname === '/bg-desktop.mp4') {
    sendBackgroundVideo(req, res, bgDesktopMp4, 'video/mp4'); return;
  }
  if ((req.method === 'GET'||req.method === 'HEAD') && url.pathname === '/bg-desktop-poster.webp') {
    res.setHeader('Cache-Control','public, max-age=86400');
    send(res, 200, bgDesktopPoster, 'image/webp'); return;
  }
  if (req.method === 'GET' && (url.pathname === '/terms' || url.pathname === '/terms.html')) {
    send(res,200,termsHtml,'text/html; charset=utf-8');return;
  }
  if (req.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/privacy.html')) {
    send(res,200,privacyHtml,'text/html; charset=utf-8');return;
  }
  if (req.method === 'GET' && (url.pathname === '/agreement' || url.pathname === '/agreement.html')) {
    send(res,200,agreementHtml,'text/html; charset=utf-8');return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/seo-pages.css') {
    send(res,200,seoCss,'text/css; charset=utf-8','public, max-age=300, must-revalidate');return;
  }
  if (req.method === 'GET' && url.pathname === '/legal.css') {
    send(res,200,legalCss,'text/css; charset=utf-8');return;
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
  if (req.method === 'GET' && url.pathname === '/world-neon.webp') {
    send(res, 200, worldNeon, 'image/webp'); return;
  }
  if (req.method === 'GET' && url.pathname === '/landing-earth.webp') {
    res.setHeader('Cache-Control','public, max-age=86400');
    send(res, 200, landingEarth, 'image/webp'); return;
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    send(res, 200, js, 'text/javascript; charset=utf-8'); return;
  }
  if(req.method==='GET' && url.pathname==='/journey.css'){
    send(res,200,journeyCss,'text/css; charset=utf-8');return;
  }
  if(req.method==='GET' && url.pathname==='/journey.js'){
    send(res,200,journeyJs,'text/javascript; charset=utf-8');return;
  }
  if (req.method === 'GET' && url.pathname === '/about.js') {
    send(res, 200, aboutJs, 'text/javascript; charset=utf-8'); return;
  }
  if(req.method==='GET' && url.pathname==='/vpn-install.js'){
    send(res,200,vpnInstallJs,'text/javascript; charset=utf-8');return;
  }
  if(req.method==='GET'&&url.pathname==='/awg/setup'){
    res.setHeader('Cache-Control','no-store, max-age=0');
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    if(!fiAwgRegistrationAvailable){json(res,404,{code:'AWG_SETUP_NOT_READY'});return;}
    send(res,200,fiAwgSetupHtml,'text/html; charset=utf-8');return;
  }
  if(req.method==='GET'&&url.pathname==='/awg-setup.css'){
    if(!fiAwgRegistrationAvailable){json(res,404,{code:'AWG_SETUP_NOT_READY'});return;}
    send(res,200,fiAwgSetupCss,'text/css; charset=utf-8');return;
  }
  if(req.method==='GET'&&url.pathname==='/awg-setup.js'){
    if(!fiAwgRegistrationAvailable){json(res,404,{code:'AWG_SETUP_NOT_READY'});return;}
    send(res,200,fiAwgSetupJs,'text/javascript; charset=utf-8');return;
  }
  const subMatch=/^\/sub\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if(req.method==='GET'&&subMatch){
    if(!subscriptionPool){json(res,503,{code:'SUBSCRIPTION_BACKEND_UNAVAILABLE'});return;}
    const owner=await subscriptionOwner(subscriptionPool,subMatch[1]);
    if(!owner){json(res,404,{code:'SUBSCRIPTION_NOT_ACTIVE'});return;}
    try{
      const nodeProfile=await liveVpnProfile(owner);
      // Every MNEBYVPN subscription URL is one living server group for
      // both INCY and Karing: include all independently verified transports
      // with the original WebSocket TLS fallback last. Never hide Reality
      // based on the client's name; the user chooses the working transport.
      // Only authenticated, node-verified profiles may appear in this group.
      const requestedClient=url.searchParams.get('client');
      if(url.searchParams.size>1||
         [...url.searchParams.keys()].some(k=>k!=='client')||
         (requestedClient!==null&&requestedClient!=='incy'&&requestedClient!=='karing')){
        json(res,400,{code:'UNSUPPORTED_VPN_CLIENT'});return;
      }
      const legacyProfile=stableMultiClientVpnProfile(nodeProfile);
      // An experimental registry failure cannot erase a working subscription.
      // Only fresh cryptographically signed grants produce additional nodes.
      let extraProfiles:string[]=[];
      if(extraVpnNodeKey){
        try{
          extraProfiles=await loadAdditionalVpnLinks(subscriptionPool,owner,extraVpnNodeKey);
        }catch{
          console.error('Additional VPN node registry unavailable');
        }
      }
      const profile=[legacyProfile,...extraProfiles].join('\n');
      // Standard V2Ray base64 subscription: clients repeatedly fetch this URL.
      // Network revocation is enforced both in DB and by the real Xray node.
      res.setHeader('subscription-userinfo',
        'upload=0; download=0; total=0; expire='+
        Math.floor(owner.expiresAt.getTime()/1000));
      res.setHeader('profile-title','base64:'+Buffer.from('MNEBYVPN').toString('base64'));
      send(res,200,Buffer.from(profile+'\n','utf8').toString('base64')+'\n',
        'text/plain; charset=utf-8');
    }catch{
      json(res,503,{code:'VPN_SUBSCRIPTION_UNAVAILABLE'});
    }
    return;
  }

  // Native AmneziaWG is a separate client protocol. Return ONLY the
  // connection material for a peer already signed and acknowledged on FI.
  // The client's X25519 private key is generated/held on-device; this route
  // never accepts it and NEVER grants a new public key.
  const awgMatch=/^\/awg\/([A-Za-z0-9_-]{43})\/material$/.exec(url.pathname);
  if(req.method==='GET'&&awgMatch){
    res.setHeader('Cache-Control','no-store, max-age=0');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    if(!awgMaterialEnabled){json(res,404,{code:'AWG_MATERIAL_NOT_AVAILABLE'});return;}
    if(!subscriptionPool){json(res,503,{code:'SUBSCRIPTION_BACKEND_UNAVAILABLE'});return;}
    if(url.searchParams.size!==1||![...url.searchParams.keys()].every(k=>k==='peer')){
      json(res,400,{code:'INVALID_AWG_PUBLIC_KEY'});return;
    }
    const publicKey=url.searchParams.get('peer');
    if(!isCanonicalAwgPublicKey(publicKey)){
      json(res,400,{code:'INVALID_AWG_PUBLIC_KEY'});return;
    }
    const owner=await subscriptionOwner(subscriptionPool,awgMatch[1]);
    if(!owner){json(res,404,{code:'SUBSCRIPTION_NOT_ACTIVE'});return;}
    try{
      const profile=await loadVerifiedAwgMaterial(
        subscriptionPool,owner,publicKey,awgHeaderProtectionKey,awgServerPublicKey,
        sessionHash(awgMatch[1]));
      if(!profile){json(res,404,{code:'AWG_PEER_NOT_ACKNOWLEDGED'});return;}
      json(res,200,profile);
    }catch{
      json(res,503,{code:'AWG_MATERIAL_BACKEND_UNAVAILABLE'});
    }
    return;
  }
  const installMatch=/^\/install\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if(req.method==='GET'&&installMatch){
    if(!subscriptionPool){json(res,503,{code:'SUBSCRIPTION_BACKEND_UNAVAILABLE'});return;}
    const owner=await subscriptionOwner(subscriptionPool,installMatch[1]);
    if(!owner){json(res,404,{code:'SUBSCRIPTION_NOT_ACTIVE'});return;}
    const client=url.searchParams.get('client');
    if(client!=='incy'&&client!=='karing'){
      json(res,400,{code:'UNSUPPORTED_VPN_CLIENT'});return;
    }
    send(res,200,installHtml(subscriptionLink(installMatch[1])+'?client='+client,client),
      'text/html; charset=utf-8');
    return;
  }
if(req.method==='GET'&&url.pathname==='/api/support/status'){
    let ready=false;
    if(support&&supportAuthKey){
      try{
        const check=await pool.query("SELECT to_regclass('public.website_support_tickets') IS NOT NULL AS ready");
        ready=check.rows[0]?.ready===true;
      }catch{ready=false;}
    }
    json(res,200,{available:ready});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/support/ticket'){
    const matched=supportCookiePattern.exec(cookie(req,supportCookie)??'');
    if(!matched){json(res,200,{status:'NONE'});return;}
    const tokenHash=sessionHash(matched[2]);
    const result=await pool.query(
      "SELECT delivery_state,answer,answered_at FROM website_support_tickets WHERE id=$1 AND token_sha256=$2",
      [matched[1],tokenHash]);
    if(result.rowCount!==1){json(res,200,{status:'NONE'});return;}
    json(res,200,{status:result.rows[0].delivery_state,
      answer:result.rows[0].answer??null,
      answeredAt:result.rows[0].answered_at?.toISOString()??null});
    return;
  }
  if(req.method==='GET'&&url.pathname==='/api/support/operator-inbox'){
    if(!support||!supportAuthKey){json(res,503,{code:'SUPPORT_NOT_CONFIGURED'});return;}
    const page=url.searchParams.get('offset')??'0';
    if(!/^(0|[1-9][0-9]{0,2})$/.test(page)||Number(page)>199){
      json(res,400,{code:'INVALID_INBOX_PAGE'});return;
    }
    const offset=Number(page);
    const stamp=req.headers['x-mnebyvpn-support-ts'];
    const signature=req.headers['x-mnebyvpn-support-signature'];
    if(typeof stamp!=='string'||!/^[0-9]{9,12}$/.test(stamp)||
       Math.abs(Date.now()/1000-Number(stamp))>60||
       typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    const expected=createHmac('sha256',supportAuthKey)
      .update(offset===0?'MNEBYVPN-inbox-v1\n'+stamp:
        'MNEBYVPN-inbox-v2\n'+stamp+'\n'+offset).digest('hex');
    if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'))){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    const result=await pool.query(
      "SELECT id,contact,question FROM website_support_tickets "+
      "WHERE answer IS NULL AND delivery_state IN ('PENDING','DELIVERED') "+
      "ORDER BY created_at ASC, id ASC LIMIT 2 OFFSET $1",[offset]);
    res.setHeader('Cache-Control','no-store');
    json(res,200,{ticket:result.rows[0]??null,hasNext:result.rows.length>1});return;
  }
  if(req.method==='POST'&&url.pathname==='/api/support/operator-reply'){
    if(!support||!supportAuthKey){json(res,503,{code:'SUPPORT_NOT_CONFIGURED'});return;}
    if(!req.headers['content-type']?.startsWith('application/json')){
      json(res,415,{code:'UNSUPPORTED_MEDIA_TYPE'});return;
    }
    const body=await bodyJson(req);
    const ticketId=body.ticketId,message=body.message;
    if(typeof ticketId!=='string'||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ticketId)||
       !validSupportText(message,1,1500)){
      json(res,400,{code:'INVALID_REPLY'});return;
    }
    const signature=req.headers['x-mnebyvpn-support-signature'];
    if(typeof signature!=='string'||!/^[0-9a-f]{64}$/i.test(signature)){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    const expected=createHmac('sha256',supportAuthKey)
      .update('MNEBYVPN-support\n'+ticketId+'\n'+message).digest('hex');
    if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'))){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    const updated=await pool.query(
      "UPDATE website_support_tickets SET answer=$2,answered_at=clock_timestamp() "+
      "WHERE id=$1 AND answer IS NULL AND delivery_state<>'FAILED' RETURNING id",
      [ticketId,message.trim()]);
    if(updated.rowCount!==1){json(res,409,{code:'TICKET_NOT_OPEN'});return;}
    json(res,200,{saved:true});return;
  }
  if(req.method==='POST'&&url.pathname==='/api/internal/gsc-report'){
    // Only the existing primary bot may relay this analytics summary.
    // The report's owner ID is read from the already deployed server config.
    if(!support?.botToken){
      json(res,503,{code:'GSC_OWNER_RELAY_NOT_CONFIGURED'});return;
    }
    if(!req.headers['content-type']?.startsWith('application/json')){
      json(res,415,{code:'UNSUPPORTED_MEDIA_TYPE'});return;
    }
    const timestamp=req.headers['x-mnebyvpn-gsc-ts'];
    const signature=req.headers['x-mnebyvpn-gsc-signature'];
    if(typeof timestamp!=='string'||typeof signature!=='string'||
      !/^[1-9][0-9]{9}$/.test(timestamp)||!/^[a-f0-9]{64}$/.test(signature)){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    const body=await bodyJson(req,12000);
    if(Object.keys(body).some(key=>key!=='text')||
      !verifyGscOwnerRelaySignature(support.botToken,timestamp,signature,body.text)){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    if(!gscRelayReplayLimit(signature)){
      json(res,409,{code:'GSC_REPORT_ALREADY_ACCEPTED'});return;
    }
    try{
      await telegramSupportSend(support,body.text as string,support.operatorId);
    }catch{
      json(res,502,{code:'GSC_TELEGRAM_DELIVERY_FAILED'});return;
    }
    json(res,200,{delivered:true});return;
  }
  if(req.method==='POST'&&url.pathname==='/api/support'){
    if(!support||!supportAuthKey){json(res,503,{code:'SUPPORT_NOT_CONFIGURED'});return;}
    if(req.headers.origin!==publicOrigin||
      !req.headers['content-type']?.startsWith('application/json')){
      json(res,403,{code:'INVALID_ORIGIN'});return;
    }
    const body=await bodyJson(req);
    if(Object.keys(body).some(key=>!['contact','message','website'].includes(key))||
       (body.website!==undefined&&body.website!=='')||
       !validSupportContact(body.contact)||!validSupportText(body.message)){
      json(res,400,{code:'INVALID_SUPPORT_REQUEST'});return;
    }
    const contact=body.contact.trim(),message=body.message.trim();
    const contactKey=createHash('sha256').update(contact.toLowerCase()).digest('hex');
    if(!contactLimit(contactKey)||!globalSupportLimit('global')){
      json(res,429,{code:'SUPPORT_RATE_LIMIT'});return;
    }
    const ticketId=randomUUID(),ticketToken=randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO website_support_tickets(id,token_sha256,contact,question) VALUES($1,$2,$3,$4)",
      [ticketId,sessionHash(ticketToken),contact,message]);
    if(!support.botToken){
      // Tokenless webhook mode: guest site tickets are durably queued, then
      // opened and answered by the operator via /inbox in the SAME bot.
      // Do not call this "delivered" to Telegram; no Bot API send occurred.
      setCookie(res,supportCookie,ticketId+'.'+ticketToken,60*60*24*30);
      json(res,200,{queued:true,webTicket:true});return;
    }
    // A temporary Telegram failure must never erase the customer's only
    // support route. Keep the durable PENDING ticket in the operator inbox.
    let delivered=false;
    try{
      await telegramSupportSend(support,
        '✉️ MNEBYVPN — обращение с сайта\nЗаявка: '+ticketId+
        '\nКонтакт: '+contact+'\n\nСообщение:\n'+message,support.operatorId,
        {inline_keyboard:[
          [{text:'✍️ Ответить',callback_data:'support:reply:site:'+ticketId}],
          [{text:'📥 Входящие заявки',callback_data:'support:page:0'}],
        ]});
      delivered=true;
    }catch{
      // The Bot API did not confirm delivery. The operator can still find
      // the ticket with the "Входящие заявки" button in the same bot.
    }
    if(delivered){
      // A database hiccup after confirmed delivery must not turn a delivered
      // Telegram message into an apparent failed customer request.
      await pool.query("UPDATE website_support_tickets SET delivery_state='DELIVERED',delivered_at=clock_timestamp() WHERE id=$1",
        [ticketId]).catch(()=>{});
    }
    setCookie(res,supportCookie,ticketId+'.'+ticketToken,60*60*24*30);
    json(res,200,delivered?{delivered:true,webTicket:true}:{queued:true,webTicket:true});
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
  if(req.method==='POST' && url.pathname==='/api/auth/email/start'){
    await emailStart(req,res);return;
  }
  if(req.method==='POST' && url.pathname==='/api/auth/email/verify'){
    await emailVerify(req,res);return;
  }
  if(req.method==='GET' && url.pathname==='/auth/login'){
    await login(req,res,url);return;
  }
  if(req.method==='GET' && url.pathname==='/auth/callback'){
    if(!telegramLoginEnabled){
      json(res,503,{code:'TELEGRAM_LOGIN_NOT_READY'});return;
    }
    await callback(req,res,url);return;
  }
  // YooKassa webhooks NEVER trust unauthenticated JSON alone: every event
  // is re-verified directly against YooKassa GET /v3/payments/{id} or /v3/refunds/{id}.
  if (req.method === 'POST' && url.pathname === '/webhooks/yookassa') {
    if (!yookassaWebhookEnabled || !yookassa) {send(res,503,'NOT_READY','text/plain; charset=utf-8');return;}
    if (process.env.YOOKASSA_WEBHOOK_ENFORCE_IP === 'yes') {
      const allowed=process.env.YOOKASSA_WEBHOOK_ALLOWED_IPS?.split(',').map(s=>s.trim()).filter(Boolean);
      if (!isAllowedYookassaWebhookIp(sourceAddress(req), allowed && allowed.length ? allowed : undefined)) {
        send(res,403,'FORBIDDEN','text/plain; charset=utf-8');return;
      }
    }
    const ct=req.headers['content-type'];
    if (typeof ct!=='string' || !ct.toLowerCase().startsWith('application/json')) {
      send(res,415,'UNSUPPORTED_MEDIA_TYPE','text/plain; charset=utf-8');return;
    }
    try {
      const raw=(await readPaymentBody(req)).toString('utf8');
      const parsed:unknown=JSON.parse(raw);
      const answer=await handleYookassaDelivery(parsed,store,new HttpYookassaTransport(yookassa));
      console.info('MNEBYVPN_YOOKASSA_WEBHOOK_RESULT',answer.statusCode,answer.text);
      send(res,answer.statusCode,answer.text,'text/plain; charset=utf-8');
    } catch(error) {
      const sqlstate=(error as {code?:unknown})?.code;
      console.error('MNEBYVPN_YOOKASSA_WEBHOOK_PROCESSING_ERROR',
        typeof sqlstate==='string'&&/^[0-9A-Z]{5}$/.test(sqlstate)
          ?'SQLSTATE_'+sqlstate:'PARSE_OR_PROCESSING_FAILURE');
      send(res,503,'WEBHOOK_PROCESSING_ERROR','text/plain; charset=utf-8');
    }
    return;
  }
  // Legacy Prodamus callback support for in-flight payments during migration.
  if (req.method === 'POST' && url.pathname === '/webhooks/prodamus') {
    if (!webhookEnabled || !payform) {send(res,503,'NOT_READY','text/plain; charset=utf-8');return;}
    const sign=req.headers.sign;
    const ct=req.headers['content-type'];
    if (typeof sign!=='string' || !/^[0-9a-f]{64}$/i.test(sign)) {
      send(res,401,'UNSIGNED','text/plain; charset=utf-8');return;
    }
    // Prodamus sends application/x-www-form-urlencoded. Accept its
    // documented delivery format and supported multipart callbacks only.
    if (typeof ct!=='string' || !isProdamusContentType(ct)) {
      send(res,415,'UNSUPPORTED_MEDIA_TYPE','text/plain; charset=utf-8');return;
    }
    try {
      const fields=await parseProdamusFormData(ct,await readPaymentBody(req));
      const answer=await handleProdamusDelivery(fields,sign,store,payform);
      // Log only stable result codes, never payment payloads, emails or signatures.
      console.info('MNEBYVPN_PRODAMUS_WEBHOOK_RESULT',answer.statusCode,answer.text);
      send(res,answer.statusCode,answer.text,'text/plain; charset=utf-8');
    } catch(error) {
      const sqlstate=(error as {code?:unknown})?.code;
      console.error('MNEBYVPN_PRODAMUS_WEBHOOK_PROCESSING_ERROR',
        typeof sqlstate==='string'&&/^[0-9A-Z]{5}$/.test(sqlstate)
          ?'SQLSTATE_'+sqlstate:'PARSE_OR_PROCESSING_FAILURE');
      send(res,503,'WEBHOOK_PROCESSING_ERROR','text/plain; charset=utf-8');
    }
    return;
  }
  // Login availability must remain readable even when the billing catalog
  // is temporarily unavailable (do not require a pricing DB query).
  if (req.method === 'GET' && url.pathname === '/api/auth/options') {
    json(res,200,{loginEnabled,telegramLoginEnabled,emailLoginEnabled});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/plans') {
    json(res,200,await publicCatalog());return;
  }
  // Reject every anonymous trial request, even if a stale operator flag remains enabled.
  if(url.pathname.startsWith('/api/guest/')){
    json(res,403,{code:'AUTH_REQUIRED_FOR_TRIAL'});return;
  }
  // Everything below is a protected API endpoint. Unknown public paths are
  // genuine 404s, not login-required responses (important for search crawlers).
  if(!url.pathname.startsWith('/api/')){
    res.setHeader('X-Robots-Tag','noindex, follow');
    json(res,404,{code:'NOT_FOUND'});return;
  }
  const auth = await authorized(req);
  if (!auth) { json(res, 401, { code: 'LOGIN_REQUIRED' }); return; }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const dashboard = await loadDashboard(authPool, auth.accountId, meteringVerified);
    json(res,200,{ ...dashboard, telegramProxyBonusEnabled:proxyBonusEnabled||wsProxyEnabled, wsProxyEnabled, appleDnsProfileEnabled, personalDnsEnabled:appleDnsProfileEnabled,
      fiAwgRegistrationAvailable, identity:{provider:auth.email?'email':'telegram',email:auth.email,emailLinked:!!auth.email,telegramLinked:auth.telegramUserId!==null,yandexLinked:false}, csrf:csrfForSession(auth.raw,sessionSecret) }); return;
  }

  async function issuePersonalDnsFromRequest(
    req: IncomingMessage,
    res: ServerResponse,
    rawSession: string,
  ): Promise<ReturnType<typeof issueWebsitePersonalDnsProfile> | null> {
    if(!csrfAllowed(req,rawSession)){json(res,403,{code:'FORBIDDEN'});return null;}
    if(!appleDnsProfileEnabled){json(res,503,{code:'APPLE_DNS_PROFILE_NOT_READY'});return null;}
    const body=await bodyJson(req);
    const entitlementId=body.entitlementId;
    const action=body.action;
    const revision=body.expectedRevision;
    if(typeof entitlementId!=='string'||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entitlementId)||
      (action!=='issue'&&action!=='rotate')||
      (action==='issue'&&Object.keys(body).sort().join(',')!=='action,entitlementId')||
      (action==='rotate'&&
        (Object.keys(body).sort().join(',')!=='action,entitlementId,expectedRevision'||
         !Number.isSafeInteger(revision)||Number(revision)<1))){
      json(res,400,{code:'INVALID_DNS_PROFILE_REQUEST'});return null;
    }
    const result=await issueWebsitePersonalDnsProfile(authPool,sessionHash(rawSession),
      entitlementId,action,action==='rotate'?revision as number:undefined);
    if(result.kind!=='ready'){
      const code=result.kind==='already-issued'?'DNS_PROFILE_ALREADY_ISSUED':
        result.kind==='stale'?'DNS_PROFILE_REVISION_CHANGED':
        result.kind==='inactive'?'DNS_ACCESS_NOT_ACTIVE':
        result.kind==='revoked'?'DNS_ACCESS_REVOKED':'DNS_PROFILE_UNAVAILABLE';
      json(res,result.kind==='already-issued'||result.kind==='stale'?409:
        result.kind==='inactive'||result.kind==='revoked'?403:503,{code});return null;
    }
    return result;
  }

  if(req.method==='GET'&&url.pathname==='/api/dns/apple/status'){
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag','noindex');
    if(!appleDnsProfileEnabled){json(res,503,{code:'APPLE_DNS_PROFILE_NOT_READY'});return;}
    const entitlementId=url.searchParams.get('entitlementId')??'';
    if(url.searchParams.size!==1||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entitlementId)){
      json(res,400,{code:'INVALID_ENTITLEMENT'});return;
    }
    const status=await websitePersonalDnsStatus(authPool,sessionHash(auth.raw),entitlementId);
    if(!status){json(res,404,{code:'DNS_ACCESS_NOT_ACTIVE'});return;}
    json(res,200,status);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/dns/apple/profile'){
    // A sensitive, one-time bearer hostname is issued only after verified
    // login+CSRF, paid ACTIVE entitlement and dedicated DB RPC authorization.
    const result=await issuePersonalDnsFromRequest(req,res,auth.raw);
    if(!result||result.kind!=='ready')return;
    res.setHeader('Content-Disposition','attachment; filename="MNEBYDNS-Apple.mobileconfig"');
    res.setHeader('Pragma','no-cache');
    res.setHeader('X-Robots-Tag','noindex');
    send(res,200,result.xml,'application/x-apple-aspen-config');
    return;
  }
  if(req.method==='POST'&&url.pathname==='/api/dns/personal/credentials'){
    // Issues/rotates the same one-time personal DoT identity and returns BOTH
    // the Apple .mobileconfig payload and the plain DoT hostname for Android/routers.
    const result=await issuePersonalDnsFromRequest(req,res,auth.raw);
    if(!result||result.kind!=='ready')return;
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('Pragma','no-cache');
    res.setHeader('X-Robots-Tag','noindex');
    json(res,200,{hostname:result.hostname,mobileconfig:result.xml});
    return;
  }
  if(req.method==='GET'&&url.pathname==='/api/telegram-proxy-bonus'){
    // Do not expose credential-bearing URLs to an anonymous buyer, a
    // pending order, a trial, another account, or an expired entitlement.
    // No account ID is accepted from query arguments.
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('Referrer-Policy','no-referrer');
    if(!proxyBonusEnabled&&!wsProxyEnabled){
      json(res,503,{code:'PROXY_BONUS_NOT_READY'});return;
    }
    const entitlementId=url.searchParams.get('entitlementId')??'';
    if(url.searchParams.size!==1||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entitlementId)){
      json(res,400,{code:'INVALID_ENTITLEMENT'});return;
    }
    const routes=proxyBonusEnabled?parseBonusRoutes(process.env.WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON):null;
    const wsRoutes=wsProxyEnabled?parseWsProxyRoutes(process.env.WEB_TELEGRAM_WS_PROXY_ROUTES_JSON):null;
    if((proxyBonusEnabled&&!routes)||(wsProxyEnabled&&!wsRoutes)){
      json(res,503,{code:'PROXY_BONUS_NOT_READY'});return;
    }
    const [mtBonus,wsBonus]=await Promise.all([
      routes?loadCustomerProxyBonus(authPool,auth.accountId,entitlementId,process.env.WEB_DNS_MT_PROXY_BONUS_KEY??'',routes):Promise.resolve(null),
      wsRoutes?loadCustomerWsProxy(authPool,auth.accountId,entitlementId,wsRoutes):Promise.resolve(null),
    ]);
    if(!mtBonus&&!wsBonus){json(res,404,{code:'PROXY_BONUS_NOT_ASSIGNED'});return;}
    json(res,200,{
      expiresAt:wsBonus?.expiresAt??mtBonus!.expiresAt,
      links:mtBonus?.links??[],
      wsLinks:wsBonus?.wsLinks??[],
    });return;
  }
  if(req.method==='POST'&&url.pathname==='/api/referral-link'){
    if(!csrfAllowed(req,auth.raw)){json(res,403,{code:'FORBIDDEN'});return;}
    const invite=await store.websiteReferralInvite(auth.accountId);
    if(!invite){json(res,503,{code:'REFERRALS_NOT_AVAILABLE'});return;}
    const botUrl='https://t.me/MNEBYVPN_bot?start=r'+invite.token;
    const websiteUrl=publicOrigin+'/?ref='+encodeURIComponent(invite.token)+
      '&product=vpn&days='+invite.days;
    json(res,200,{botUrl,websiteUrl,days:invite.days,rewardsEnabled:false});return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    if (!csrfAllowed(req,auth.raw)) { json(res,403,{code:'FORBIDDEN'});return; }
    await authPool.query(`UPDATE website_sessions SET revoked_at=clock_timestamp()
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
    const device=cookie(req,deviceCookie);
    if(!device||!/^[A-Za-z0-9_-]{43}$/.test(device)){
      json(res,403,{code:'BROWSER_VERIFICATION_REQUIRED'});return;
    }
    const result = await store.grantTrial(auth.accountId,
      body.product as 'vpn'|'smart_dns'|'bundle',body.inviteToken as string|undefined,
      createHash('sha256').update('trial-device-v1:').update(device).digest('hex'));
    json(res,200,{status:result.status,expiresAt:result.expiresAt?.toISOString()??null});
    return;
  }
  if((req.method==='POST'&&url.pathname==='/api/awg/fi/device')||
     (req.method==='GET'&&url.pathname==='/api/awg/fi/device/status')){
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    if(!fiAwgRegistrationAvailable){json(res,503,{code:'AWG_REGISTRATION_NOT_READY'});return;}
    if(!sameCanonicalPostgresDb(authDbUrl??'',subscriptionDbUrl)){
      json(res,503,{code:'CANONICAL_AWG_DATABASE_UNAVAILABLE'});return;
    }
    if(req.method==='POST'&&
       (!csrfAllowed(req,auth.raw)||req.headers.origin!==publicOrigin||
        req.headers['content-type']?.split(';')[0].trim()!=='application/json')){
      json(res,403,{code:'FORBIDDEN'});return;
    }
    const payload=req.method==='POST'?await bodyJson(req):{
      entitlementId:url.searchParams.get('entitlementId'),
      peerPublicKey:url.searchParams.get('peer'),
    };
    const entitlementId=payload.entitlementId;
    const peerPublicKey=payload.peerPublicKey;
    if(Object.keys(payload).sort().join(',')!=='entitlementId,peerPublicKey'||
       typeof entitlementId!=='string'||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entitlementId)||
       !isCanonicalAwgPublicKey(peerPublicKey)){
      json(res,400,{code:'INVALID_AWG_DEVICE_REQUEST'});return;
    }
    try{
      if(req.method==='POST'){
        const result=await authPool.query(
          'SELECT public.website_request_fi_awg_device($1,$2::uuid,$3) AS state',
          [sessionHash(auth.raw),entitlementId,peerPublicKey]);
        const state=result.rows[0]?.state;
        if(state==='QUEUED'){json(res,202,{state:'QUEUED'});return;}
        json(res,state==='DENY_BOUND'?409:403,
          {code:state==='DENY_BOUND'?'AWG_DEVICE_ALREADY_BOUND':'AWG_ACCESS_DENIED'});
      }else{
        const result=await authPool.query(
          'SELECT public.website_fi_awg_device_status($1,$2::uuid,$3) AS state',
          [sessionHash(auth.raw),entitlementId,peerPublicKey]);
        const state=result.rows[0]?.state;
        if(!['QUEUED','PROCESSING','STAGED','ACKNOWLEDGED','BLOCKED'].includes(state)){
          json(res,404,{code:'AWG_DEVICE_NOT_ACTIVE'});return;
        }
        json(res,200,{state});
      }
    }catch{
      json(res,503,{code:'AWG_DEVICE_QUEUE_UNAVAILABLE'});
    }
    return;
  }
  if(req.method==='POST' && url.pathname==='/api/vpn/subscription'){
    if(!csrfAllowed(req,auth.raw)){json(res,403,{code:'FORBIDDEN'});return;}
    if(!networkVerified||!subscriptionPool){json(res,503,{code:'VPN_NOT_READY'});return;}
    const body=await bodyJson(req);
    const requestedId=body.entitlementId;
    if(requestedId!==undefined&&(typeof requestedId!=='string'||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId))){
      json(res,400,{code:'INVALID_ENTITLEMENT'});return;
    }
    const link=await issueSubscriptionLinkForAccount(authPool,auth.accountId,requestedId as string|undefined);
    if(!link){json(res,409,{code:'VPN_NOT_ACTIVE'});return;}
    json(res,200,{subscriptionUrl:link.link,expiresAt:link.expiresAt.toISOString()});
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/orders/verify') {
    if (!csrfAllowed(req,auth.raw)) { json(res,403,{code:'FORBIDDEN'});return; }
    if (!yookassaWebhookEnabled || !yookassa) {
      json(res,503,{code:'PAYMENT_NOT_AVAILABLE'});return;
    }
    const body = await bodyJson(req);
    const orderId = body.orderId;
    if (typeof orderId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      json(res,400,{code:'INVALID_ORDER'});return;
    }
    const order = await store.order(orderId);
    if (!order || order.accountId !== auth.accountId) {
      json(res,404,{code:'ORDER_NOT_FOUND'});return;
    }
    if (order.state !== 'PENDING' || order.provider !== 'yookassa') {
      json(res,200,{state:order.state});return;
    }
    const paymentId = await store.yookassaPaymentIdForOrder(order.id);
    if (!paymentId) {
      json(res,200,{state:order.state});return;
    }
    try {
      const transport = new HttpYookassaTransport(yookassa);
      const paymentObj = await transport.getPayment(paymentId);
      const checked = verifyYookassaPaymentObject(paymentObj, yookassaOrderFromDB(order));
      if (checked.ok) {
        await store.settleVerified(checked.capture);
        json(res,200,{state:'PAID'});return;
      }
      json(res,200,{state:order.state});
    } catch {
      json(res,502,{code:'PAYMENT_PROVIDER_UNAVAILABLE'});
    }
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/api/checkout' || url.pathname === '/api/renew')) {
    if (!csrfAllowed(req,auth.raw)) { json(res,403,{code:'FORBIDDEN'});return; }
    if (!checkoutEnabled || (!yookassa && !payform)) {
      json(res,503,{code:'PAYMENT_NOT_AVAILABLE'});return;
    }
    const body = await bodyJson(req);
    // Web payment forms must receive the verified email from the session.
    // Telegram-only users link an email once; never trust buyer-supplied body.email.
    if(!auth.email){
      json(res,409,{code:'VERIFIED_EMAIL_REQUIRED'});return;
    }
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
    try {
      const checkoutInput = {
        accountId: auth.accountId, email:auth.email, planId: body.planId,
        requestId: 'web:' + body.requestId,
        inviteToken: body.inviteToken as string|undefined,
        renewalTargetId: isRenewal ? body.renewalTargetId as string : undefined,
      };
      if (yookassaWebhookEnabled && yookassa) {
        const testHost = offline && process.env.YOOKASSA_API_ORIGIN
          ? new URL(process.env.YOOKASSA_API_ORIGIN).hostname
          : undefined;
        const purchase = await prepareWebsiteYookassaCheckout(
          checkoutInput, store, yookassa, new HttpYookassaTransport(yookassa), testHost,
        );
        json(res,200,{orderId:purchase.orderId,paymentUrl:purchase.paymentUrl});
      } else if (webhookEnabled && payform) {
        const purchase = await prepareWebsiteProdamusCheckout(
          checkoutInput, store, payform, new MerchantTransport(),
        );
        json(res,200,{orderId:purchase.orderId,paymentUrl:purchase.paymentUrl});
      } else {
        json(res,503,{code:'PAYMENT_NOT_AVAILABLE'});
      }
    } catch (error) {
      const reason=error instanceof Error?error.message:'';
      // Only stable, safe codes go to the browser. Never expose DB details,
      // payment provider responses, account IDs or signed checkout URLs.
      if (reason==='PENDING_CHECKOUT_RATE_LIMIT') {
        json(res,429,{code:'CHECKOUT_RETRY_LIMIT'});return;
      }
      if (reason==='PAYMENT_PROVIDER_UNAVAILABLE') {
        console.warn('MNEBYVPN_CHECKOUT_PROVIDER_UNAVAILABLE');
        json(res,502,{code:'PAYMENT_PROVIDER_UNAVAILABLE'});return;
      }
      if (reason==='PAYMENT_PROVIDER_INVALID_LINK' ||
          reason==='Unsafe YooKassa confirmation URL' ||
          reason==='Invalid YooKassa confirmation URL' ||
          reason==='Invalid URL') {
        console.warn('MNEBYVPN_CHECKOUT_PROVIDER_INVALID_LINK');
        json(res,502,{code:'PAYMENT_PROVIDER_INVALID_LINK'});return;
      }
      const sqlstate=(error as {code?:unknown})?.code;
      if (typeof sqlstate==='string' && /^[0-9A-Z]{5}$/.test(sqlstate))
        console.error('MNEBYVPN_CHECKOUT_DB_ERROR_SQLSTATE_'+sqlstate);
      else console.error('MNEBYVPN_CHECKOUT_SERVICE_ERROR');
      json(res,503,{code:'CHECKOUT_SERVICE_ERROR'});
    }
    return;
  }
  res.setHeader('X-Robots-Tag','noindex, follow');
  json(res,404,{code:'NOT_FOUND'});
}
const port = Number(process.env.WEB_PORT ?? '8791');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEB_PORT');
// Ticket retention follows the thirty-day browser access window. Fail-safe
// cleanup never logs customer messages or interrupts other website endpoints.
async function purgeExpiredSupportTickets(){
  await pool.query("DELETE FROM website_support_tickets WHERE created_at<clock_timestamp()-interval '30 days'");
}
void purgeExpiredSupportTickets().catch(()=>{});
setInterval(()=>{void purgeExpiredSupportTickets().catch(()=>{});},6*60*60_000).unref();
const server = createServer((req,res) => {
  handle(req,res).catch(() => json(res,503,{code:'SERVICE_UNAVAILABLE'}));
});
server.listen(port, '127.0.0.1', () => {
  console.info('MNEBYVPN website listening on loopback port ' + port);
});
