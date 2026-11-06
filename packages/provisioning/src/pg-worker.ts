import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';
import {
  reconcileEntitlement, type DesiredAccess, type ProvisioningAdapter,
  type ReconcileResult, type ReconcileStore,
} from './reconciler.ts';

export type Product = 'vpn' | 'smart_dns';
export type AdapterMap = Partial<Record<Product, ProvisioningAdapter>>;
export interface OutboxSignal { id: string; entitlementId: string; revision: number; product: Product }

function asInt(value: unknown): number {
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Unsafe DB integer');
  return n;
}

/** Non-blocking per-entitlement lock, with all DB work running on the SAME
 * checked-out client while a remote operation is in progress. Prevents pool
 * starvation with max=2 and two concurrent reconciliations.
 */
export class ReconcileLockBusy extends Error {
  constructor(){super('RECONCILE_LOCK_BUSY');}
}
export class PgReconcileStore implements ReconcileStore {
  readonly pool: Pool;
  private readonly lockContext=new AsyncLocalStorage<PoolClient>();
  constructor(pool: Pool) { this.pool=pool; }
  private query(sql:string,params:unknown[]=[]){
    return (this.lockContext.getStore()??this.pool).query(sql,params);
  }
  async withLock<T>(id:string,action:(fence:number)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    let locked=false, close=false;
    try {
      const tryLock=await client.query(
        "SELECT pg_try_advisory_lock(hashtext('mnebyvpn:provision'),hashtext($1)) AS ok",[id]);
      if(tryLock.rows[0]?.ok!==true)throw new ReconcileLockBusy();
      locked=true;
      const type=await client.query('SELECT product FROM entitlements WHERE id=$1',[id]);
      if (!type.rowCount) throw new Error('Unknown entitlement');
      const {rows}=await client.query('SELECT claim_provisioning_fence($1,$2) AS fence',
        [id,type.rows[0].product]);
      return await this.lockContext.run(client,()=>action(asInt(rows[0].fence)));
    } finally {
      if (locked) {
        try {
          const unlock=await client.query(
            "SELECT pg_advisory_unlock(hashtext('mnebyvpn:provision'),hashtext($1)) AS ok",[id]);
          if (unlock.rows[0].ok !== true) close=true;
        } catch { close=true; }
      }
      client.release(close);
      if(close)throw new Error('Advisory lock connection lost');
    }
  }
  async readDesired(id:string):Promise<DesiredAccess> {
    const {rows}=await this.query(
      `SELECT e.id,e.revision,e.state,e.expires_at,e.starts_at,
          e.quota_limit_bytes,e.quota_used_bytes,e.quota_state,
          t.order_id AS trial_order_id,t.activated_at
         FROM entitlements e
         LEFT JOIN trial_grants t ON t.order_id=e.source_order_id
        WHERE e.id=$1`,[id]);
    if (!rows.length) throw new Error('Unknown entitlement');
    const r=rows[0];
    const quotaOK=r.quota_state==='AVAILABLE' &&
      (r.quota_limit_bytes===null ||
        BigInt(r.quota_used_bytes)<BigInt(r.quota_limit_bytes));
    const pendingTrial=Boolean(r.trial_order_id) &&
      r.activated_at===null && r.starts_at===null && r.expires_at===null;
    // Provisional, hard-enforced 5-minute node expiry. NEVER return NULL to
    // a trial adapter as that would create permanent pre-activation access.
    const expiry=pendingTrial?new Date(Date.now()+5*60*1000):r.expires_at;
    return {entitlementId:r.id,revision:asInt(r.revision),
      enabled:quotaOK && ['ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED'].includes(r.state),
      expiresAt:expiry,trialPendingActivation:pendingTrial,isTrial:Boolean(r.trial_order_id)};
  }
  async acknowledge(id:string,revision:number,fence:number,observedEnabled:boolean):Promise<boolean> {
    const {rows}=await this.query(
      `SELECT acknowledge_provisioning($1,
        (SELECT product FROM entitlements WHERE id=$1),$2,$3,$4) AS ok`,
      [id,revision,fence,observedEnabled]);
    return rows[0]?.ok===true;
  }
  async requestReconcile(id:string,reason:string):Promise<void> {
    if(!/^[a-z_]{1,80}$/.test(reason)) throw new Error('Invalid reconcile reason');
    await this.query(
      `INSERT INTO reconcile_outbox(entitlement_id,desired_revision,next_attempt_at,last_error_code)
        SELECT id,revision,clock_timestamp(),$2 FROM entitlements WHERE id=$1
        ON CONFLICT(entitlement_id,desired_revision) DO UPDATE SET
          handled_at=NULL,next_attempt_at=clock_timestamp(),
          last_error_code=EXCLUDED.last_error_code`,[id,reason]);
  }
}

