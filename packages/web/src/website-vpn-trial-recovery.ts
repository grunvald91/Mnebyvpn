import type {Pool} from 'pg';
import type {PgBillingStore} from '../../billing/src/store.ts';
import {deliverVpnTrialReadyEmail,normalizeLoginEmail} from './email-otp.ts';

/** Only call for an explicitly requesting, successfully authenticated email account. */
export async function rememberWebsiteVpnTrial(pool:Pool,accountId:string,deviceHash:string,inviteToken?:string):Promise<boolean>{
  await pool.query(`INSERT INTO website_vpn_trial_requests(account_id,device_hash,invite_token)
    VALUES($1,$2,$3) ON CONFLICT(account_id) DO NOTHING`,[accountId,deviceHash,inviteToken??null]);
  const status=await pool.query('SELECT status FROM website_vpn_trial_requests WHERE account_id=$1',[accountId]);
  return ['PENDING','WAITING'].includes(status.rows[0]?.status);
}
type Job={account_id:string;device_hash:string;invite_token:string|null;order_id:string|null;status:'PENDING'|'WAITING';attempts:number};

/** Durable bounded leases survive restart; trial uniqueness serializes grants. */
export async function recoverWebsiteVpnTrials(pool:Pool,store:Pick<PgBillingStore,'grantTrial'>,secret:string,
 send:typeof deliverVpnTrialReadyEmail=deliverVpnTrialReadyEmail):Promise<void>{
  for(let i=0;i<5;i++){
    const claimed=await pool.query(`WITH pick AS (
        SELECT account_id FROM website_vpn_trial_requests
        WHERE status IN ('PENDING','WAITING') AND next_attempt_at<=clock_timestamp()
          AND (locked_until IS NULL OR locked_until<=clock_timestamp())
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE website_vpn_trial_requests r SET attempts=r.attempts+1,
        locked_until=clock_timestamp()+interval '120 seconds'
      FROM pick WHERE r.account_id=pick.account_id RETURNING r.*`);
    const job=claimed.rows[0] as Job|undefined;
    if(!job)return;
    const finish=async(status:'PENDING'|'WAITING'|'SENT'|'REJECTED',orderId:string|null,delay:number,reason:string|null)=>{
      await pool.query(`UPDATE website_vpn_trial_requests SET status=$3,order_id=$4,
          next_attempt_at=clock_timestamp()+($5::int*interval '1 second'),
          last_error_code=$6,locked_until=NULL,
          sent_at=CASE WHEN $3='SENT' THEN clock_timestamp() ELSE NULL END
         WHERE account_id=$1 AND attempts=$2`,[job.account_id,job.attempts,status,orderId,delay,reason]);
    };
    const retry=Math.min(300,10*2**Math.min(5,job.attempts-1));
    try{
      if(job.status==='PENDING'){
        const grant=await store.grantTrial(job.account_id,'vpn',job.invite_token??undefined,job.device_hash);
        if(grant.status==='DEVICE_ALREADY_USED'){
          await finish('REJECTED',null,0,'DEVICE_ALREADY_USED');continue;
        }
        if(grant.status==='UNAVAILABLE'||!grant.orderId){
          await finish('PENDING',null,300,'TRIAL_UNAVAILABLE');continue;
        }
        await finish('WAITING',grant.orderId,0,null);continue;
      }
      // Resolve recipient from canonical verified account; require final node ACK.
      const observed=await pool.query(`SELECT a.email_address,t.product,t.access_expires_at,o.state,
          (t.activated_at IS NOT NULL AND t.access_expires_at>clock_timestamp()
           AND EXISTS (SELECT 1 FROM entitlements e JOIN provisioning_state p
             ON p.entitlement_id=e.id AND p.adapter='vpn'
             WHERE e.source_order_id=t.order_id AND e.account_id=t.account_id
               AND e.product='vpn' AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
               AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL)) AS ready
         FROM trial_grants t JOIN accounts a ON a.id=t.account_id
         JOIN orders o ON o.id=t.order_id AND o.provider='internal_trial'
         WHERE t.account_id=$1 AND t.order_id=$2`,[job.account_id,job.order_id]);
      const trial=observed.rows[0];
      if(!trial||trial.product!=='vpn'||trial.state!=='TRIAL'||
         !normalizeLoginEmail(trial.email_address)||
         (trial.access_expires_at&&new Date(trial.access_expires_at).getTime()<=Date.now())){
        await finish('REJECTED',job.order_id,0,'TRIAL_NO_LONGER_ELIGIBLE');continue;
      }
      if(!trial.ready){
        await finish('WAITING',job.order_id,15,'WAITING_FOR_NODE');continue;
      }
      const delivered=await send(trial.email_address,new Date(trial.access_expires_at),secret);
      await finish(delivered?'SENT':'WAITING',job.order_id,delivered?0:retry,delivered?null:'MAIL_RETRY');
    }catch(error){
      const code=(error as {code?:unknown})?.code;
      const reason=typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?'SQLSTATE_'+code:'TRIAL_RECOVERY_ERROR';
      if(error instanceof Error&&error.message==='Invalid or self-owned trial referral'){
        await finish('REJECTED',job.order_id,0,'INVALID_REFERRAL');continue;
      }
      console.error('MNEBYVPN_WEB_TRIAL_'+reason);
      await finish(job.status,job.order_id,retry,reason);
    }
  }
}
