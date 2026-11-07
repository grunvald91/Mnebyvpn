import type {Pool} from 'pg';
import type {DeliveryResult} from './vpn-expiry.ts';

export interface PurchaseNotice {
  orderId:string;
  kind:'PAYMENT'|'READY';
  telegramUserId:string;
  title:string;
  days:number;
  amountMinor:number;
  attempt:number;
}
export interface PurchaseNoticeSender {
  send(job:PurchaseNotice):Promise<DeliveryResult>;
}

const readyFor = `EXISTS (
  SELECT 1 FROM entitlements e
  JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
  WHERE e.account_id=o.account_id AND e.product='vpn'
    AND (e.source_order_id=o.id OR EXISTS (
      SELECT 1 FROM order_renewals r WHERE r.order_id=o.id AND r.entitlement_id=e.id
    ))
    AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
    AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL
)`;

export class PgVpnPurchaseNoticeQueue {
  constructor(private readonly pool:Pick<Pool,'query'>){}
  /** Discovery is idempotent and observes only verified provider captures. */
  async discover():Promise<number>{
    const common=` FROM orders o
      JOIN accounts a ON a.id=o.account_id
      JOIN provider_captures c ON c.order_id=o.id AND c.provider='prodamus'
      WHERE o.provider='prodamus' AND o.product='vpn' AND o.state='PAID'
        AND c.created_at>clock_timestamp()-interval '14 days'
        AND a.telegram_user_id IS NOT NULL
        AND a.telegram_user_id::text ~ '^[1-9][0-9]{0,15}`;
    const payment=await this.pool.query(
      `INSERT INTO vpn_purchase_notifications(order_id,kind,telegram_user_id)
       SELECT o.id,'PAYMENT',a.telegram_user_id::text ${common}
       ON CONFLICT(order_id,kind) DO NOTHING`);
    const ready=await this.pool.query(
      `INSERT INTO vpn_purchase_notifications(order_id,kind,telegram_user_id)
       SELECT o.id,'READY',a.telegram_user_id::text ${common}
         AND ${readyFor}
       ON CONFLICT(order_id,kind) DO NOTHING`);
    return (payment.rowCount??0)+(ready.rowCount??0);
  }
  async reserve():Promise<PurchaseNotice|null>{
    const result=await this.pool.query(
      `WITH pick AS (
         SELECT n.order_id,n.kind FROM vpn_purchase_notifications n
         JOIN orders o ON o.id=n.order_id
         JOIN accounts a ON a.id=o.account_id
         WHERE ((n.status='PENDING' AND n.next_attempt_at<=clock_timestamp())
           OR (n.status='SENDING' AND n.locked_until<=clock_timestamp()))
           AND a.telegram_user_id::text=n.telegram_user_id
           AND o.provider='prodamus' AND o.state='PAID'
           AND (n.kind='PAYMENT' OR EXISTS (
             SELECT 1 FROM vpn_purchase_notifications previous
             WHERE previous.order_id=n.order_id AND previous.kind='PAYMENT'
               AND previous.status='SENT'
           ))
         ORDER BY n.next_attempt_at,n.order_id,
           CASE n.kind WHEN 'PAYMENT' THEN 0 ELSE 1 END
         LIMIT 1 FOR UPDATE OF n SKIP LOCKED
       ), claimed AS (
         UPDATE vpn_purchase_notifications n SET status='SENDING',
           attempts=attempts+1,locked_until=clock_timestamp()+interval '120 seconds'
         FROM pick WHERE n.order_id=pick.order_id AND n.kind=pick.kind
         RETURNING n.order_id,n.kind,n.telegram_user_id,n.attempts
       )
       SELECT c.*,t.plan_title,t.duration_seconds,o.amount_minor
       FROM claimed c
       JOIN orders o ON o.id=c.order_id
       JOIN order_terms t ON t.order_id=o.id`);
    if(result.rowCount!==1)return null;
    const r=result.rows[0];
    const amount=Number(r.amount_minor),days=Number(r.duration_seconds)/86400;
    const attempt=Number(r.attempts);
    if(!['PAYMENT','READY'].includes(r.kind)||
       !/^[1-9][0-9]{0,15}$/.test(String(r.telegram_user_id))||
       !Number.isSafeInteger(amount)||amount<=0||
       !Number.isSafeInteger(days)||days<=0||
       !Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid purchase notice');
    return {orderId:String(r.order_id),kind:r.kind,telegramUserId:String(r.telegram_user_id),
      title:String(r.plan_title),days,amountMinor:amount,attempt};
  }
  async stillEligible(job:PurchaseNotice):Promise<boolean>{
    const result=await this.pool.query(
      `SELECT 1 FROM vpn_purchase_notifications n
        JOIN orders o ON o.id=n.order_id JOIN accounts a ON a.id=o.account_id
        JOIN provider_captures c ON c.order_id=o.id AND c.provider='prodamus'
        WHERE n.order_id=$1 AND n.kind=$2 AND n.status='SENDING'
          AND n.attempts=$4 AND n.telegram_user_id=$3
          AND a.telegram_user_id::text=$3
          AND o.provider='prodamus' AND o.state='PAID'
          AND (n.kind='PAYMENT' OR ${readyFor})
        LIMIT 1`,
      [job.orderId,job.kind,job.telegramUserId,job.attempt]);
    return result.rowCount===1;
  }
  async finalize(job:PurchaseNotice,status:'PENDING'|'SENT'|'FAILED'|'SKIPPED',
    retryAfterSeconds=0,reason:string|null=null):Promise<void>{
    const delay=Math.max(0,Math.min(3600,Math.ceil(retryAfterSeconds)));
    await this.pool.query(
      `UPDATE vpn_purchase_notifications
          SET status=$5,locked_until=NULL,
              next_attempt_at=clock_timestamp()+($6::int*interval '1 second'),
              sent_at=CASE WHEN $5='SENT' THEN clock_timestamp() ELSE NULL END,
              last_error_code=$7
        WHERE order_id=$1 AND kind=$2 AND telegram_user_id=$3
          AND attempts=$4 AND status='SENDING'`,
      [job.orderId,job.kind,job.telegramUserId,job.attempt,status,delay,reason]);
  }
  async discardStale():Promise<number>{
    const result=await this.pool.query(
      `UPDATE vpn_purchase_notifications n SET status='SKIPPED',locked_until=NULL
       FROM orders o JOIN accounts a ON a.id=o.account_id
       WHERE n.order_id=o.id AND n.status IN ('PENDING','SENDING')
         AND (o.state<>'PAID' OR a.telegram_user_id::text IS DISTINCT FROM n.telegram_user_id)`);
    return result.rowCount??0;
  }
}

export function purchaseNoticeMessage(job:PurchaseNotice):{text:string;reply_markup:unknown}{
  if(job.kind==='PAYMENT')return {
    text:'✅ MNEBYVPN — оплата подтверждена!\n\n'+
      '🌐 '+job.title+'\n'+
      '💳 Оплачено: '+(job.amountMinor/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽\n\n'+
      'Подготавливаем VPN-доступ. Когда сервер подтвердит активацию, пришлём инструкцию. '+
      'Повторная оплата не требуется.',
    reply_markup:{inline_keyboard:[
      [{text:'🔐 Мои подключения',callback_data:'nav:status'}],
      [{text:'🌍 Личный кабинет',url:'https://mnebyvpn.site/#account'}],
    ]},
  };
  return {
    text:'✅ MNEBYVPN — ваш VPN готов!\n\n'+
      job.title+'\n\n'+
      'Выберите устройство, установите рекомендованное приложение и нажмите «Добавить подписку». '+
      'Персональная ссылка появится после выбора устройства.',
    reply_markup:{inline_keyboard:[
      [{text:'⚡ Подключить VPN',callback_data:'nav:connect'}],
      [{text:'🔐 Мои подключения',callback_data:'nav:status'}],
    ]},
  };
}

export class TelegramBotPurchaseSender implements PurchaseNoticeSender {
  constructor(private readonly token:string,private readonly fetcher:typeof fetch=fetch){
    if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/.test(token))
      throw Error('Invalid Telegram bot token');
  }
  async send(job:PurchaseNotice):Promise<DeliveryResult>{
    try{
      const response=await this.fetcher('https://api.telegram.org/bot'+this.token+'/sendMessage',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:job.telegramUserId,...purchaseNoticeMessage(job),
          link_preview_options:{is_disabled:true}}),
      });
      if(response.ok){
        const body=await response.json() as {ok?:unknown};
        return body.ok===true?{status:'sent'}:{status:'retry'};
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

export async function processVpnPurchaseNotices(
  queue:PgVpnPurchaseNoticeQueue,sender:PurchaseNoticeSender,maxMessages=10,
):Promise<{discovered:number;sent:number;skipped:number;retried:number;failed:number}>{
  if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>30)
    throw Error('Invalid purchase notification batch');
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
      await queue.finalize(job,'SENT');
      sent++;continue;
    }
    if(result.status==='blocked'||job.attempt>=8){
      await queue.finalize(job,'FAILED',0,result.status==='blocked'?
        'telegram_chat_unavailable':'retry_limit');
      failed++;continue;
    }
    const backoff=Math.min(3600,60*2**Math.min(5,job.attempt-1));
    await queue.finalize(job,'PENDING',Math.max(backoff,
      result.retryAfterSeconds??0),'delivery_retry');
    retried++;
  }
  return {discovered,sent,skipped,retried,failed};
}
`;
    const payment=await this.pool.query(
      `INSERT INTO vpn_purchase_notifications(order_id,kind,telegram_user_id)
       SELECT o.id,'PAYMENT',a.telegram_user_id ${common}
       ON CONFLICT(order_id,kind) DO NOTHING`);
    const ready=await this.pool.query(
      `INSERT INTO vpn_purchase_notifications(order_id,kind,telegram_user_id)
       SELECT o.id,'READY',a.telegram_user_id ${common}
         AND ${readyFor}
       ON CONFLICT(order_id,kind) DO NOTHING`);
    return (payment.rowCount??0)+(ready.rowCount??0);
  }
  async reserve():Promise<PurchaseNotice|null>{
    const result=await this.pool.query(
      `WITH pick AS (
         SELECT n.order_id,n.kind FROM vpn_purchase_notifications n
         JOIN orders o ON o.id=n.order_id
         JOIN accounts a ON a.id=o.account_id
         WHERE ((n.status='PENDING' AND n.next_attempt_at<=clock_timestamp())
           OR (n.status='SENDING' AND n.locked_until<=clock_timestamp()))
           AND a.telegram_user_id=n.telegram_user_id
           AND o.provider='prodamus' AND o.state='PAID'
           AND (n.kind='PAYMENT' OR EXISTS (
             SELECT 1 FROM vpn_purchase_notifications previous
             WHERE previous.order_id=n.order_id AND previous.kind='PAYMENT'
               AND previous.status='SENT'
           ))
         ORDER BY n.next_attempt_at,n.order_id,
           CASE n.kind WHEN 'PAYMENT' THEN 0 ELSE 1 END
         LIMIT 1 FOR UPDATE OF n SKIP LOCKED
       ), claimed AS (
         UPDATE vpn_purchase_notifications n SET status='SENDING',
           attempts=attempts+1,locked_until=clock_timestamp()+interval '120 seconds'
         FROM pick WHERE n.order_id=pick.order_id AND n.kind=pick.kind
         RETURNING n.order_id,n.kind,n.telegram_user_id,n.attempts
       )
       SELECT c.*,t.plan_title,t.duration_seconds,o.amount_minor
       FROM claimed c
       JOIN orders o ON o.id=c.order_id
       JOIN order_terms t ON t.order_id=o.id`);
    if(result.rowCount!==1)return null;
    const r=result.rows[0];
    const amount=Number(r.amount_minor),days=Number(r.duration_seconds)/86400;
    const attempt=Number(r.attempts);
    if(!['PAYMENT','READY'].includes(r.kind)||
       !/^[1-9][0-9]{0,15}$/.test(String(r.telegram_user_id))||
       !Number.isSafeInteger(amount)||amount<=0||
       !Number.isSafeInteger(days)||days<=0||
       !Number.isSafeInteger(attempt)||attempt<1)throw Error('Invalid purchase notice');
    return {orderId:String(r.order_id),kind:r.kind,telegramUserId:String(r.telegram_user_id),
      title:String(r.plan_title),days,amountMinor:amount,attempt};
  }
  async stillEligible(job:PurchaseNotice):Promise<boolean>{
    const result=await this.pool.query(
      `SELECT 1 FROM vpn_purchase_notifications n
        JOIN orders o ON o.id=n.order_id JOIN accounts a ON a.id=o.account_id
        JOIN provider_captures c ON c.order_id=o.id AND c.provider='prodamus'
        WHERE n.order_id=$1 AND n.kind=$2 AND n.status='SENDING'
          AND n.attempts=$4 AND n.telegram_user_id=$3
          AND a.telegram_user_id=$3
          AND o.provider='prodamus' AND o.state='PAID'
          AND (n.kind='PAYMENT' OR ${readyFor})
        LIMIT 1`,
      [job.orderId,job.kind,job.telegramUserId,job.attempt]);
    return result.rowCount===1;
  }
  async finalize(job:PurchaseNotice,status:'PENDING'|'SENT'|'FAILED'|'SKIPPED',
    retryAfterSeconds=0,reason:string|null=null):Promise<void>{
    const delay=Math.max(0,Math.min(3600,Math.ceil(retryAfterSeconds)));
    await this.pool.query(
      `UPDATE vpn_purchase_notifications
          SET status=$5,locked_until=NULL,
              next_attempt_at=clock_timestamp()+($6::int*interval '1 second'),
              sent_at=CASE WHEN $5='SENT' THEN clock_timestamp() ELSE NULL END,
              last_error_code=$7
        WHERE order_id=$1 AND kind=$2 AND telegram_user_id=$3
          AND attempts=$4 AND status='SENDING'`,
      [job.orderId,job.kind,job.telegramUserId,job.attempt,status,delay,reason]);
  }
  async discardStale():Promise<number>{
    const result=await this.pool.query(
      `UPDATE vpn_purchase_notifications n SET status='SKIPPED',locked_until=NULL
       FROM orders o JOIN accounts a ON a.id=o.account_id
       WHERE n.order_id=o.id AND n.status IN ('PENDING','SENDING')
         AND (o.state<>'PAID' OR a.telegram_user_id IS DISTINCT FROM n.telegram_user_id)`);
    return result.rowCount??0;
  }
}

export function purchaseNoticeMessage(job:PurchaseNotice):{text:string;reply_markup:unknown}{
  if(job.kind==='PAYMENT')return {
    text:'✅ MNEBYVPN — оплата подтверждена!\n\n'+
      '🌐 '+job.title+'\n'+
      '💳 Оплачено: '+(job.amountMinor/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽\n\n'+
      'Подготавливаем VPN-доступ. Когда сервер подтвердит активацию, пришлём инструкцию. '+
      'Повторная оплата не требуется.',
    reply_markup:{inline_keyboard:[
      [{text:'🔐 Мои подключения',callback_data:'nav:status'}],
      [{text:'🌍 Личный кабинет',url:'https://mnebyvpn.site/#account'}],
    ]},
  };
  return {
    text:'✅ MNEBYVPN — ваш VPN готов!\n\n'+
      job.title+'\n\n'+
      'Выберите устройство, установите рекомендованное приложение и нажмите «Добавить подписку». '+
      'Персональная ссылка появится после выбора устройства.',
    reply_markup:{inline_keyboard:[
      [{text:'⚡ Подключить VPN',callback_data:'nav:connect'}],
      [{text:'🔐 Мои подключения',callback_data:'nav:status'}],
    ]},
  };
}

export class TelegramBotPurchaseSender implements PurchaseNoticeSender {
  constructor(private readonly token:string,private readonly fetcher:typeof fetch=fetch){
    if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/.test(token))
      throw Error('Invalid Telegram bot token');
  }
  async send(job:PurchaseNotice):Promise<DeliveryResult>{
    try{
      const response=await this.fetcher('https://api.telegram.org/bot'+this.token+'/sendMessage',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:job.telegramUserId,...purchaseNoticeMessage(job),
          link_preview_options:{is_disabled:true}}),
      });
      if(response.ok){
        const body=await response.json() as {ok?:unknown};
        return body.ok===true?{status:'sent'}:{status:'retry'};
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

export async function processVpnPurchaseNotices(
  queue:PgVpnPurchaseNoticeQueue,sender:PurchaseNoticeSender,maxMessages=10,
):Promise<{discovered:number;sent:number;skipped:number;retried:number;failed:number}>{
  if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>30)
    throw Error('Invalid purchase notification batch');
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
      await queue.finalize(job,'SENT');
      sent++;continue;
    }
    if(result.status==='blocked'||job.attempt>=8){
      await queue.finalize(job,'FAILED',0,result.status==='blocked'?
        'telegram_chat_unavailable':'retry_limit');
      failed++;continue;
    }
    const backoff=Math.min(3600,60*2**Math.min(5,job.attempt-1));
    await queue.finalize(job,'PENDING',Math.max(backoff,
      result.retryAfterSeconds??0),'delivery_retry');
    retried++;
  }
  return {discovered,sent,skipped,retried,failed};
}
