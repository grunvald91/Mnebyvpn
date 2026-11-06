/**
 * Operator-facing MnebyVPN support relay.
 * Secrets come only from the runtime environment; no customer text in logs.
 * A successful sendMessage response is required before confirming delivery.
 */
export type SupportConfig={botToken:string;chatId:number;operatorId:number|null};
export function supportConfig(env:NodeJS.ProcessEnv=process.env):SupportConfig|null {
  const botToken=env.SUPPORT_TELEGRAM_BOT_TOKEN??'';
  const chat=env.SUPPORT_TELEGRAM_CHAT_ID??'';
  if(!botToken&&!chat)return null;
  if(!/^[0-9]{5,20}:[A-Za-z0-9_-]{25,}$/.test(botToken)||
     !/^-?[0-9]{1,20}$/.test(chat)||
     !Number.isSafeInteger(Number(chat))||Number(chat)===0)
    throw Error('Invalid support Telegram configuration');
  const operator=env.SUPPORT_TELEGRAM_OPERATOR_ID??'';
  if(operator&&(!/^[0-9]{1,20}$/.test(operator)||
      !Number.isSafeInteger(Number(operator))||Number(operator)<1))
    throw Error('Invalid support Telegram operator ID');
  return {botToken,chatId:Number(chat),operatorId:operator?Number(operator):null};
}
export function validSupportText(raw:unknown,min=10,max=1500):raw is string {
  return typeof raw==='string'&&raw.trim().length>=min&&raw.trim().length<=max&&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw);
}
export function validSupportContact(raw:unknown):raw is string {
  return typeof raw==='string'&&raw.trim().length>=3&&raw.trim().length<=120&&
    !/[\u0000-\u001F\u007F]/.test(raw);
}
export async function telegramSupportSend(
  config:SupportConfig,text:string,to:number=config.chatId,
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
