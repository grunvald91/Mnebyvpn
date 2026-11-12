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
export function makeBonusLinks(
  secret:string,tlsDomain:string,routes:ProxyBonusRoute[],
):ProxyBonusLink[]{
  if(!hexSecret.test(secret)||!validDomain(tlsDomain)||routes.length!==2)
    throw new Error('Invalid MTProxy profile');
  const checked=parseBonusRoutes(JSON.stringify(routes));
  if(!checked)throw new Error('Unverified MTProxy routes');
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
type BonusRow={
  entitlement_id:string;expires_at:Date;telemt_username:string;
  secret_box:string;tls_domain:string;
};
/** Authenticated account ID is resolved from the server-side session.
 * Paid DNS, not a trial or refunded order, owns the credential.
 * This never creates or enables users in Telemt. */
export async function loadCustomerProxyBonus(
  db:Pick<Pool,'query'>,accountId:string,entitlementId:string,
  keyHex:string,routes:ProxyBonusRoute[],
):Promise<{expiresAt:string;links:ProxyBonusLink[]}|null>{
  if(!uuid.test(accountId)||!uuid.test(entitlementId))return null;
  const sql='SELECT e.id AS entitlement_id,e.expires_at,b.telemt_username,'+
    'b.secret_box,b.tls_domain FROM entitlements e '+
    'JOIN orders o ON o.id=e.source_order_id AND o.account_id=e.account_id '+
    'JOIN dns_mtproxy_bonus_credentials b ON b.entitlement_id=e.id '+
    'WHERE e.account_id=$1 AND e.id=$2 AND e.product=$3 '+
    'AND e.state=$4 AND e.starts_at<=clock_timestamp() '+
    'AND e.expires_at>clock_timestamp() AND o.state=$5 '+
    'AND o.product IN ($3,$6) AND b.state=$4 '+
    'AND b.disabled_at IS NULL AND '+
    "b.verified_at>clock_timestamp()-interval '7 days' LIMIT 1";
  const {rows}=await db.query(sql,[accountId,entitlementId,'smart_dns','ACTIVE','PAID','bundle']);
  const row=(rows as BonusRow[])[0];
  if(!row)return null;
  const secret=openProxySecret(row.secret_box,keyHex,row.entitlement_id,row.telemt_username);
  return {expiresAt:row.expires_at.toISOString(),
    links:makeBonusLinks(secret,row.tls_domain,routes)};
}
export function bonusReleaseReady(env:NodeJS.ProcessEnv):boolean{
  return env.WEB_DNS_MT_PROXY_BONUS_ENABLED==='yes' &&
    env.WEB_DNS_MT_PROXY_BONUS_E2E_VERIFIED==='yes' &&
    env.WEB_DNS_MT_PROXY_BONUS_REVOKER_VERIFIED==='yes' &&
    hexKey.test(env.WEB_DNS_MT_PROXY_BONUS_KEY??'') &&
    parseBonusRoutes(env.WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON)!==null;
}
