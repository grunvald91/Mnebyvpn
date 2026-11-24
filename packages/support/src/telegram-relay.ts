/**
 * Operator-facing MNEBYVPN support relay: the same Telegram bot handles
 * subscriptions, user support requests and private operator replies.
 * The destination of operator notifications is their Telegram user ID,
 * NOT a separately configured support group or chat.
 */
export type SupportConfig={botToken:string;operatorId:number};
export function supportConfig(env:NodeJS.ProcessEnv=process.env):SupportConfig|null {
  // Reuse the primary bot token (GitHub secret TELEGRAM_TOKEN_BOT).
  // Its addition to the private backend environment must be audited.
  const botToken=env.TELEGRAM_TOKEN_BOT??'';
  const operator=env.SUPPORT_TELEGRAM_OPERATOR_ID??'';
  // The webhook can send one Bot API action in its JSON response without
  // storing the bot token on the server. A token is needed ONLY for proactive
  // messages (e.g. notifying the operator of a guest website ticket).
  if(!/^[1-9][0-9]{0,15}$/.test(operator)||
     !Number.isSafeInteger(Number(operator)))return null;
  const usableToken=/^[0-9]{5,20}:[A-Za-z0-9_-]{25,}$/.test(botToken)?botToken:'';
  return {botToken:usableToken,operatorId:Number(operator)};
}
export function validSupportText(raw:unknown,min=10,max=1500):raw is string {
  return typeof raw==='string'&&raw.trim().length>=min&&raw.trim().length<=max&&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw);
}
export function validSupportContact(raw:unknown):raw is string {
  if(typeof raw!=='string'||raw.length>120)return false;
  const value=raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)||
    /^@[A-Za-z0-9_]{5,32}$/.test(value);
}

export function operatorReplyTarget(message:unknown,operatorId:number):
  {userId:number;answer:string}|null{
  if(!message||typeof message!=='object')return null;
  const m=message as Record<string,any>;
  if(m.chat?.type!=='private'||m.chat?.id!==operatorId||
     m.from?.id!==operatorId||m.reply_to_message?.from?.is_bot!==true)
    return null;
  const quoted=typeof m.reply_to_message.text==='string'
    ?m.reply_to_message.text:'';
  const found=/^✉️ MNEBYVPN — обращение из бота\nID Telegram: ([0-9]{1,16})\n/.exec(quoted);
  if(!found)return null;
  const userId=Number(found[1]);
  const answer=typeof m.text==='string'?m.text.trim():'';
  if(!Number.isSafeInteger(userId)||userId<=0||userId===operatorId||
     !validSupportText(answer,1,1500))return null;
  return {userId,answer};
}
export function operatorWebsiteReply(message:unknown,operatorId:number):
  {ticketId:string;answer:string}|null{
  if(!message||typeof message!=='object')return null;
  const m=message as Record<string,any>;
  if(m.chat?.type!=='private'||m.chat?.id!==operatorId||
     m.from?.id!==operatorId||m.reply_to_message?.from?.is_bot!==true)
    return null;
  const quoted=typeof m.reply_to_message.text==='string'
    ?m.reply_to_message.text:'';
  const found=/^✉️ MNEBYVPN — обращение с сайта\nЗаявка: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\n/i.exec(quoted);
  const answer=typeof m.text==='string'?m.text.trim():'';
  if(!found||!validSupportText(answer,1,1500))return null;
  return {ticketId:found[1],answer};
}
export type SupportReplyMarkup={inline_keyboard:Array<Array<{
  text:string;callback_data?:string;url?:string
}>>};
export type BotApiSendOptions={
  maxAttempts?:number;
  baseDelayMs?:number;
  maxRetryAfterMs?:number;
  timeoutMs?:number;
  sleep?:(ms:number)=>Promise<void>;
  fetcher?:typeof fetch;
};
const DEFAULT_SLEEP=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

function parseRetryAfterMs(response:Response,body:unknown,maxMs:number):number|null{
  const param=(body as {parameters?:{retry_after?:unknown}}|null)?.parameters?.retry_after;
  if(typeof param==='number'&&Number.isFinite(param)&&param>0)
    return Math.min(maxMs,Math.max(100,Math.ceil(param*1000)));
  const header=response.headers.get('retry-after');
  if(header&&/^[0-9]+$/.test(header.trim()))
    return Math.min(maxMs,Math.max(100,Number(header.trim())*1000));
  return null;
}

/** Bounded Bot API POST with transient 429/5xx/network retries. Client 4xx
 * (except 429) and confirmed ok=false responses fail immediately. */
