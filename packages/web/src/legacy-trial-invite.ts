import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
import {normalizeLoginEmail,deliverVpnTrialRecoveryInvite} from './email-otp.ts';
export function trialInviteSignature(secret:string,stamp:string,operator:number,email:string):string{
 return createHmac('sha256',secret).update('MNEBYVPN-trial-invite-v1\n'+stamp+'\n'+operator+'\n'+email).digest('hex');
}
export function validTrialInviteSignature(secret:string,stamp:unknown,signature:unknown,operator:number,email:string,now=Date.now()):boolean{
 return secret.length>=32&&typeof stamp==='string'&&/^[0-9]{9,12}$/.test(stamp)&&
 Math.abs(now/1000-Number(stamp))<=60&&typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature)&&
 timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(trialInviteSignature(secret,stamp,operator,email),'hex'));
}
type Result='SENT'|'ALREADY_SENT'|'IN_PROGRESS'|'NOT_ELIGIBLE'|'FAILED';
/** Operator attests an actual failed request. Never auto-select ordinary sign-ins,
 * never create an entitlement or invent a browser device claim. */
export async function sendLegacyTrialInvite(pool:Pool,email:string,secret:string,
 send:typeof deliverVpnTrialRecoveryInvite=deliverVpnTrialRecoveryInvite):Promise<Result>{
 if(normalizeLoginEmail(email)!==email||secret.length<32)return 'FAILED';
 const client=await pool.connect();
 let account:string|undefined;
 const attempt=randomUUID();
 try{
  await client.query('BEGIN');
  const r=await client.query(`SELECT a.id FROM accounts a WHERE a.email_address=$1
    AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.account_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM trial_grants t WHERE t.account_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM website_vpn_trial_requests t WHERE t.account_id=a.id AND t.status IN ('PENDING','WAITING','SENT'))
    FOR UPDATE`,[email]);
  if(r.rowCount!==1){await client.query('COMMIT');return 'NOT_ELIGIBLE';}
  account=r.rows[0].id;
  const prev=await client.query('SELECT status FROM website_vpn_trial_recovery_invites WHERE account_id=$1',[account]);
  if(prev.rows[0]?.status==='SENT'){await client.query('COMMIT');return 'ALREADY_SENT';}
  // Ambiguous crash after SMTP acceptance is not automatically retried.
  if(prev.rows[0]?.status==='SENDING'){await client.query('COMMIT');return 'IN_PROGRESS';}
  await client.query(`INSERT INTO website_vpn_trial_recovery_invites(account_id,status,attempt_id)
    VALUES($1,'SENDING',$2) ON CONFLICT(account_id) DO UPDATE SET
    status='SENDING',attempt_id=EXCLUDED.attempt_id,attempted_at=clock_timestamp(),sent_at=NULL
    WHERE website_vpn_trial_recovery_invites.status='FAILED'`,[account,attempt]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 // A FALSE transport response may be ambiguous; don't automatically replay.
 const delivered=await send(email,secret);
 if(!delivered)return 'FAILED';
 await pool.query(`UPDATE website_vpn_trial_recovery_invites SET status='SENT',sent_at=clock_timestamp()
   WHERE account_id=$1 AND attempt_id=$2 AND status='SENDING'`,[account,attempt]);
 return 'SENT';
}
