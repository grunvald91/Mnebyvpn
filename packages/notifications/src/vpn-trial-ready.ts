import type {Pool} from 'pg';
import type {DeliveryResult} from './vpn-expiry.ts';
import {deviceOptions} from '../../../apps/service/src/vpn-onboarding.ts';

/** Telegram trial notifications contain no subscription bearer URL or node secret. */
export interface VpnTrialReadyNotice {
  orderId:string;
  telegramUserId:string;
  expiresAt:Date;
  attempt:number;
}
export interface TrialReadySender {
  send(job:VpnTrialReadyNotice):Promise<DeliveryResult>;
}

/** A final, node-observed active entitlement is the ONLY delivery trigger. */
const eligible = `FROM trial_grants t
  JOIN accounts a ON a.id=t.account_id
  JOIN orders o ON o.id=t.order_id AND o.provider='internal_trial' AND o.state='TRIAL'
  JOIN entitlements e ON e.source_order_id=t.order_id AND e.product='vpn'
  JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
  WHERE t.product IN ('vpn','bundle')
    AND t.telegram_user_id IS NOT NULL AND t.telegram_user_id>0
    AND a.telegram_user_id=t.telegram_user_id
    AND t.activated_at IS NOT NULL AND t.access_expires_at>clock_timestamp()
    AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
    AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL`;

export class PgVpnTrialReadyQueue {
  private readonly pool:Pick<Pool,'query'>;
  constructor(pool:Pick<Pool,'query'>){this.pool=pool;}

  /** Runs continuously: backfills already-ready trials, exactly once per order. */
  async discover():Promise<number>{
    const found=await this.pool.query(
      `INSERT INTO vpn_trial_ready_notifications(order_id,telegram_user_id)
       SELECT t.order_id,t.telegram_user_id::text ${eligible}
       ON CONFLICT(order_id) DO NOTHING`);
    return found.rowCount??0;
  }
  async reserve():Promise<VpnTrialReadyNotice|null>{
    const result=await this.pool.query(
      `WITH pick AS (
        SELECT n.order_id FROM vpn_trial_ready_notifications n
        WHERE ((n.status='PENDING' AND n.next_attempt_at<=clock_timestamp())
           OR (n.status='SENDING' AND n.locked_until<=clock_timestamp()))
          AND EXISTS (SELECT 1 ${eligible}
            AND t.order_id=n.order_id
            AND t.telegram_user_id::text=n.telegram_user_id)
        ORDER BY n.next_attempt_at,n.order_id
        LIMIT 1 FOR UPDATE OF n SKIP LOCKED
      ), claimed AS (
        UPDATE vpn_trial_ready_notifications n
          SET status='SENDING',attempts=attempts+1,
              locked_until=clock_timestamp()+interval '120 seconds'
        FROM pick WHERE n.order_id=pick.order_id
        RETURNING n.order_id,n.telegram_user_id,n.attempts
      )
      SELECT c.*,t.access_expires_at FROM claimed c
        JOIN trial_grants t ON t.order_id=c.order_id`);
    if(result.rowCount!==1)return null;
    const row=result.rows[0];
    const expires=new Date(row.access_expires_at);
    const attempts=Number(row.attempts);
    if(!/^[1-9][0-9]{0,15}$/.test(String(row.telegram_user_id))||
       !Number.isFinite(expires.getTime())||
       !Number.isSafeInteger(attempts)||attempts<1)
      throw Error('Invalid trial notification');
    return {orderId:String(row.order_id),telegramUserId:String(row.telegram_user_id),
      expiresAt:expires,attempt:attempts};
  }
  /** Recheck between claim and Telegram network I/O. */
  async stillEligible(job:VpnTrialReadyNotice):Promise<boolean>{
    const res=await this.pool.query(
      `SELECT 1 FROM vpn_trial_ready_notifications n
       WHERE n.order_id=$1 AND n.telegram_user_id=$2
         AND n.attempts=$3 AND n.status='SENDING'
         AND EXISTS (SELECT 1 ${eligible}
           AND t.order_id=n.order_id AND t.telegram_user_id::text=n.telegram_user_id)
       LIMIT 1`,[job.orderId,job.telegramUserId,job.attempt]);
    return res.rowCount===1;
  }
  async finalize(job:VpnTrialReadyNotice,status:'SENT'|'PENDING'|'FAILED'|'SKIPPED',
    retryAfterSeconds=0,reason:string|null=null):Promise<void>{
    const delay=Math.max(0,Math.min(3600,Math.ceil(retryAfterSeconds)));
    await this.pool.query(
      `UPDATE vpn_trial_ready_notifications SET status=$4,locked_until=NULL,
         next_attempt_at=clock_timestamp()+($5::int*interval '1 second'),
         sent_at=CASE WHEN $4='SENT' THEN clock_timestamp() ELSE NULL END,
         last_error_code=$6
       WHERE order_id=$1 AND telegram_user_id=$2 AND attempts=$3 AND status='SENDING'`,
      [job.orderId,job.telegramUserId,job.attempt,status,delay,reason]);
  }
  async discardStale():Promise<number>{
    const r=await this.pool.query(
      `UPDATE vpn_trial_ready_notifications n
       SET status='SKIPPED',locked_until=NULL
       WHERE n.status IN ('PENDING','SENDING') AND NOT EXISTS (
         SELECT 1 ${eligible}
         AND t.order_id=n.order_id AND t.telegram_user_id::text=n.telegram_user_id)`);
    return r.rowCount??0;
  }
}