export async function sendTelegramBotApi(
  botToken:string,method:string,args:Record<string,unknown>,
  options:BotApiSendOptions={},
):Promise<unknown>{
  if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{25,}$/.test(botToken))
    throw Error('Outbound Telegram Bot API unavailable');
  if(!/^[A-Za-z][A-Za-z0-9]{1,40}$/.test(method))
    throw Error('Invalid Telegram Bot API method');
  const maxAttempts=Math.max(1,Math.min(5,options.maxAttempts??1));
  const baseDelayMs=Math.max(0,Math.min(2000,options.baseDelayMs??350));
  const maxRetryAfterMs=Math.max(0,Math.min(10000,options.maxRetryAfterMs??4000));
  const timeoutMs=Math.max(500,Math.min(15000,options.timeoutMs??7000));
  const wait=options.sleep??DEFAULT_SLEEP;
  const transport=options.fetcher??globalThis.fetch;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    let retryDelayMs:number|null=null;
    try{
      const response=await transport('https://api.telegram.org/bot'+botToken+'/'+method,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{'Content-Type':'application/json'},body:JSON.stringify(args),
      });
      if(response.ok){
        const payload:unknown=await response.json();
        if(!payload||typeof payload!=='object'||(payload as {ok?:boolean}).ok!==true)
          throw Error('Telegram Bot API response failure');
        return (payload as {result?:unknown}).result;
      }
      if(response.status===429&&attempt<maxAttempts){
        const errBody=await response.json().catch(()=>null);
        retryDelayMs=parseRetryAfterMs(response,errBody,maxRetryAfterMs)??baseDelayMs*attempt;
      }else if(response.status>=500&&attempt<maxAttempts){
        retryDelayMs=baseDelayMs*attempt;
      }else{
        throw Error('Telegram Bot API HTTP failure');
      }
    }catch(error){
      const msg=error instanceof Error?error.message:'';
      if(msg==='Telegram Bot API response failure'||msg==='Telegram Bot API HTTP failure'||attempt>=maxAttempts)
        throw error;
      retryDelayMs=baseDelayMs*attempt;
    }
    if(retryDelayMs!==null&&retryDelayMs>0)await wait(retryDelayMs);
  }
  throw Error('Telegram Bot API delivery failed');
}

export function formatWebsiteTicketNotice(
  ticketId:string,contact:string,message:string,
):{text:string;replyMarkup:SupportReplyMarkup}{
  return {
    text:'✉️ MNEBYVPN — обращение с сайта\nЗаявка: '+ticketId+
      '\nКонтакт: '+contact+'\n\nСообщение:\n'+message,
    replyMarkup:{inline_keyboard:[
      [{text:'✍️ Ответить',callback_data:'support:reply:site:'+ticketId}],
      [{text:'📥 Входящие заявки',callback_data:'support:page:0'}],
    ]},
  };
}

export async function telegramSupportSend(
  config:SupportConfig,text:string,to:number=config.operatorId,
  replyMarkup?:SupportReplyMarkup,options:BotApiSendOptions={},
):Promise<void>{
  if(!text||text.length>3800)throw Error('Support message too long');
  await sendTelegramBotApi(config.botToken,'sendMessage',{
    chat_id:to,text,link_preview_options:{is_disabled:true},
    ...(replyMarkup?{reply_markup:replyMarkup}:{}),
  },options);
}

export async function telegramSupportSendWithRetry(
  config:SupportConfig,text:string,to:number=config.operatorId,
  replyMarkup?:SupportReplyMarkup,options:BotApiSendOptions={},
):Promise<void>{
  await telegramSupportSend(config,text,to,replyMarkup,{maxAttempts:3,...options});
}

export type SupportTicketPool={
  query:(sql:string,params?:unknown[])=>Promise<{rowCount:number|null;rows:Array<Record<string,unknown>>}>;
};

/** Re-deliver durably persisted PENDING website tickets after Telegram outage recovery. */
export async function flushPendingSupportTickets(
  pool:SupportTicketPool,
  config:SupportConfig,
  options:{graceSeconds?:number;batchSize?:number;send?:typeof telegramSupportSend}={},
):Promise<{attempted:number;delivered:number;retried:number}>{
  if(!config.botToken)return {attempted:0,delivered:0,retried:0};
  const grace=Math.max(0,Math.min(3600,options.graceSeconds??15));
  const limit=Math.max(1,Math.min(20,options.batchSize??5));
  const deliver=options.send??telegramSupportSend;
  const pending=await pool.query(
    `SELECT id,contact,question FROM website_support_tickets
     WHERE delivery_state='PENDING' AND answer IS NULL
       AND created_at>clock_timestamp()-interval '7 days'
       AND created_at<=clock_timestamp()-($1::int*interval '1 second')
     ORDER BY created_at ASC LIMIT $2`,
    [grace,limit],
  );
  let delivered=0,retried=0;
  for(const row of pending.rows){
    const id=String(row.id??''),contact=String(row.contact??''),question=String(row.question??'');
    if(!id||!contact||!question)continue;
    const notice=formatWebsiteTicketNotice(id,contact,question);
    try{
      await deliver(config,notice.text,config.operatorId,notice.replyMarkup,{maxAttempts:1});
      await pool.query(
        "UPDATE website_support_tickets SET delivery_state='DELIVERED',delivered_at=clock_timestamp() WHERE id=$1 AND delivery_state='PENDING'",
        [id],
      ).catch(()=>{});
      delivered++;
    }catch{
      retried++;
    }
  }
  return {attempted:pending.rows.length,delivered,retried};
}
/** Bounded, process-local throttling; not a substitute for edge-level limits. */
export function supportLimiter(limit:number,windowMs:number) {
  const entries=new Map<string,{count:number;reset:number}>();
  return (key:string,now=Date.now()):boolean=>{
    if(entries.size>2048){
      for(const [name,value] of entries)if(value.reset<=now)entries.delete(name);
      if(entries.size>2048)entries.clear();
    }
    const current=entries.get(key);
    if(!current||current.reset<=now){
      entries.set(key,{count:1,reset:now+windowMs});
      return true;
    }
    if(current.count>=limit)return false;
    current.count++;
    return true;
  };
}
