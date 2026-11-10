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
  constructor(private readonly db:Pick<Pool,'query'>){}

  async active(i:TrustedEntitlement):Promise<boolean>{
    const q=await this.db.query(`
      SELECT EXISTS(
        SELECT 1 FROM entitlements e
        JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='smart_dns'
        WHERE e.id=$1::uuid AND e.revision=$2::bigint
          AND e.product='smart_dns' AND e.state='ACTIVE'
          AND e.starts_at IS NOT NULL AND e.starts_at<=clock_timestamp()
          AND e.expires_at IS NOT NULL AND e.expires_at>clock_timestamp()
          AND e.quota_state='AVAILABLE'
          AND e.quota_limit_bytes IS NOT NULL
          AND e.quota_used_bytes<e.quota_limit_bytes
          AND p.applied_revision=e.revision
          AND p.last_observed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM entitlement_credits c
            JOIN orders o ON o.id=c.order_id
            WHERE c.entitlement_id=e.id AND c.refunded_at IS NULL
              AND c.quota_bytes IS NOT NULL
              AND c.consumed_bytes<c.quota_bytes AND o.state='PAID'
          )
      ) AS ok`,[i.entitlementId,i.revision]);
    return q.rows[0]?.ok===true;
  }

  async reserve(i:TrustedEntitlement,eventId:string,bytes:number):Promise<ChunkPermit|null>{
    if(!Number.isSafeInteger(bytes)||bytes<=0)return null;
    // This function serializes by entitlement row, including other ingress
    // workers. If DB fails the caller MUST stop the flow; never assume allow.
    const granted=await this.db.query(
      'SELECT reserve_smart_dns_chunk($1::uuid,$2::text,$3::bigint) AS state',
      [i.entitlementId,eventId,bytes]);
    if(granted.rows[0]?.state!=='RESERVED')return null;
    const permit=await this.db.query(`
      SELECT r.reserved_bytes, r.allowed_until, e.revision
      FROM smart_dns_quota_reservations r
      JOIN entitlements e ON e.id=r.entitlement_id
      WHERE r.entitlement_id=$1::uuid AND r.reservation_id=$2::text
        AND r.state='HELD'
        AND e.revision=$3::bigint`,
      [i.entitlementId,eventId,i.revision]);
    const row=permit.rows[0];
    if(!row || row.reserved_bytes!==String(bytes))return null;
    return {
      reservedBytes:bytes,
      allowedUntil:new Date(row.allowed_until as Date),
      revision:String(row.revision),
    };
  }

  async settle(i:TrustedEntitlement,eventId:string,upload:number,download:number):Promise<boolean>{
    if(!Number.isSafeInteger(upload)||!Number.isSafeInteger(download)||
      upload<0||download<0)return false;
    const q=await this.db.query(`
      SELECT settle_smart_dns_chunk($1::uuid,$2::text,$3::bigint,$4::bigint) AS state`,
      [i.entitlementId,eventId,upload,download]);
    return q.rows[0]?.state==='SETTLED'||q.rows[0]?.state==='DUPLICATE';
  }
}
