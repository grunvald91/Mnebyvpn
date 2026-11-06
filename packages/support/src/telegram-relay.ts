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
  if(!botToken&&!operator)return null;
  if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{25,}$/.test(botToken)||
     !/^[1-9][0-9]{0,15}$/.test(operator)||
     !Number.isSafeInteger(Number(operator)))
    throw Error('Invalid MNEBYVPN support operator configuration');
  return {botToken,operatorId:Number(operator)};
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
export async function telegramSupportSend(
  config:SupportConfig,text:string,to:number=config.operatorId,
):Promise<void>{
  if(!text||text.length>3800)throw Error('Support message too long');
  const response=await fetch('https://api.telegram.org/bot'+config.botToken+'/sendMessage',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:to,text,link_preview_options:{is_disabled:true}}),
  });
  if(!response.ok)throw Error('Support Telegram delivery failed');
  const payload:unknown=await response.json();
  if(!payload||typeof payload!=='object'||(payload as {ok?:boolean}).ok!==true)
    throw Error('Support Telegram delivery not confirmed');
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
