import type {Pool} from 'pg';

// Internal adapter, NEVER an HTTP API. Every entitlementId must come from a
// separately VERIFIED ingress transport identity, never DNS query or source IP.
export interface TrustedEntitlement {
  entitlementId:string;
  revision:string;
}
export interface ChunkPermit {
  reservedBytes:number;
  allowedUntil:Date;
  revision:string;
}
export interface ChunkQuota {
  active(identity:TrustedEntitlement):Promise<boolean>;
  reserve(identity:TrustedEntitlement,eventId:string,bytes:number):Promise<ChunkPermit|null>;
  settle(identity:TrustedEntitlement,eventId:string,upload:number,download:number):Promise<boolean>;
}

export class PostgresChunkQuota implements ChunkQuota {
  private readonly db:Pick<Pool,'query'>;
  constructor(db:Pick<Pool,'query'>){this.db=db;}

  async active(i:TrustedEntitlement):Promise<boolean>{
    const q=await this.db.query('SELECT dns_ingress_active($1::uuid,$2::bigint) AS ok',
      [i.entitlementId,i.revision]);
    return q.rows[0]?.ok===true;
  }

  async reserve(i:TrustedEntitlement,eventId:string,bytes:number):Promise<ChunkPermit|null>{
    if(!Number.isSafeInteger(bytes)||bytes<=0)return null;
    // One atomic SQL call checks exact revision, allocates quota, returns the
    // trusted deadline. Never trust a separate SELECT after the reservation.
    const q=await this.db.query(
      'SELECT * FROM dns_ingress_reserve($1::uuid,$2::bigint,$3::text,$4::bigint)',
      [i.entitlementId,i.revision,eventId,bytes]);
    const row=q.rows[0];
    if(!row||row.status!=='RESERVED'||String(row.reserved_bytes)!==String(bytes)
       ||String(row.entitlement_revision)!==i.revision)return null;
    const deadline=new Date(row.allowed_until as Date);
    if(!Number.isFinite(deadline.getTime()))return null;
    return {reservedBytes:bytes,allowedUntil:deadline,revision:i.revision};
  }

  async settle(i:TrustedEntitlement,eventId:string,upload:number,download:number):Promise<boolean>{
    if(!Number.isSafeInteger(upload)||!Number.isSafeInteger(download)||
      upload<0||download<0)return false;
    const q=await this.db.query(
      'SELECT dns_ingress_settle($1::uuid,$2::bigint,$3::text,$4::bigint,$5::bigint) AS state',
      [i.entitlementId,i.revision,eventId,upload,download]);
    return ['SETTLED','DUPLICATE','LATE_RECORDED'].includes(q.rows[0]?.state);
  }
}