/** Same device choices as the bot's ordinary VPN onboarding. */
export function trialReadyMessage(job:VpnTrialReadyNotice){
  const deadline=job.expiresAt.toLocaleString('ru-RU',{
    timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',
  });
  return {
    text:'🎉 MNEBYVPN — бесплатный VPN готов!\n\n'+
      '✅ Пробный доступ активирован VPN-сервером.\n'+
      '⏰ Действует до '+deadline+' (МСК).\n\n'+
      'Выберите своё устройство — пришлём приложение и кнопки подключения. '+
      'Дополнительно проверять статус не нужно.',
    reply_markup:{inline_keyboard:deviceOptions()},
  };
}
export class TelegramTrialReadySender implements TrialReadySender {
  private readonly token:string;
  private readonly fetcher:typeof fetch;
  constructor(token:string,fetcher:typeof fetch=fetch){
    if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/.test(token))
      throw Error('Invalid Telegram bot token');
    this.token=token;this.fetcher=fetcher;
  }
  async send(job:VpnTrialReadyNotice):Promise<DeliveryResult>{
    try{
      const response=await this.fetcher('https://api.telegram.org/bot'+this.token+'/sendMessage',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:job.telegramUserId,...trialReadyMessage(job),
          link_preview_options:{is_disabled:true}}),
      });
      if(response.ok){
        const result=await response.json() as {ok?:unknown};
        return result.ok===true?{status:'sent'}:{status:'retry'};
      }
      if(response.status===403||response.status===400)return {status:'blocked'};
      if(response.status===429){
        const body=await response.json() as {parameters?:{retry_after?:number}};
        const seconds=Number(body.parameters?.retry_after);
        return {status:'retry',retryAfterSeconds:Number.isFinite(seconds)?
          Math.min(3600,Math.max(10,Math.ceil(seconds))):60};
      }
      return {status:'retry'};
    }catch{return {status:'retry'};}
  }
}

export async function processVpnTrialReadyNotices(
  queue:PgVpnTrialReadyQueue,sender:TrialReadySender,maxMessages=10,
):Promise<{discovered:number;sent:number;skipped:number;retried:number;failed:number}>{
  if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>30)
    throw Error('Invalid trial-ready notification batch');
  const discovered=await queue.discover();
  await queue.discardStale();
  let sent=0,skipped=0,retried=0,failed=0;
  for(let i=0;i<maxMessages;i++){
    const job=await queue.reserve();
    if(!job)break;
    if(!await queue.stillEligible(job)){
      await queue.finalize(job,'SKIPPED',0,'not_eligible');
      skipped++;continue;
    }
    const result=await sender.send(job);
    if(result.status==='sent'){
      await queue.finalize(job,'SENT');sent++;continue;
    }
    if(result.status==='blocked'||job.attempt>=8){
      await queue.finalize(job,'FAILED',0,
        result.status==='blocked'?'telegram_chat_unavailable':'retry_limit');
      failed++;continue;
    }
    const backoff=Math.min(3600,10*2**Math.min(8,job.attempt-1));
    await queue.finalize(job,'PENDING',Math.max(backoff,result.retryAfterSeconds??0),'delivery_retry');
    retried++;
  }
  return {discovered,sent,skipped,retried,failed};
}
