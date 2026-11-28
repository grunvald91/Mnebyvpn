/** Entitlement-scoped Telegram MTProxy bonus. Customer side ONLY. */
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
export type ProxyBonusRoute={route:'direct'|'ru';host:string;port:number};
export type ProxyBonusLink=ProxyBonusRoute&{label:string;url:string;tgUrl:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hexSecret=/^[a-f0-9]{32}$/i;
const hexKey=/^[a-f0-9]{64}$/i;
const hostRegex=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
function validHost(s:string):boolean {
  return s.length<=253&&hostRegex.test(s)&&!s.includes('..')&&
    !['localhost','0.0.0.0','127.0.0.1'].includes(s.toLowerCase());
}
function validDomain(s:string):boolean {
  return s.length<=253&&validHost(s)&&s.includes('.')&&
    s.split('.').every(part=>part.length>=1&&part.length<=63&&
      !part.startsWith('-')&&!part.endsWith('-'));
}
export function parseBonusRoutes(raw:string|undefined):ProxyBonusRoute[]|null{
  if(!raw)return null;
  try{
    const input:unknown=JSON.parse(raw);
    if(!Array.isArray(input)||input.length!==2)return null;
    const routes:ProxyBonusRoute[]=[];
    for(const entry of input){
      if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
      const e=entry as Record<string,unknown>;
      if(Object.keys(e).sort().join(',')!=='host,port,route')return null;
      if(e.route!=='direct'&&e.route!=='ru')return null;
      if(typeof e.host!=='string'||!validHost(e.host))return null;
      if(!Number.isSafeInteger(e.port)||Number(e.port)<1024||
        Number(e.port)>65535||Number(e.port)===443)return null;
      routes.push({route:e.route,host:e.host,port:e.port as number});
    }
    if(routes[0].route===routes[1].route||
       (routes[0].host===routes[1].host&&routes[0].port===routes[1].port))return null;
    return routes.sort((a,b)=>a.route==='direct'?-1:1);
  }catch{return null;}
}
/** Private-owner sale: only the independently checked direct Telemt ingress.
 * Public MTProxy releases keep their existing two-route contract unchanged.
 * Adding a Russian relay requires a separate verification and code review.
 */
export function parseOwnerProxyRoutes(raw:string|undefined):ProxyBonusRoute[]|null{
  if(!raw)return null;
  try{
    const parsed:unknown=JSON.parse(raw);
    if(!Array.isArray(parsed)||parsed.length!==1)return null;
    const one=parsed[0];
    if(!one||typeof one!=='object'||Array.isArray(one))return null;
    const route=one as Record<string,unknown>;
    if(Object.keys(route).sort().join(',')!=='host,port,route')return null;
    if(route.route!=='direct'||route.host!=='89.125.90.101'||route.port!==9446)
      return null;
    return [{route:'direct',host:'89.125.90.101',port:9446}];
  }catch{return null;}
}

function keyOf(value:string):Buffer{
  if(!hexKey.test(value))throw new Error('MTProxy credential key unavailable');
  return Buffer.from(value,'hex');
}
function aad(entitlementId:string,username:string):Buffer{
  if(!uuid.test(entitlementId)||!/^dns_[0-9a-f]{24}$/.test(username))
    throw new Error('Invalid credential owner');
  return Buffer.from('mnebyvpn:mtproxy:v1:'+entitlementId.toLowerCase()+':'+username,'utf8');
}
/** Only the private provisioner should call sealProxySecret. */
export function sealProxySecret(
  rawSecret:string,keyHex:string,entitlementId:string,username:string,
):string{
  if(!hexSecret.test(rawSecret))throw new Error('Invalid 16-byte MTProxy secret');
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',keyOf(keyHex),nonce);
  cipher.setAAD(aad(entitlementId,username));
  const payload=Buffer.concat([cipher.update(rawSecret.toLowerCase(),'utf8'),cipher.final()]);
  return 'v1.'+nonce.toString('base64url')+'.'+
    cipher.getAuthTag().toString('base64url')+'.'+payload.toString('base64url');
}
export function openProxySecret(
  box:string,keyHex:string,entitlementId:string,username:string,
):string{
  if(typeof box!=='string'||box.length>512)throw new Error('Invalid encrypted credential');
  const p=box.split('.');
  if(p.length!==4||p[0]!=='v1')throw new Error('Invalid encrypted credential');
  const nonce=Buffer.from(p[1],'base64url');
  const tag=Buffer.from(p[2],'base64url');
  const body=Buffer.from(p[3],'base64url');
  if(nonce.length!==12||tag.length!==16||body.length!==32)
    throw new Error('Invalid encrypted credential');
  const dec=createDecipheriv('aes-256-gcm',keyOf(keyHex),nonce);
  dec.setAAD(aad(entitlementId,username));
  dec.setAuthTag(tag);
  const raw=Buffer.concat([dec.update(body),dec.final()]).toString('utf8');
  if(!hexSecret.test(raw))throw new Error('Invalid credential payload');
  return raw.toLowerCase();
}
function makeCheckedBonusLinks(
  secret:string,tlsDomain:string,checked:ProxyBonusRoute[],
):ProxyBonusLink[]{
  if(!hexSecret.test(secret)||!validDomain(tlsDomain))
    throw new Error('Invalid MTProxy profile');
  const fakeTlsSecret='ee'+secret.toLowerCase()+
    Buffer.from(tlsDomain,'ascii').toString('hex');
  return checked.map(route=>{
    const query=new URLSearchParams({
      server:route.host,port:String(route.port),secret:fakeTlsSecret,
    }).toString();
    return {
      ...route,
      label:route.route==='direct'?'Напрямую через зарубежный сервер':'Через российский сервер',
      url:'https://t.me/proxy?'+query,
      tgUrl:'tg://proxy?'+query,
    };
  });
}
/** Public contract: two distinct routes remain mandatory. */
export function makeBonusLinks(
  secret:string,tlsDomain:string,routes:ProxyBonusRoute[],
):ProxyBonusLink[]{
  const checked=parseBonusRoutes(JSON.stringify(routes));
  if(!checked)throw new Error('Unverified MTProxy routes');
  return makeCheckedBonusLinks(secret,tlsDomain,checked);
}
/** Private contract: never give owners an unverified Russian route. */
export function makeOwnerProxyLinks(
  secret:string,tlsDomain:string,routes:ProxyBonusRoute[],
):ProxyBonusLink[]{
  const checked=parseOwnerProxyRoutes(JSON.stringify(routes));
  if(!checked)throw new Error('Unverified owner MTProxy route');
  return makeCheckedBonusLinks(secret,tlsDomain,checked);
}
type BonusRow={
  entitlement_id:string;expires_at:Date;telemt_username:string;
  secret_box:string;tls_domain:string;
};
/** Authenticated account ID is resolved from the server-side session.
 * Paid DNS, not a trial or refunded order, owns the credential.
 * This never creates or enables users in Telemt. */
export async function loadCustomerProxyBonus(
  db:Pick<Pool,'query'>,accountId:string,entitlementId:string,
  keyHex:string,routes:ProxyBonusRoute[],maxVerificationAgeMinutes=7*24*60,
  ownerOnly=false,
):Promise<{expiresAt:string;links:ProxyBonusLink[]}|null>{
  if(!uuid.test(accountId)||!uuid.test(entitlementId))return null;
  if(!Number.isSafeInteger(maxVerificationAgeMinutes)||
     maxVerificationAgeMinutes<1||maxVerificationAgeMinutes>7*24*60)return null;
  const sql='SELECT e.id AS entitlement_id,e.expires_at,b.telemt_username,'+
    'b.secret_box,b.tls_domain FROM entitlements e '+
    'JOIN orders o ON o.id=e.source_order_id AND o.account_id=e.account_id '+
    'JOIN dns_mtproxy_bonus_credentials b ON b.entitlement_id=e.id '+
    'WHERE e.account_id=$1 AND e.id=$2 AND e.product=$3 '+
    'AND e.state=$4 AND e.starts_at<=clock_timestamp() '+
    'AND e.expires_at>clock_timestamp() AND o.state=$5 '+
    'AND o.product IN ($3,$6) AND b.state=$4 '+
    (ownerOnly?'AND o.provider=\'manual_sale\' '+
      'AND EXISTS(SELECT 1 FROM manual_sales m WHERE m.order_id=o.id) ':'')+
    'AND b.disabled_at IS NULL AND '+
    "b.verified_at>clock_timestamp()-($7::integer * interval '1 minute') LIMIT 1";
  const {rows}=await db.query(sql,[accountId,entitlementId,'smart_dns','ACTIVE','PAID','bundle',maxVerificationAgeMinutes]);
  const row=(rows as BonusRow[])[0];
  if(!row)return null;
  const secret=openProxySecret(row.secret_box,keyHex,row.entitlement_id,row.telemt_username);
  return {expiresAt:row.expires_at.toISOString(),
    links:ownerOnly?makeOwnerProxyLinks(secret,row.tls_domain,routes):
      makeBonusLinks(secret,row.tls_domain,routes)};
}
/** Owner-only private-sale release; does not enable public DNS/MTProxy offers.
 * Requires documented gateway, end-to-end route and runtime revoke verification. */
export function ownerProxyReleaseReady(env:NodeJS.ProcessEnv):boolean{
  return env.MNEBYVPN_OFFLINE_MTPROXY_ISSUE_ENABLED==='yes' &&
    env.MNEBYVPN_OFFLINE_MTPROXY_ROUTES_VERIFIED==='yes' &&
    env.MNEBYVPN_OFFLINE_MTPROXY_REVOKER_VERIFIED==='yes' &&
    hexKey.test(env.WEB_DNS_MT_PROXY_BONUS_KEY??'') &&
    parseOwnerProxyRoutes(env.MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON)!==null;
}
export function bonusReleaseReady(env:NodeJS.ProcessEnv):boolean{
  return env.WEB_DNS_MT_PROXY_BONUS_ENABLED==='yes' &&
    env.WEB_DNS_MT_PROXY_BONUS_E2E_VERIFIED==='yes' &&
    env.WEB_DNS_MT_PROXY_BONUS_REVOKER_VERIFIED==='yes' &&
    hexKey.test(env.WEB_DNS_MT_PROXY_BONUS_KEY??'') &&
    parseBonusRoutes(env.WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON)!==null;
}

export type ProxyWsRoute={route:'direct'|'ru';server:string;secret:string};
export type ProxyWsLink={
  kind:'webproxy';route:'direct'|'ru';label:string;
  server:string;secret:string;url:string;tgUrl:string;
};
const wsServerRegex=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/[A-Za-z0-9_-]{4,64}$/i;
const wsSecretRegex=/^(?:dd)?[a-f0-9]{32}$/i;

export function parseWsProxyRoutes(raw:string|undefined):ProxyWsRoute[]|null{
  if(!raw)return null;
  try{
    const input:unknown=JSON.parse(raw);
    if(!Array.isArray(input)||input.length<1||input.length>2)return null;
    const routes:ProxyWsRoute[]=[];
    const seenRoutes=new Set<string>();
    const seenServers=new Set<string>();
    for(const entry of input){
      if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
      const e=entry as Record<string,unknown>;
      if(Object.keys(e).sort().join(',')!=='route,secret,server')return null;
      if(e.route!=='direct'&&e.route!=='ru')return null;
      if(typeof e.server!=='string'||!wsServerRegex.test(e.server)||
         e.server.includes('..')||e.server.startsWith('127.0.0.1/')||
         e.server.startsWith('localhost/'))return null;
      if(typeof e.secret!=='string'||!wsSecretRegex.test(e.secret))return null;
      if(seenRoutes.has(e.route)||seenServers.has(e.server))return null;
      seenRoutes.add(e.route);seenServers.add(e.server);
      routes.push({route:e.route,server:e.server,secret:e.secret.toLowerCase()});
    }
    return routes.sort((a,b)=>a.route==='ru'?-1:1);
  }catch{return null;}
}

export function wsProxyReleaseReady(env:NodeJS.ProcessEnv):boolean{
  return env.WEB_TELEGRAM_WS_PROXY_ENABLED==='yes' &&
    parseWsProxyRoutes(env.WEB_TELEGRAM_WS_PROXY_ROUTES_JSON)!==null;
}

export function makeWsProxyLinks(routes:ProxyWsRoute[]):ProxyWsLink[]{
  const checked=parseWsProxyRoutes(JSON.stringify(routes));
  if(!checked)throw new Error('Unverified WebSocket proxy routes');
  return checked.map(route=>{
    const rawHex=route.secret.length===34&&route.secret.startsWith('dd')
      ?route.secret.slice(2):route.secret;
    const marked=Buffer.concat([Buffer.from([0x70]),Buffer.from(rawHex,'hex')]).toString('base64url');
    const encodedServer=encodeURIComponent(route.server);
    const query='server='+encodedServer+'&secret='+encodeURIComponent(marked);
    return {
      kind:'webproxy',
      route:route.route,
      label:route.route==='ru'
        ?'Через российский сервер (WebSocket HTTPS :443)'
        :'Напрямую через зарубежный сервер (WebSocket HTTPS :443)',
      server:route.server,
      secret:route.secret,
      url:'https://t.me/webproxy?'+query,
      tgUrl:'tg://webproxy?'+query,
    };
  });
}

export async function loadCustomerWsProxy(
  db:Pick<Pool,'query'>,accountId:string,entitlementId:string,
  routes:ProxyWsRoute[],
):Promise<{expiresAt:string;wsLinks:ProxyWsLink[]}|null>{
  if(!uuid.test(accountId)||!uuid.test(entitlementId))return null;
  const sql='SELECT e.expires_at FROM entitlements e '+
    'JOIN orders o ON o.id=e.source_order_id AND o.account_id=e.account_id '+
    'WHERE e.account_id=$1 AND e.id=$2 AND e.product=$3 '+
    'AND e.state=$4 AND e.starts_at<=clock_timestamp() '+
    'AND e.expires_at>clock_timestamp() AND o.state=$5 '+
    'AND o.product IN ($3,$6) LIMIT 1';
  const {rows}=await db.query(sql,[accountId,entitlementId,'smart_dns','ACTIVE','PAID','bundle']);
  const row=(rows as {expires_at:Date}[])[0];
  if(!row)return null;
  return {expiresAt:row.expires_at.toISOString(),wsLinks:makeWsProxyLinks(routes)};
}

/** Shared WS routes are intentionally reusable after a bundle trial ends.
 * This is separate from paid-only personalized MTProto credentials.
 * The caller must supply existing verified, owner-designated shared routes. */
export async function loadSharedTrialWsProxy(
  db:Pick<Pool,'query'>,accountId:string,routes:ProxyWsRoute[],
):Promise<{wsLinks:ProxyWsLink[]}|null>{
  if(!uuid.test(accountId))return null;
  const {rows}=await db.query(
    `SELECT 1 FROM trial_grants t JOIN orders o
       ON o.id=t.order_id AND o.account_id=t.account_id
     WHERE t.account_id=$1 AND t.product='bundle' AND o.product='bundle'
       AND o.provider='internal_trial' AND o.state='TRIAL' AND o.amount_minor=0
     LIMIT 1`,[accountId]);
  return rows.length===1?{wsLinks:makeWsProxyLinks(routes)}:null;
}


export type TrialProxyCountry='DE'|'FI';
export type TrialRegionalProxyLink=ProxyWsLink&{country:TrialProxyCountry};
/** Explicit owner-designated country routes. Never infer exit country from
 * the ingress hostname or from direct/ru. Keep paid routes unchanged. */
export function trialRegionalProxyLinks(env:NodeJS.ProcessEnv):TrialRegionalProxyLink[]{
  if(!wsProxyReleaseReady(env))return [];
  const result:TrialRegionalProxyLink[]=[];
  for(const country of ['DE','FI'] as const){
    if(env['WEB_TRIAL_WS_PROXY_'+country+'_VERIFIED']!=='yes')continue;
    const routes=parseWsProxyRoutes(env['WEB_TRIAL_WS_PROXY_'+country+'_ROUTES_JSON']);
    if(!routes)continue;
    for(const link of makeWsProxyLinks(routes))result.push({...link,country,
      label:(country==='DE'?'Германия':'Финляндия')+' · '+link.label});
  }
  // A single ingress path cannot be asserted to terminate in two countries.
  const duplicates=new Set(result.filter(a=>result.some(b=>a.country!==b.country&&a.server===b.server)).map(a=>a.server));
  return result.filter(a=>!duplicates.has(a.server));
}
export async function loadSharedTrialCountryProxy(
  db:Pick<Pool,'query'>,accountId:string,env:NodeJS.ProcessEnv,
):Promise<{wsLinks:ProxyWsLink[];regionalLinks:TrialRegionalProxyLink[]}|null>{
  if(!wsProxyReleaseReady(env))return null;
  const routes=parseWsProxyRoutes(env.WEB_TELEGRAM_WS_PROXY_ROUTES_JSON);
  if(!routes)return null;
  const shared=await loadSharedTrialWsProxy(db,accountId,routes);
  return shared?{...shared,regionalLinks:trialRegionalProxyLinks(env)}:null;
}
