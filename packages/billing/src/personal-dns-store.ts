/**
 * Owner-scoped stable personal DNS links.
 * A control-plane store, NOT a deployed DNS resolver or TLS proxy.
 * Generated token URLs are bearer credentials. Never log them.
 */
import type {Pool} from 'pg';
import {personalDnsLinks,queryQuotaView,type PersonalDnsLinks}
  from '../../dns-policy/src/personal-dns-links.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PersonalDnsOwnerView {
  link:PersonalDnsLinks;
  quota:ReturnType<typeof queryQuotaView>;
}

export function personalDnsSigningKey(
  env:Readonly<Record<string,string|undefined>>=process.env,
):Uint8Array|null{
  const raw=env.MNEBYDNS_PERSONAL_DNS_LINK_KEY_HEX;
  if(!raw||!/^[0-9a-f]{64}$/i.test(raw))return null;
  return Buffer.from(raw,'hex');
}

export class PgPersonalDnsLinks {
  private readonly pool:Pool;
  private readonly signingKey:Uint8Array;
  constructor(pool:Pool,signingKey:Uint8Array){
    if(!(signingKey instanceof Uint8Array)||signingKey.length<32)
      throw new Error('Missing DNS link signing key');
    this.pool=pool;
    this.signingKey=Uint8Array.from(signingKey);
  }
  async issueForAccount(accountId:string,entitlementId:string):Promise<PersonalDnsOwnerView>{
    if(!UUID.test(accountId)||!UUID.test(entitlementId))
      throw new Error('Invalid DNS account or package');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query<{
        id:string;state:string;product:string;expires_at:Date;
      }>('SELECT id,product,state,expires_at FROM entitlements '+
        'WHERE id=$1 AND account_id=$2 FOR UPDATE',[entitlementId,accountId]);
      const e=rows[0];
      if(!e||e.product!=='smart_dns'||e.state!=='ACTIVE'||
         !e.expires_at||e.expires_at.getTime()<=Date.now())
        throw new Error('DNS_ENTITLEMENT_NOT_ACTIVE');

      const {rows:tokens}=await client.query<{credential_revision:number}>(
        'SELECT credential_revision FROM personal_dns_links WHERE entitlement_id=$1',
        [entitlementId]);
      const revision=tokens[0]?.credential_revision??1;
      const link=personalDnsLinks(entitlementId,revision,this.signingKey);
      const issued=await client.query<{outcome:string}>(
        'SELECT issue_personal_dns_link($1,$2,$3) AS outcome',
        [entitlementId,link.tokenDigest,revision]);
      if(!['ISSUED','ALREADY_ISSUED'].includes(issued.rows[0]?.outcome))
        throw new Error('DNS_LINK_NOT_AVAILABLE');

      const balance=await client.query<{
        used_queries:string;paid_query_limit:string;
        remaining_queries:string;subscription_expires_at:Date;
      }>('SELECT * FROM personal_dns_query_balance($1)',[entitlementId]);
      const current=balance.rows[0];
      if(!current)throw new Error('DNS_BALANCE_NOT_AVAILABLE');
      const view=queryQuotaView(
        Number(current.used_queries),Number(current.paid_query_limit),
        current.subscription_expires_at,
      );
      await client.query('COMMIT');
      return {link,quota:view};
    }catch(error){
      await client.query('ROLLBACK');
      throw error;
    }finally{
      client.release();
    }
  }
}
