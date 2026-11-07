/**
 * Minimal production Telegram responder until live VPN/DNS provisioning and
 * commercial safety gates are independently verified.
 *
 * Telegram supports invoking ONE Bot API method through the JSON response to
 * its webhook. The bot token stays in the repo's Actions secret; it is NEVER
 * copied to the VPS. The VPS stores only SHA-256(secret_token).
 *
 * This intentionally does NOT accept orders or claim subscriptions are active.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const env=(name:string):string=>{
  const value=process.env[name];
  if(!value)throw new Error('Missing configuration: '+name);
  return value;
};
if(process.env.MNEBYVPN_ENV!=='production' ||
   process.env.BOT_PUBLIC_INFO_ONLY!=='yes')
  throw new Error('Telegram public responder may run only as informational production service');

const digest=env('TELEGRAM_WEBHOOK_SECRET_SHA256');
if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('Invalid Telegram webhook secret digest');
const expected=Buffer.from(digest,'hex');
const port=Number(process.env.BOT_PORT??'8793');
if(!Number.isSafeInteger(port)||port<1||port>65535)
  throw new Error('Invalid BOT_PORT');

function send(res:ServerResponse,status:number,data:unknown){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.writeHead(status).end(JSON.stringify(data));
}
function isAuthorized(req:IncomingMessage){
  const header=req.headers['x-telegram-bot-api-secret-token'];
  if(typeof header!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(header))
    return false;
  const actual=createHash('sha256').update(header,'utf8').digest();
  return timingSafeEqual(expected,actual);
}
async function readBody(req:IncomingMessage){
  let length=0;
  const parts:Buffer[]=[];
  for await(const chunk of req){
    const piece=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    length+=piece.length;
    if(length>65536)throw new Error('Oversized Telegram webhook');
    parts.push(piece);
  }
  const parsed:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw new Error('Malformed Telegram update');
  return parsed as Record<string,any>;
}
function menu(id:number){
  return {
    method:'sendMessage',chat_id:id,
    text:'🌐 MNEBYVPN\n\nПодготавливаем VPN и Smart DNS. Сайт уже доступен, но подключение, пробный доступ и оплата пока не запущены.\n\nКогда проверим безопасность соединений и выдачу доступа, здесь появится управление подпиской.',
    reply_markup:{inline_keyboard:[
      [{text:'🌍 Открыть сайт',url:'https://mnebyvpn.site'}],
      [{text:'🌐 VPN',callback_data:'info:vpn'},
       {text:'🧭 Smart DNS',callback_data:'info:dns'}],
      [{text:'❔ Как это работает',callback_data:'info:help'}],
    ]},
  };
}
function answer(update:Record<string,any>):unknown{
  if(!Number.isSafeInteger(update.update_id)||update.update_id<0)
    throw new Error('Invalid update id');
  const payment=update.message?.successful_payment||update.message?.refunded_payment;
  if(payment)throw new Error('Financial event requires durable settlement, which is not enabled');
  const checkout=update.pre_checkout_query;
  if(checkout&&typeof checkout.id==='string')return {
    method:'answerPreCheckoutQuery',pre_checkout_query_id:checkout.id,ok:false,
    error_message:'Продажи пока не открыты: сетевой доступ проходит проверку.',
  };
  const callback=update.callback_query;
  if(callback&&typeof callback.id==='string') {
    if(!Number.isSafeInteger(callback.from?.id)||callback.from.id<=0 ||
       callback.message?.chat?.type!=='private' ||
       callback.message?.chat?.id!==callback.from.id)
      return {method:'answerCallbackQuery',callback_query_id:callback.id,
        text:'Недоступно для этого чата',show_alert:false};
    const label=callback.data==='info:vpn'?'VPN':
      callback.data==='info:dns'?'Smart DNS':
      callback.data==='info:help'?'Подключение и управление появятся после сетевых испытаний':
      'Сейчас доступны сведения о проекте на сайте';
    return {method:'answerCallbackQuery',callback_query_id:callback.id,
      text:label==='VPN'||label==='Smart DNS'
        ? label+': сервис ещё не запущен. Откройте сайт для информации.'
        : label,show_alert:true};
  }
  const widget=update.widget_query||update.shared_widget_query;
  if(widget&&typeof widget.id==='string')return {
    method:'answerWidgetQuery',widget_query_id:widget.id,data:'NOT_AVAILABLE',
  };
  const msg=update.message;
  if(msg?.chat?.type==='private' && Number.isSafeInteger(msg.chat.id) &&
    msg.chat.id>0 && msg.from?.id===msg.chat.id)
    return menu(msg.chat.id);
  return null;
}
const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){
    send(res,200,{status:'ok',component:'telegram-information-webhook'});return;
  }
  if(req.method==='GET'&&req.url==='/readyz'){
    send(res,503,{ready:false,reason:'COMMERCIAL_NETWORK_GATES_NOT_VERIFIED'});return;
  }
  if(req.method!=='POST'||req.url!=='/webhooks/telegram'){
    send(res,404,{code:'NOT_FOUND'});return;
  }
  if(!isAuthorized(req)){send(res,401,{code:'UNAUTHORIZED'});return;}
  if(!req.headers['content-type']?.toLowerCase().startsWith('application/json')){
    send(res,415,{code:'UNSUPPORTED_MEDIA_TYPE'});return;
  }
  try {
    const update=await readBody(req);
    const response=answer(update);
    if(response){send(res,200,response);return;}
    res.setHeader('Cache-Control','no-store');
    res.writeHead(200).end();
  }catch{
    // A payment cannot be acknowledged without a durable account settlement.
    // Telegram will retry non-2xx updates. Never log payloads or user IDs.
    send(res,503,{code:'RETRY_LATER'});
  }
});
server.listen(port,'127.0.0.1',()=>{
  console.info('Telegram informational webhook listening on 127.0.0.1:'+port);
});