/** Does NOT start a daemon. Adapters have to be supplied explicitly.
 * Missing adapters leave the outbox queued, never falsely mark access ACTIVE. */
export class PgOutboxDispatcher {
  readonly store:PgReconcileStore;
  readonly adapters:AdapterMap;
  constructor(pool:Pool,adapters:AdapterMap={}) {
    this.store=new PgReconcileStore(pool); this.adapters=adapters;
  }
  async expireDue():Promise<number> {
    const {rows}=await this.store.pool.query('SELECT expire_due_entitlements() AS count');
    return asInt(rows[0].count);
  }
  async claim():Promise<OutboxSignal|null> {
    const {rows}=await this.store.pool.query(
      `WITH pick AS (
         SELECT id FROM reconcile_outbox
          WHERE handled_at IS NULL AND next_attempt_at<=clock_timestamp()
          ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
       ), reserved AS (
         UPDATE reconcile_outbox b SET attempts=attempts+1,
           next_attempt_at=clock_timestamp()+interval '60 seconds'
          WHERE b.id IN (SELECT id FROM pick)
          RETURNING b.id,b.entitlement_id,b.desired_revision
       )
       SELECT r.id,r.entitlement_id,r.desired_revision,e.product
         FROM reserved r JOIN entitlements e ON e.id=r.entitlement_id`);
    if(!rows.length)return null;
    const r=rows[0];
    return {id:String(r.id),entitlementId:r.entitlement_id,
      revision:asInt(r.desired_revision),product:r.product};
  }
  async processOnce():Promise<{status:'empty'|'synced'|'retry';reason?:string;signal?:OutboxSignal}> {
    const signal=await this.claim();
    if(!signal)return {status:'empty'};
    const adapter=this.adapters[signal.product];
    if(!adapter) {
      await this.retry(signal,'adapter_not_connected');
      return {status:'retry',reason:'adapter_not_connected',signal};
    }
    try {
      const result=await reconcileEntitlement(signal.entitlementId,this.store,adapter);
      if(result.status!=='synced') {
        await this.retry(signal,result.reason);
        return {status:'retry',reason:result.reason,signal};
      }
      const r=await this.store.pool.query(
        `UPDATE reconcile_outbox b
          SET handled_at=clock_timestamp(),last_error_code=NULL
          FROM entitlements e JOIN provisioning_state p
            ON p.entitlement_id=e.id AND p.adapter=e.product
          WHERE b.id=$1 AND b.entitlement_id=e.id
            AND p.applied_revision>=b.desired_revision`,
        [signal.id]);
      if(!r.rowCount) {
        await this.retry(signal,'revision_race');
        return {status:'retry',reason:'revision_race',signal};
      }
      return {status:'synced',signal};
    } catch {
      await this.retry(signal,'worker_exception');
      return {status:'retry',reason:'worker_exception',signal};
    }
  }
  async retry(signal:OutboxSignal,code:string):Promise<void> {
    await this.store.pool.query(
      `UPDATE reconcile_outbox
         SET next_attempt_at=clock_timestamp()+interval '60 seconds',
             last_error_code=$2
        WHERE id=$1 AND handled_at IS NULL`,[signal.id,code]);
  }
  async scheduleDriftScan(limit=100):Promise<number> {
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error('Invalid limit');
    const result=await this.store.pool.query(
      `INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
         SELECT e.id,e.revision FROM entitlements e
         LEFT JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter=e.product
         WHERE p.applied_revision IS DISTINCT FROM e.revision
            OR p.last_observed_at IS NULL
            OR p.last_observed_at<clock_timestamp()-interval '1 hour'
         ORDER BY e.id LIMIT $1
         ON CONFLICT(entitlement_id,desired_revision) DO UPDATE SET
           handled_at=NULL,next_attempt_at=clock_timestamp()`,[limit]);
    return result.rowCount??0;
  }
}
