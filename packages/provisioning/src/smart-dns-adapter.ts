/**
 * Smart DNS provisioning adapter for PostgreSQL-backed Personal DoT enforcement.
 * Access control and expiry are enforced live on every DNS query by
 * reserve_personal_dns_query / expire_due_entitlements against entitlements.
 */
import type {Pool} from 'pg';
import type {DesiredAccess,ObservedAccess,ProvisioningAdapter} from './reconciler.ts';

type EntitlementRow={
  product:string;
  state:string;
  revision:number|string;
  expires_at:Date|null;
};

export type SmartDnsHealthCheck=()=>Promise<boolean>;

export class SmartDnsProvisioningAdapter implements ProvisioningAdapter {
  /** Personal DoT gateway validates entitlements.state + expires_at live. */
  readonly enforcesHardExpiry=true as const;
  private readonly db:Pick<Pool,'query'>;
  private readonly healthCheck?:SmartDnsHealthCheck;
  private readonly applied=new Map<string,{revision:number;enabled:boolean;provisionalUntil:Date|null}>();

  constructor(db:Pick<Pool,'query'>,healthCheck?:SmartDnsHealthCheck){
    this.db=db;
    this.healthCheck=healthCheck;
  }

  async inspect(entitlementId:string):Promise<ObservedAccess>{
    const {rows}=await this.db.query(
      `SELECT product,state,revision,expires_at
         FROM entitlements WHERE id=$1 AND product='smart_dns' LIMIT 1`,
      [entitlementId]);
    const row=(rows as EntitlementRow[])[0];
    if(!row)return {revision:0,enabled:false,absent:true};
    const revision=Number(row.revision);
    const record=this.applied.get(entitlementId);
    const sameRevision=record?.revision===revision;
    // Unstarted trials have no DB expiry until the first provisioning ACK.
    // This is a bounded readiness observation, not a credential grant: the
    // gateway still denies all premium requests until the DB is ACTIVE.
    const pending=['PAID_PENDING_PROVISIONING','PROVISIONING_FAILED'].includes(row.state);
    const observedExpiry=row.expires_at??(pending&&sameRevision&&record.enabled?record.provisionalUntil:null);
    const notExpired=observedExpiry!==null&&observedExpiry.getTime()>Date.now();
    const activeInDb=row.state==='ACTIVE'&&row.expires_at!==null&&notExpired;
    const confirmedThisCycle=record?.revision===revision&&record.enabled;
    return {
      revision,
      enabled:(activeInDb||confirmedThisCycle)&&
        (row.state==='ACTIVE'||['PAID_PENDING_PROVISIONING','PROVISIONING_FAILED'].includes(row.state))&&
        notExpired&&(!sameRevision||record.enabled!==false),
      expiresAt:observedExpiry,
    };
  }

  async apply(desired:DesiredAccess,operationId:string):Promise<'applied'|'unknown'>{
    const expected=[desired.entitlementId,desired.revision,desired.enabled?'enable':'disable'].join(':');
    if(operationId!==expected)return 'unknown';
    const provisional=desired.trialPendingActivation===true||desired.provisionalActivation===true;
    if(desired.enabled&&provisional&&(!this.healthCheck||!desired.expiresAt||
       desired.expiresAt.getTime()<=Date.now()||desired.expiresAt.getTime()>Date.now()+5*60*1000))return 'unknown';
    if(desired.enabled&&this.healthCheck){
      const ok=await this.healthCheck().catch(()=>false);
      if(!ok)return 'unknown';
    }
    this.applied.set(desired.entitlementId,{revision:desired.revision,enabled:desired.enabled,
      provisionalUntil:desired.enabled&&provisional?desired.expiresAt:null});
    return 'applied';
  }
}

export function httpSmartDnsHealthCheck(url:string,fetcher:typeof fetch=fetch):SmartDnsHealthCheck{
  const parsed=new URL(url);
  if(parsed.protocol!=='http:'||!['127.0.0.1','::1'].includes(parsed.hostname))
    throw Error('Personal DoT health endpoint must be loopback HTTP');
  return async()=>{
    const res=await fetcher(parsed.toString(),{method:'GET',redirect:'error',signal:AbortSignal.timeout(3000)});
    return res.ok;
  };
}
