/** Per-purchase MNEBYDNS resolver credentials; never HTTPS-proxy byte identity.
 * One token (192 bits entropy) binds one paid smart_dns entitlement.
 * Only its SHA-256 is persisted; the hostname is displayed ONCE.
 */
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

const TOKEN=/^u[a-f0-9]{48}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DNS_DOT_SUFFIX='dns.mnebyvpn.site';
const digest=(raw:string)=>createHash('sha256').update(raw,'utf8').digest('hex');

export function dnsTokenFromSni(sni:string):string|null{
  // DNS labels are case-insensitive. Reject suffix confusion or nested labels.
  if(typeof sni!=='string'||sni.length>253)return null;
  const value=sni.toLowerCase();
  const suffix='.'+DNS_DOT_SUFFIX;
  if(!value.endsWith(suffix))return null;
  const token=value.slice(0,-suffix.length);
  return TOKEN.test(token)?token:null;
}

export function dnsHostname(token:string):string{
  if(!TOKEN.test(token))throw Error('Invalid personal DNS token');
  return token+'.'+DNS_DOT_SUFFIX;
}

/** Apple encrypted-DNS profile: manual user installation, unsigned.
 * The required public CA / wildcard TLS certificate is NOT supplied here.
 */
export function dnsAppleProfile(token:string):string{
  const hostname=dnsHostname(token);
  const uuid=randomUUID().toUpperCase(),inner=randomUUID().toUpperCase();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>PayloadContent</key><array><dict>',
    '<key>DNSSettings</key><dict>',
    '<key>DNSProtocol</key><string>TLS</string>',
    '<key>ServerName</key><string>'+hostname+'</string>',
    '</dict>',
    '<key>PayloadDisplayName</key><string>MNEBYDNS Private DNS</string>',
    '<key>PayloadIdentifier</key><string>site.mnebyvpn.dns.settings.'+inner+'</string>',
    '<key>PayloadType</key><string>com.apple.dnsSettings.managed</string>',
    '<key>PayloadUUID</key><string>'+inner+'</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '</dict></array>',
    '<key>PayloadDescription</key><string>Encrypted DNS subscription. Not a VPN.</string>',
    '<key>PayloadDisplayName</key><string>MNEBYDNS</string>',
    '<key>PayloadIdentifier</key><string>site.mnebyvpn.dns.profile.'+uuid+'</string>',
    '<key>PayloadOrganization</key><string>MNEBYDNS</string>',
    '<key>PayloadRemovalDisallowed</key><false/>',
    '<key>PayloadType</key><string>Configuration</string>',
    '<key>PayloadUUID</key><string>'+uuid+'</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '</dict></plist>',
    '',
  ].join('\n');
}

export interface DnsAccessLink {
  status:'ISSUED'|'ROTATED';
  hostname:string;
  appleProfileXml:string;
}
export async function issuePersonalDnsAccess(
  db:Pick<Pool,'query'>,
  accountId:string,entitlementId:string,rotate=false,
):Promise<DnsAccessLink|null|'ALREADY_ISSUED'>{
  if(!UUID.test(accountId)||!UUID.test(entitlementId)||typeof rotate!=='boolean')
    return null;
  const token='u'+randomBytes(24).toString('hex');
  const {rows}=await db.query(
    'SELECT dns_issue_link_for_account($1::uuid,$2::uuid,$3::text,$4::boolean) AS status',
    [accountId,entitlementId,digest(token),rotate]);
  const status=String(rows[0]?.status??'');
  if(status==='ALREADY_ISSUED')return status;
  if(status!=='ISSUED'&&status!=='ROTATED')return null;
  return {
    status,hostname:dnsHostname(token),appleProfileXml:dnsAppleProfile(token),
  };
}

export async function revokePersonalDnsAccess(
  db:Pick<Pool,'query'>,accountId:string,entitlementId:string,
):Promise<'REVOKED'|'ALREADY_REVOKED'|null>{
  if(!UUID.test(accountId)||!UUID.test(entitlementId))return null;
  const {rows}=await db.query(
    'SELECT dns_revoke_link_for_account($1::uuid,$2::uuid) AS status',
    [accountId,entitlementId]);
  const state=rows[0]?.status;
  return state==='REVOKED'||state==='ALREADY_REVOKED'?state:null;
}

export interface DnsAccessStatus {
  entitlementId:string;
  status:string;
  expiresAt:string|null;
  issuedAt:string|null;
  authorizedQueries:string;
  lastQueryAt:string|null;
}
/** Response contains NO credential material; never leak the raw hostname. */
export async function personalDnsAccessStatuses(
  db:Pick<Pool,'query'>,accountId:string,
):Promise<DnsAccessStatus[]>{
  if(!UUID.test(accountId))return [];
  const {rows}=await db.query(
    'SELECT * FROM dns_links_for_account($1::uuid)',[accountId]);
  return rows.map((r:{entitlement_id:string;access_state:string;
    expires_at:Date|null;link_issued_at:Date|null;
    authorized_queries:string;last_query_at:Date|null})=>({
    entitlementId:String(r.entitlement_id),
    status:String(r.access_state),
    expiresAt:r.expires_at?.toISOString()??null,
    issuedAt:r.link_issued_at?.toISOString()??null,
    authorizedQueries:String(r.authorized_queries),
    lastQueryAt:r.last_query_at?.toISOString()??null,
  }));
}

/** Call only from a TLS-authenticated DoT or validated DoH resolver.
 * Never treat DNS authorization as authorization for arbitrary TCP/HTTPS
 * connections towards the SNI passthrough proxy.
 */
export async function authorizePersonalDnsQuery(
  db:Pick<Pool,'query'>,token:string,timeoutMs=1500,
):Promise<boolean>{
  if(!TOKEN.test(token)||!Number.isSafeInteger(timeoutMs)||
     timeoutMs<50||timeoutMs>5000)return false;
  let watchdog:NodeJS.Timeout|undefined;
  try{
    const result=await Promise.race([
      db.query(
        'SELECT dns_authorize_and_count_query($1::text) AS status',[digest(token)]),
      new Promise<never>((_,reject)=>{
        watchdog=setTimeout(()=>reject(Error('DNS authorization timeout')),timeoutMs);
      }),
    ]);
    return result.rows[0]?.status==='AUTHORIZED';
  }catch{return false;}
  finally{if(watchdog)clearTimeout(watchdog);}
}
