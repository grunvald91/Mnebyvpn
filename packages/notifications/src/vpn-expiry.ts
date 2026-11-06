import type {Pool} from 'pg';

/** A reminder is unique for a specific, server-confirmed VPN expiry deadline. */
export interface VpnExpiryReminder {
  entitlementId:string;
  telegramUserId:string;
  daysBefore:1|3;
  expiresAt:Date;
  attempt:number;
}
export type DeliveryResult =
  | {status:'sent'}
  | {status:'blocked'}
  | {status:'retry';retryAfterSeconds?:number};
export interface ReminderSender {
  send(job:VpnExpiryReminder):Promise<DeliveryResult>;
}
const PER_MINUTE_BATCH=12;
const dueWindow =
  "(e.expires_at>clock_timestamp()+interval '48 hours' "+
  "AND e.expires_at<=clock_timestamp()+interval '72 hours') OR "+
  "(e.expires_at>clock_timestamp() "+
  "AND e.expires_at<=clock_timestamp()+interval '24 hours')";

export class PgVpnExpiryReminderQueue {
  private readonly pool:Pool;
  constructor(pool:Pool){this.pool=pool;}
  /** Runs after expiry/provisioning reconciliation. Only ACTIVE + node-ACK access. */
  async discover(limit=200):Promise<number>{
    if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Invalid reminder batch');
    const result=await this.pool.query(
      'INSERT INTO vpn_expiry_reminders(entitlement_id,days_before,expires_at) '+
      'SELECT e.id,CASE WHEN e.expires_at>clock_timestamp()+interval \'48 hours\' THEN 3 ELSE 1 END,'+
      'e.expires_at FROM entitlements e '+
      'JOIN accounts a ON a.id=e.account_id '+
      'JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter=\'vpn\' '+
      'WHERE e.product=\'vpn\' AND e.state=\'ACTIVE\' '+
      'AND a.telegram_user_id IS NOT NULL AND a.telegram_user_id>0 '+
      'AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL '+
      'AND ('+dueWindow+') ORDER BY e.expires_at,e.id LIMIT $1 '+
      'ON CONFLICT(entitlement_id,days_before,expires_at) DO NOTHING',
      [limit]);
    return result.rowCount??0;
  }
  /** Concurrency-safe, short-lived reservation for one running worker. */
  async reserve():Promise<VpnExpiryReminder|null>{
    const result=await this.pool.query(
      'WITH pick AS ( '+
      'SELECT r.entitlement_id,r.days_before,r.expires_at FROM vpn_expiry_reminders r '+
      'JOIN entitlements e ON e.id=r.entitlement_id AND e.expires_at=r.expires_at '+
      'JOIN accounts a ON a.id=e.account_id '+
      'JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter=\'vpn\' '+
      'WHERE ((r.status=\'PENDING\' AND r.next_attempt_at<=clock_timestamp()) '+
      ' OR (r.status=\'SENDING\' AND r.locked_until<=clock_timestamp())) '+
      'AND e.product=\'vpn\' AND e.state=\'ACTIVE\' '+
      'AND a.telegram_user_id IS NOT NULL AND a.telegram_user_id>0 '+
      'AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL '+
      'AND ((r.days_before=3 AND e.expires_at>clock_timestamp()+interval \'48 hours\' '+
      'AND e.expires_at<=clock_timestamp()+interval \'72 hours\') OR '+
      '(r.days_before=1 AND e.expires_at>clock_timestamp() '+
      'AND e.expires_at<=clock_timestamp()+interval \'24 hours\')) '+
      'ORDER BY r.next_attempt_at,r.expires_at,r.entitlement_id '+
      'LIMIT 1 FOR UPDATE OF r SKIP LOCKED), '+
      'claimed AS (UPDATE vpn_expiry_reminders r SET status=\'SENDING\', '+
      'attempts=attempts+1,locked_until=clock_timestamp()+interval \'120 seconds\' '+
      'FROM pick WHERE r.entitlement_id=pick.entitlement_id '+
      'AND r.days_before=pick.days_before AND r.expires_at=pick.expires_at '+
      'RETURNING r.entitlement_id,r.days_before,r.expires_at,r.attempts) '+
      'SELECT c.*,a.telegram_user_id FROM claimed c '+
      'JOIN entitlements e ON e.id=c.entitlement_id JOIN accounts a ON a.id=e.account_id');
    if(result.rowCount!==1)return null;
    const r=result.rows[0];
    const userId=String(r.telegram_user_id??'');
    const days=Number(r.days_before);
    const attempts=Number(r.attempts);
    const expiry=new Date(r.expires_at);
    if(!/^[1-9][0-9]{0,15}$/.test(userId)||![1,3].includes(days)||
       !Number.isSafeInteger(attempts)||attempts<1||Number.isNaN(expiry.getTime()))
      throw Error('Invalid reminder data');
    return {entitlementId:String(r.entitlement_id),
      telegramUserId:userId,daysBefore:days as 1|3,expiresAt:expiry,attempt:attempts};
  }
  /** Final check before network I/O; renewals and refunds cancel stale jobs. */
  async stillEligible(job:VpnExpiryReminder):Promise<boolean>{
    const result=await this.pool.query(
      'SELECT 1 FROM entitlements e JOIN accounts a ON a.id=e.account_id '+
      'JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter=\'vpn\' '+
      'WHERE e.id=$1 AND e.expires_at=$2 AND e.product=\'vpn\' '+
      'AND e.state=\'ACTIVE\' AND a.telegram_user_id=$3 '+
      'AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL '+
      'AND (CASE WHEN $4::int=3 THEN '+
      'e.expires_at>clock_timestamp()+interval \'48 hours\' AND '+
      'e.expires_at<=clock_timestamp()+interval \'72 hours\' ELSE '+
      'e.expires_at>clock_timestamp() AND '+
      'e.expires_at<=clock_timestamp()+interval \'24 hours\' END) LIMIT 1',
      [job.entitlementId,job.expiresAt,job.telegramUserId,job.daysBefore]);
    return result.rowCount===1;
  }
  async finalize(job:VpnExpiryReminder,status:'SENT'|'SKIPPED'|'FAILED'|'PENDING',
    retryAfterSeconds=0,reason:string|null=null):Promise<void>{
    if(!['SENT','SKIPPED','FAILED','PENDING'].includes(status))throw Error('Invalid status');
    const seconds=Math.max(0,Math.min(3600,Math.floor(retryAfterSeconds)));
    await this.pool.query(
      'UPDATE vpn_expiry_reminders SET status=$5,locked_until=NULL, '+
      'next_attempt_at=clock_timestamp()+($6::int*interval \'1 second\'),' +
      'sent_at=CASE WHEN $5=\'SENT\' THEN clock_timestamp() ELSE NULL END,'+
      'last_error_code=$7 WHERE entitlement_id=$1 AND days_before=$2 '+
      'AND expires_at=$3 AND attempts=$4 AND status=\'SENDING\'',
      [job.entitlementId,job.daysBefore,job.expiresAt,job.attempt,status,seconds,reason]);
  }
  /** Never leave indefinitely queued jobs after expiry or renewal. */
  async discardStale():Promise<number>{
    const result=await this.pool.query(
      'UPDATE vpn_expiry_reminders r SET status=\'SKIPPED\',locked_until=NULL '+
      'WHERE r.status IN (\'PENDING\',\'SENDING\') '+
      'AND (r.expires_at<=clock_timestamp() OR NOT EXISTS '+
      '(SELECT 1 FROM entitlements e JOIN accounts a ON a.id=e.account_id '+
      'WHERE e.id=r.entitlement_id AND e.expires_at=r.expires_at '+
      'AND e.state=\'ACTIVE\' AND e.product=\'vpn\' '+
      'AND a.telegram_user_id IS NOT NULL))');
    return result.rowCount??0;
  }
}
export function formatVpnExpiryReminder(job:VpnExpiryReminder):string{
  if(![1,3].includes(job.daysBefore)||!Number.isFinite(job.expiresAt.getTime()))
    throw Error('Invalid reminder deadline');
  const deadline=job.expiresAt.toLocaleString('ru-RU',{
    timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',
  });
  return '⏰ MNEBYVPN\n\nДо окончания вашей VPN-подписки осталось '+
    (job.daysBefore===3?'около 3 дней.':'около 1 дня.')+
    '\n\nДоступ закончится: '+deadline+' (МСК).'+
    '\n\nПродлите подписку заранее, чтобы подключение не прерывалось.';
}
export class TelegramBotReminderSender implements ReminderSender{
  private readonly token:string;
  private readonly fetcher:typeof fetch;
  constructor(token:string,fetcher:typeof fetch=fetch){
    if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/.test(token))
      throw Error('Invalid Telegram bot token');
    this.token=token;
    this.fetcher=fetcher;
  }
  async send(job:VpnExpiryReminder):Promise<DeliveryResult>{
    const endpoint='https://api.telegram.org/bot'+this.token+'/sendMessage';
    const body={
      chat_id:job.telegramUserId,
      text:formatVpnExpiryReminder(job),
      link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[
        [{text:'🔁 Продлить VPN',callback_data:'nav:renew'}],
        [{text:'🌍 Оплата на сайте',url:'https://mnebyvpn.site/#plans'}],
      ]},
    };
    try{
      const response=await this.fetcher(endpoint,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      });
      if(response.ok){
        const data=await response.json() as {ok?:unknown};
        return data.ok===true?{status:'sent'}:{status:'retry'};
      }
      if(response.status===403||response.status===400)
        return {status:'blocked'};
      if(response.status===429){
        const data=await response.json() as {parameters?:{retry_after?:number}};
        const retry=Number(data?.parameters?.retry_after);
        return {status:'retry',retryAfterSeconds:Number.isFinite(retry)?
          Math.max(10,Math.min(3600,Math.ceil(retry))):60};
      }
      return {status:'retry'};
    }catch{
      // Timeout after Telegram accepted the request is ambiguous. At-least-once
      // delivery may produce a rare duplicate rather than silently lose a notice.
      return {status:'retry'};
    }
  }
}
/** One sweep from the running VPN service. Telegram failures cannot block provisioning. */
export async function processVpnExpiryReminders(
  queue:PgVpnExpiryReminderQueue,sender:ReminderSender,maxMessages=PER_MINUTE_BATCH,
):Promise<{discovered:number;sent:number;skipped:number;retried:number;failed:number}>{
  if(!Number.isInteger(maxMessages)||maxMessages<1||maxMessages>30)
    throw Error('Invalid reminder dispatch limit');
  const discovered=await queue.discover(200);
  await queue.discardStale();
  let sent=0,skipped=0,retried=0,failed=0;
  for(let i=0;i<maxMessages;i++){
    const job=await queue.reserve();
    if(!job)break;
    if(!await queue.stillEligible(job)){
      await queue.finalize(job,'SKIPPED',0,'deadline_changed');
      skipped++;continue;
    }
    const delivery=await sender.send(job);
    if(delivery.status==='sent'){
      await queue.finalize(job,'SENT');sent++;continue;
    }
    if(delivery.status==='blocked'){
      await queue.finalize(job,'FAILED',0,'telegram_chat_unavailable');
      failed++;continue;
    }
    if(job.attempt>=8){
      await queue.finalize(job,'FAILED',0,'retry_limit');
      failed++;continue;
    }
    const backoff=Math.min(3600,60*2**Math.min(5,job.attempt-1));
    await queue.finalize(job,'PENDING',Math.max(backoff,
      delivery.retryAfterSeconds??0),'delivery_retry');
    retried++;
  }
  return {discovered,sent,skipped,retried,failed};
}
