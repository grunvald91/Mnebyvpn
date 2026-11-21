/** Provision exactly one Telemt user per paid Smart DNS entitlement.
 * This is a separate private worker, never an unauthenticated website endpoint.
 * Failure does not issue a working customer link or claim server verification.
 */
import {createHash,randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import {openProxySecret,sealProxySecret} from './telegram-proxy-bonus.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern=/^[a-f0-9]{64}$/i;
const hexSecret=/^[a-f0-9]{32}$/i;
const dnsName=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
export type TelemtUser={
  username:string;enabled:boolean;in_runtime:boolean;expiration_rfc3339?:string|null;
};
export interface TelemtAdministrator{
  get(username:string):Promise<TelemtUser|null>;
  ensure(username:string,secret:string,expiresAt:Date,forceSecret:boolean):Promise<boolean>;
  disable(username:string):Promise<boolean>;
}

type Candidate={id:string;state:string;starts_at:Date|null;expires_at:Date|null;
  order_state:string;bonus_state:string|null;verified_at:Date|null};
type ExistingBonus={entitlement_id:string;telemt_username:string;secret_box:string;
  tls_domain:string;state:string;verified_at:Date|null};
type SyncResult='activated'|'disabled'|'pending'|'skipped';
export type ProxyReconcileReport={activated:number;disabled:number;pending:number;skipped:number;failed:number};

function safeJson(text:string):Record<string,unknown>{
  if(text.length>65536)throw Error('Oversized Telemt response');
  const parsed:unknown=JSON.parse(text);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw Error('Invalid Telemt response');
  return parsed as Record<string,unknown>;
}

/** Local-only Telemt API. Never send customer keys to an arbitrary URL. */
export class TelemtAdminClient implements TelemtAdministrator{
  private readonly origin:string;
  private readonly authHeader:string;
  private readonly transport:typeof fetch;
  constructor(endpoint:string,authHeader:string,transport:typeof fetch=fetch){
    this.authHeader=authHeader;
    this.transport=transport;
    const url=new URL(endpoint);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||
       !url.port||url.pathname!=='/'||url.search||url.hash||
       url.username||url.password)
      throw Error('Telemt admin must be loopback-only');
    if(!authHeader||authHeader.length<16||authHeader.length>512)
      throw Error('Telemt admin auth not configured');
    this.origin=url.origin;
  }
  private async call(method:string,path:string,body?:Record<string,unknown>):
      Promise<{status:number;data:Record<string,unknown>|null}>{
    const response=await this.transport(this.origin+path,{
      method,headers:{Authorization:this.authHeader,
        ...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,
      signal:AbortSignal.timeout(8000),redirect:'error',cache:'no-store',
    });
    if(response.status===404)return {status:404,data:null};
    if(response.status===409)return {status:409,data:null};
    if(!response.ok)throw Error('Telemt request failed');
    const parsed=safeJson(await response.text());
    // Telemt API returns {ok:true,data:<UserInfo|CreateUserResponse>},
    // never a bare user. Reject gray/empty 200 and error envelopes.
    if(parsed.ok!==true||!parsed.data||typeof parsed.data!=='object'||
       Array.isArray(parsed.data))throw Error('Telemt success envelope missing');
    return {status:response.status,data:parsed.data as Record<string,unknown>};
  }
  async get(username:string):Promise<TelemtUser|null>{
    if(!/^dns_[0-9a-f]{24}$/.test(username))throw Error('Invalid Telemt username');
    const response=await this.call('GET','/v1/users/'+username);
    if(response.status===404)return null;
    const data=response.data;
    if(!data||data.username!==username||
       typeof data.enabled!=='boolean'||typeof data.in_runtime!=='boolean')
      throw Error('Telemt state unverified');
    return data as unknown as TelemtUser;
  }
  async ensure(username:string,secret:string,expiresAt:Date,forceSecret:boolean):Promise<boolean>{
    if(!hexSecret.test(secret)||!Number.isFinite(expiresAt.getTime())||
       expiresAt.getTime()<=Date.now())return false;
    const expiration_rfc3339=expiresAt.toISOString();
    const old=await this.get(username);
    if(!old){
      const created=await this.call('POST','/v1/users',{
        username,secret,enabled:true,expiration_rfc3339,
      });
      if(![201,202,409].includes(created.status))return false;
      if(created.status!==409){
        const createdUser=created.data?.user;
        if(created.data?.secret!==secret||!createdUser||
           typeof createdUser!=='object'||
           (createdUser as Record<string,unknown>).username!==username)
          throw Error('Telemt create response unverified');
      }
      // A racing existing username is updated only with our persisted secret.
      forceSecret=created.status===409;
    }else{
      const oldExpiry=old.expiration_rfc3339
        ?Date.parse(old.expiration_rfc3339):NaN;
      if(!forceSecret&&old.enabled&&old.in_runtime&&
         oldExpiry===expiresAt.getTime())return true;
      forceSecret=true;
    }
    if(forceSecret){
      const patched=await this.call('PATCH','/v1/users/'+username,{
        secret,enabled:true,expiration_rfc3339,
      });
      if(patched.status!==200&&patched.status!==202)return false;
    }
    const current=await this.get(username);
    return current?.enabled===true&&current.in_runtime===true&&
      current.expiration_rfc3339!==undefined&&
      Date.parse(String(current.expiration_rfc3339))===expiresAt.getTime();
  }
  async disable(username:string):Promise<boolean>{
    const before=await this.get(username);
    if(!before)return true;
    if(before.enabled){
      const changed=await this.call('POST','/v1/users/'+username+'/disable');
      if(changed.status!==200&&changed.status!==202)return false;
    }
    const after=await this.get(username);
    return after===null||after.enabled===false;
  }
}
function usernameOf(entitlementId:string):string{
  if(!uuid.test(entitlementId))throw Error('Invalid entitlement id');
  return 'dns_'+createHash('sha256')
    .update('mnebyvpn:mtproxy:entitlement:v1:'+entitlementId.toLowerCase()).digest('hex').slice(0,24);
}
export function validateProxyProvisionConfig(key:string,domain:string){
  if(!keyPattern.test(key)||!dnsName.test(domain)||!domain.includes('.')||
     domain.includes('..')||domain.length>253||domain.split('.').some(x=>x.length>63||x.startsWith('-')||x.endsWith('-')))
    throw Error('Invalid secret key or FakeTLS domain');
}

/** Recheck the authoritative current ledger while holding a per-entitlement
 * advisory lock on one DB connection. PENDING encrypted credentials survive
 * remote API failures and are safely retried with the exact same secret. */
export async function reconcileProxyEntitlement(
  db:Pool,admin:TelemtAdministrator,entitlementId:string,key:string,domain:string,
  ownerOnly=false,
):Promise<SyncResult>{
  if(!uuid.test(entitlementId))throw Error('Invalid entitlement');
  validateProxyProvisionConfig(key,domain);
  const client=await db.connect();
  let locked=false;
  try{
    const lock=await client.query(
      "SELECT pg_try_advisory_lock(hashtext('mnebyvpn-mtproxy-bonus'),hashtext($1)) AS acquired",
      [entitlementId]);
    if(lock.rows[0]?.acquired!==true)return 'skipped';
    locked=true;
    const {rows}=await client.query(
      `SELECT e.id::text,e.state,e.starts_at,e.expires_at,o.state AS order_state,
          b.state AS bonus_state,b.verified_at
         FROM entitlements e JOIN orders o ON o.id=e.source_order_id
         LEFT JOIN dns_mtproxy_bonus_credentials b ON b.entitlement_id=e.id
         WHERE e.id=$1 AND e.product='smart_dns' AND o.account_id=e.account_id
           ${ownerOnly?"AND EXISTS(SELECT 1 FROM manual_sales m WHERE m.order_id=o.id)":''}
           LIMIT 1`,
      [entitlementId]);
    const entry=rows[0] as Candidate|undefined;
    if(!entry)return 'skipped';
    const now=Date.now();
    const active=entry.state==='ACTIVE'&&entry.order_state==='PAID'&&
      entry.starts_at!==null&&entry.starts_at.getTime()<=now&&
      entry.expires_at!==null&&entry.expires_at.getTime()>now;
    let {rows:bonusRows}=await client.query(
      'SELECT * FROM dns_mtproxy_bonus_credentials WHERE entitlement_id=$1',
      [entitlementId]);
    let bonus=bonusRows[0] as ExistingBonus|undefined;
    if(!active){
      if(!bonus||bonus.state==='DISABLED')return 'skipped';
      if(!await admin.disable(bonus.telemt_username))return 'pending';
      await client.query(
        `UPDATE dns_mtproxy_bonus_credentials SET state='DISABLED',
          disabled_at=clock_timestamp(),updated_at=clock_timestamp(),
          verified_at=NULL WHERE entitlement_id=$1`,[entitlementId]);
      return 'disabled';
    }
    if(!bonus){
      const name=usernameOf(entitlementId);
      const secret=randomBytes(16).toString('hex');
      const box=sealProxySecret(secret,key,entitlementId,name);
      await client.query(
        `INSERT INTO dns_mtproxy_bonus_credentials(
           entitlement_id,telemt_username,secret_box,tls_domain,state)
           VALUES($1,$2,$3,$4,'PENDING') ON CONFLICT DO NOTHING`,
        [entitlementId,name,box,domain]);
      bonusRows=(await client.query(
        'SELECT * FROM dns_mtproxy_bonus_credentials WHERE entitlement_id=$1',
        [entitlementId])).rows;
      bonus=bonusRows[0] as ExistingBonus|undefined;
    }
    if(!bonus||bonus.tls_domain!==domain||bonus.telemt_username!==usernameOf(entitlementId))
      throw Error('Telemt stored identity mismatch');
    const secret=openProxySecret(bonus.secret_box,key,entitlementId,bonus.telemt_username);
    if(!entry.expires_at||!await admin.ensure(
      bonus.telemt_username,secret,entry.expires_at,bonus.state!=='ACTIVE'))
      return 'pending';
    // Payment can be refunded while Telemt was creating the user. Refuse to
    // publish a link if the entitlement is no longer paid and active.
    const activated=await client.query(
      `UPDATE dns_mtproxy_bonus_credentials b SET state='ACTIVE',
         verified_at=clock_timestamp(),disabled_at=NULL,updated_at=clock_timestamp()
         WHERE b.entitlement_id=$1 AND EXISTS(
           SELECT 1 FROM entitlements e JOIN orders o ON o.id=e.source_order_id
           WHERE e.id=b.entitlement_id AND e.product='smart_dns'
             AND e.state='ACTIVE' AND e.starts_at<=clock_timestamp()
             AND e.expires_at>clock_timestamp() AND o.state='PAID'
             AND o.account_id=e.account_id)`,[entitlementId]);
    if(activated.rowCount===1)return 'activated';
    if(await admin.disable(bonus.telemt_username)){
      await client.query(
        `UPDATE dns_mtproxy_bonus_credentials SET state='DISABLED',
          disabled_at=clock_timestamp(),verified_at=NULL,
          updated_at=clock_timestamp() WHERE entitlement_id=$1`,[entitlementId]);
    }
    return 'pending';
  }finally{
    if(locked){
      try{await client.query(
        "SELECT pg_advisory_unlock(hashtext('mnebyvpn-mtproxy-bonus'),hashtext($1))",
        [entitlementId]);}catch{/* connection release will drop lock */}
    }
    client.release();
  }
}

export async function reconcileDnsProxyBonuses(
  db:Pool,admin:TelemtAdministrator,key:string,domain:string,max=50,
  ownerOnly=false,
):Promise<ProxyReconcileReport>{
  validateProxyProvisionConfig(key,domain);
  if(!Number.isSafeInteger(max)||max<1||max>200)throw Error('Invalid batch size');
  const {rows}=await db.query(
    `SELECT e.id::text AS id FROM entitlements e
      JOIN orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
      LEFT JOIN dns_mtproxy_bonus_credentials b ON b.entitlement_id=e.id
      WHERE e.product='smart_dns'
        ${ownerOnly?"AND EXISTS(SELECT 1 FROM manual_sales m WHERE m.order_id=o.id)":''}
        AND (
        (e.state='ACTIVE' AND e.starts_at<=clock_timestamp()
          AND e.expires_at>clock_timestamp() AND o.state='PAID'
          AND (b.entitlement_id IS NULL OR b.state<>'ACTIVE' OR
            b.verified_at<clock_timestamp()-interval '5 minutes'))
        OR (b.state IN ('PENDING','ACTIVE') AND
          (e.state<>'ACTIVE' OR e.expires_at<=clock_timestamp()
           OR e.starts_at>clock_timestamp() OR o.state<>'PAID'))
      ) ORDER BY b.verified_at ASC NULLS FIRST,e.id LIMIT $1`,[max]);
  const totals:ProxyReconcileReport={activated:0,disabled:0,pending:0,skipped:0,failed:0};
  for(const row of rows as {id:string}[]){
    try{
      const outcome=await reconcileProxyEntitlement(db,admin,row.id,key,domain,ownerOnly);
      totals[outcome]++;
    }catch{totals.failed++;}
  }
  return totals;
}
