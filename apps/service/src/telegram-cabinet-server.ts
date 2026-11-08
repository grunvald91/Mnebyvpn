/**
 * Telegram-first cabinet. The public site is an optional backup, never a
 * required step to navigate the bot.
 *
 * No Bot API token is stored on this server: Telegram performs the one Bot
 * API action encoded in a webhook JSON response. A hardened foreign TLS/WG
 * ingress carries updates to this private backend. User identity is provided
 * only by authenticated Telegram updates, not caller-supplied account IDs.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {operatorReplyTarget,operatorWebsiteReply,supportConfig,supportLimiter,telegramSupportSend,validSupportText}
  from '../../../packages/support/src/telegram-relay.ts';
import {
  PgBillingStore,starsOrderFromDB,pricedPlanForOrder,starsPaymentHash,
} from '../../../packages/billing/src/store.ts';
import {
  buildStarsInvoice,parseStarsPayload,validateStarsPreCheckout,validateStarsSuccess,
} from '../../../packages/billing/src/stars.ts';
import {activationView,deviceView,manualView}
  from './vpn-onboarding.ts';
import {formatDuration,formatRoubles} from '../../../packages/telegram-ui/src/menu.ts';
import {effectiveAccessState,formatRemainingTime,formatRemainingQuota} from '../../../packages/telegram-ui/src/access-format.ts';

const digest=process.env.TELEGRAM_WEBHOOK_SECRET_SHA256??'';
if(!/^[a-f0-9]{64}$/.test(digest))
  throw new Error('TELEGRAM_WEBHOOK_SECRET_SHA256 is mandatory');
const expected=Buffer.from(digest,'hex');
// The existing high-entropy webhook credential is purpose-separated for invoice
// payload HMAC. A dedicated STARS_PAYLOAD_SECRET overrides it when configured.
const starsSecret=process.env.STARS_PAYLOAD_SECRET||
  createHmac('sha256',expected).update('mnebyvpn:stars:invoice:v1').digest('hex');
if(starsSecret.length<32)throw new Error('STARS_PAYLOAD_SECRET too short');
const port=Number(process.env.BOT_PORT??'8793');
if(!Number.isSafeInteger(port)||port<1||port>65535)
  throw new Error('Invalid BOT_PORT');
if(process.env.MNEBYVPN_ENV!=='production'||process.env.BOT_PUBLIC_INFO_ONLY!=='no')
  throw new Error('Telegram cabinet requires explicit production mode');
const pool=process.env.DATABASE_URL ? new Pool({
  connectionString:process.env.DATABASE_URL,
  max:3,connectionTimeoutMillis:3000,idleTimeoutMillis:12000,
}) : null;
const store=pool?new PgBillingStore(pool):null;
const support=supportConfig();
const bridgeSecret=process.env.SUPPORT_BRIDGE_SECRET??'';
const supportAuthKey=/^[a-f0-9]{64}$/.test(bridgeSecret)
  ?bridgeSecret:(support?.botToken??'');
const supportWebsitePort=Number(process.env.SUPPORT_WEBSITE_PORT??'8792');
const supportWebsiteReady=Number.isSafeInteger(supportWebsitePort)&&
  supportWebsitePort>0&&supportWebsitePort<=65535;
const supportRate=supportLimiter(3,15*60_000);
const supportGlobalRate=supportLimiter(120,60_000);
const deliveredUpdates=new Set<number>();
const supportPrompt='✉️ MNEBYVPN — напишите вопрос в поддержку. Ответьте на это сообщение обычным текстом (10–1500 символов). Ответ оператора придёт сюда. Не отправляйте пароли и ссылки подписок.';
type Button={text:string;callback_data?:string;url?:string;copy_text?:{text:string}};
const homeButton:Button={text:'🏠 Главное',callback_data:'nav:home'};
const siteButton:Button={text:'🌍 Сайт (резервный)',url:'https://mnebyvpn.site'};
const label=(p:string)=>p==='vpn'?'🌐 VPN':p==='smart_dns'?'🧭 Smart DNS':'🔐 VPN + DNS';
const validId=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const msg=(text:string,keyboard:Button[][])=>{
  return {text,reply_markup:{inline_keyboard:keyboard}};
};
const main=(id:number)=>msg(
  '🌐 MNEBYVPN\n\nМы только начинаем. Наша цель — простое подключение, понятное управление и оперативная помощь без технической путаницы. Со временем хотим объединить больше возможностей в одном сервисе.\n\nСейчас развиваем VPN. Smart DNS — в разработке.\n\n🎁 Пробные 24 часа зависят от готовности выдачи VPN; отсчёт начинается после активации.\n\n💙 Поддержите проект: расскажите о нём друзьям. Выберите действие ниже.',
  [
    [{text:'🌐 VPN и тарифы',callback_data:'nav:vpn'}],
    [{text:'🎁 Бесплатные 24 часа',callback_data:'nav:trial'}],
    [{text:'🔐 Мои подключения',callback_data:'nav:status'},
     {text:'🔌 Подключить',callback_data:'nav:connect'}],
    [{text:'🔁 Продление',callback_data:'nav:renew'},
     {text:'💙 Поддержать проект',callback_data:'nav:share'}],
    [{text:'🧭 Smart DNS — в разработке',callback_data:'nav:dns'}],
    [{text:'❔ Помощь',callback_data:'nav:help'}],
    [{text:support?.operatorId===id?'📥 Входящие заявки':'✉️ Поддержка',
      callback_data:support?.operatorId===id?'support:page:0':'nav:support'}],
    [siteButton],
  ]);
const dbUnavailable=()=>msg('⚠️ Система подписок временно недоступна. Данные не изменены. Попробуйте снова.',
  [[{text:'🔁 Повторить',callback_data:'nav:status'}],[homeButton]]);
function authenticated(req:IncomingMessage):boolean{
  const header=req.headers['x-telegram-bot-api-secret-token'];
  if(typeof header!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(header))return false;
  const actual=createHash('sha256').update(header,'utf8').digest();
  return timingSafeEqual(actual,expected);
}
async function readUpdate(req:IncomingMessage):Promise<any>{
  const chunks:Buffer[]=[];
  let bytes=0;
  for await(const data of req){
    const b=Buffer.isBuffer(data)?data:Buffer.from(data);
    bytes+=b.length;
    if(bytes>65536)throw new Error('Oversize update');
    chunks.push(b);
  }
  const raw:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||
    !Number.isSafeInteger((raw as any).update_id)||
    (raw as any).update_id<0)
    throw new Error('Invalid Telegram update');
  return raw;
}
function respond(res:ServerResponse,status:number,payload:unknown){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.writeHead(status);
  res.end(payload===null?'':JSON.stringify(payload));
}
function privateActor(update:any):{id:number;messageId?:number;callbackId?:string;data?:string;text?:string;currentText?:string;replyToSupport?:boolean}|null{
  const cb=update.callback_query;
  if(cb){
    if(!validId(cb.from?.id)||!cb.message||cb.message.chat?.type!=='private'||
      cb.message.chat.id!==cb.from.id||typeof cb.id!=='string'||!cb.id||
      typeof cb.data!=='string'||Buffer.byteLength(cb.data,'utf8')>64)return null;
    return {id:cb.from.id,messageId:cb.message.message_id,
      callbackId:cb.id,data:cb.data,
      currentText:typeof cb.message.text==='string'?cb.message.text:undefined};
  }
  const m=update.message;
  if(!m||!validId(m.from?.id)||m.chat?.type!=='private'||
    m.chat.id!==m.from.id)return null;
  const replied=m.reply_to_message;
  const replyToSupport=replied?.from?.is_bot===true &&
    typeof replied.text==='string'&&replied.text.startsWith('✉️ MNEBYVPN — напишите вопрос');
  return {id:m.from.id,text:typeof m.text==='string'?m.text:'',replyToSupport};
}
async function packages(id:number){
  if(!store)throw new Error('DB unavailable');
  const rows=await store.listUserPackages(id);
  if(!rows.length)return msg('🔐 Мои подключения\n\nПодписок пока нет. Начните с бесплатных 24 часов VPN.',
    [[{text:'🎁 Бесплатные 24 часа',callback_data:'trial:vpn'}],
     [{text:'🌐 Выбрать VPN',callback_data:'nav:vpn'}],[homeButton]]);
  const items=rows.map((row,index)=>{
    const expiresAt=row.expiresAt instanceof Date?row.expiresAt:null;
    const effective=effectiveAccessState(row.state,expiresAt);
    const state=effective==='ACTIVE'?'Активен':
      effective==='PAID_PENDING_PROVISIONING'?'Ожидает выдачи доступа':
      effective==='PROVISIONING_FAILED'?'Ошибка подключения, повторяем выдачу':
      effective==='EXPIRED'?'Истёк':effective==='SUSPENDED'?'Приостановлен':
      effective==='REFUNDED'?'Отозван':'Статус: '+effective;
    const expiry=expiresAt?' · '+(effective==='EXPIRED'?'Истёк ':'До ')+
      expiresAt.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'';
    const remaining=effective==='EXPIRED'?null:formatRemainingTime(expiresAt);
    const quota=formatRemainingQuota(row.quotaLimitBytes,row.quotaUsedBytes);
    return (index+1)+'. '+label(row.product)+' — '+state+expiry+
      (remaining?' · '+remaining:'')+(quota?'\n'+quota:'');
  });
  return msg('🔐 Мои подключения\n\n'+items.join('\n\n')+
    '\n\nСрок пробного VPN не расходуется, пока узел не подтвердит выдачу.',
    [[{text:'🔁 Обновить',callback_data:'nav:status'},
      {text:'🔌 Подключить VPN',callback_data:'nav:connect'}],
     [{text:'🌐 Тарифы VPN',callback_data:'nav:vpn'}],[homeButton]]);
}
async function vpnPlans(){
  if(!pool)throw new Error('DB unavailable');
  const {rows}=await pool.query(
    `SELECT product,title,duration_seconds,rub_minor,stars,enabled
       FROM billing_plans WHERE product='vpn' AND enabled=true
       UNION ALL
       SELECT p.product,p.title,p.duration_seconds,p.rub_minor,p.stars,false AS enabled
       FROM pricing_drafts p
       WHERE p.product='vpn' AND NOT EXISTS(
         SELECT 1 FROM billing_plans b WHERE b.enabled=true
           AND b.product=p.product AND b.duration_seconds=p.duration_seconds)
       ORDER BY duration_seconds LIMIT 16`);
  const list=rows.map(x=>formatDuration(Number(x.duration_seconds))+' — '+
    (x.rub_minor!==null?formatRoubles(Number(x.rub_minor)):'цена уточняется')+
    (x.stars!==null?' / '+Number(x.stars)+' ⭐':''));
  // Only published server-side prices can initiate a purchase. Draft prices
  // remain informational and never create a payment order.
  if(!store)throw new Error('DB unavailable');
  const stars=await store.plans('telegram_stars');
  const rub=await store.plans('prodamus');
  const options:Button[][]=[];
  for(const p of stars.filter(p=>p.product==='vpn'&&p.stars!==null)){
    if(p.planId.length>53)continue; // Telegram callback_data <= 64 bytes
    const days=p.durationSeconds/86400;
    const pair:Button[]=[{text:'⭐ '+formatDuration(p.durationSeconds)+' · '+p.stars+' Stars',
      callback_data:'buy:stars:'+p.planId}];
    // Independent website checkout. The bot never processes RUB transactions.
    if([15,30,60,90].includes(days)&&rub.some(r=>r.product==='vpn'&&r.durationSeconds===p.durationSeconds))
      pair.push({text:'💳 Prodamus (сайт)',url:'https://mnebyvpn.site/?product=vpn&days='+days});
    options.push(pair);
  }
  for(const p of rub.filter(p=>p.product==='vpn'&&
    !stars.some(q=>q.product==='vpn'&&q.durationSeconds===p.durationSeconds))){
    const days=p.durationSeconds/86400;
    if([15,30,60,90].includes(days))
      options.push([{text:'💳 '+formatDuration(p.durationSeconds)+' · Prodamus (сайт)',
        url:'https://mnebyvpn.site/?product=vpn&days='+days}]);
  }
  return msg('🌐 VPN\n\n'+(list.length?list.join('\n'):'Тарифы готовятся к публикации.')+
    '\n\n⭐ Stars — оплата внутри Telegram. 💳 Prodamus — на независимом сайте.'+
    '\nПробные 24 часа — без оплаты.',
    [...options,[{text:'🎁 Получить 24 часа бесплатно',callback_data:'trial:vpn'}],
     [{text:'🔐 Мои подключения',callback_data:'nav:status'}],[homeButton]]);
}
async function issueStars(id:number,planId:string,updateId:number){
  if(!store)throw new Error('DB unavailable');
  const plan=await store.plan(planId);
  if(!plan||plan.product!=='vpn'||plan.stars===null)
    throw new Error('PLAN_NOT_OFFERED');
  const order=await store.createTelegramOrder(id,planId,'cabinet-stars:'+updateId);
  const invoice=buildStarsInvoice(starsOrderFromDB(order),
    pricedPlanForOrder(order),starsSecret);
  // Telegram may redeliver a callback when its first response was lost.
  // Reserve exactly once before exposing sendInvoice through the webhook reply.
  // This transport offers no reliable acknowledgement of execution, so record
  // the attempt as UNKNOWN rather than falsely claiming a sent invoice.
  const reserved=await store.reserveStarsInvoice(order.id,id);
  if(!reserved)return {method:'sendMessage',chat_id:id,
    text:'Этот счёт уже запрашивался. Если он не появился, выберите тариф ещё раз.'};
  await store.finishStarsInvoice(order.id,'UNKNOWN');
  return {method:'sendInvoice',...invoice};
}
async function receiveStars(update:any){
  const pc=update.pre_checkout_query;
  // Even during a DB outage Telegram must receive a timely decline (<=10s).
  if(pc&&!store)return {method:'answerPreCheckoutQuery',
    pre_checkout_query_id:pc.id,ok:false,
    error_message:'Оплата временно недоступна. Попробуйте позднее.'};
  if(!store)throw new Error('DB unavailable');
  if(pc){
    // Telegram cancels charges when pre-checkout is not answered within 10s.
    // Never approve when PostgreSQL is slow or throws; respond fail-closed.
    const declined={method:'answerPreCheckoutQuery',pre_checkout_query_id:pc.id,
      ok:false,error_message:'Не удалось проверить заказ. Попробуйте позднее.'};
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const checked=await Promise.race([
        (async()=>{
          const oid=typeof pc.invoice_payload==='string'
            ?parseStarsPayload(pc.invoice_payload,starsSecret):null;
          const order=oid?await store.order(oid):null;
          return validateStarsPreCheckout(pc,
            order?.provider==='telegram_stars'?starsOrderFromDB(order):null,starsSecret);
        })(),
        new Promise<{ok:false;error_message:string}>(resolve=>{
          timer=setTimeout(()=>resolve({ok:false,error_message:declined.error_message}),3000);
        }),
      ]);
      return {method:'answerPreCheckoutQuery',pre_checkout_query_id:pc.id,
        ok:checked.ok,...(checked.ok?{}:{error_message:checked.error_message})};
    }catch{
      return declined;
    }finally{
      if(timer)clearTimeout(timer);
    }
  }
  const m=update.message;
  // Refund service messages may omit from. The signed webhook, private chat,
  // original order and charge bind refunds to their owner. Captures still need from.
  if(m?.chat?.type!=='private'||!validId(m.chat.id))
    throw new Error('Untrusted Telegram payment chat');
  if(m.successful_payment){
    if(!validId(m.from?.id)||m.chat.id!==m.from.id)
      throw new Error('Untrusted Telegram payment actor');
    const payment=m.successful_payment;
    const oid=parseStarsPayload(payment.invoice_payload,starsSecret);
    const record=oid?await store.order(oid):null;
    const checked=validateStarsSuccess(payment,m.from.id,
      record?.provider==='telegram_stars'?starsOrderFromDB(record):null,starsSecret);
    if(!checked.ok)throw new Error('Unverified Stars charge: '+checked.reason);
    const status=await store.settleVerified({
      provider:'telegram_stars',orderId:checked.capture.orderId,
      providerTransactionId:checked.capture.providerTransactionId,
      providerEventId:checked.capture.providerEventId,
      amount:checked.capture.amount,currency:'XTR',
      payloadHash:starsPaymentHash(payment),
    });
    if(status==='APPLIED')
      return {method:'sendMessage',chat_id:m.from.id,
        text:'✅ Оплата Stars подтверждена. Заказ записан, проверяем выдачу VPN. Статус — в «Мои подключения».',
        reply_markup:{inline_keyboard:[[{text:'🔐 Мои подключения',callback_data:'nav:status'}]]}};
    if(status==='DUPLICATE_EVENT'||status==='DUPLICATE_CAPTURE')return null;
    throw new Error('Stars settlement rejected: '+status);
  }
  if(m.refunded_payment){
    const refund=m.refunded_payment;
    const oid=parseStarsPayload(refund.invoice_payload,starsSecret);
    const record=oid?await store.order(oid):null;
    if(!record||record.provider!=='telegram_stars'||record.currency!=='XTR'||
       record.telegramUserId!==m.chat.id||refund.currency!=='XTR'||
       refund.total_amount!==record.amount||
       typeof refund.telegram_payment_charge_id!=='string'||
       !refund.telegram_payment_charge_id||
       refund.telegram_payment_charge_id.length>160)
      throw new Error('Unverified Stars refund');
    const status=await store.applyVerifiedRefund({
      provider:'telegram_stars',orderId:record.id,
      transactionId:refund.telegram_payment_charge_id,
      refundEventId:'refund:'+refund.telegram_payment_charge_id,
      payloadHash:starsPaymentHash(refund),
      amount:record.amount,currency:'XTR',
    });
    if(status==='APPLIED')
      return {method:'sendMessage',chat_id:m.chat.id,
        text:'↩️ Возврат Stars зарегистрирован. Доступ пересчитывается. Проверьте «Мои подключения».'};
    return null;
  }
  return null;
}
async function trial(id:number){
  if(!store)throw new Error('DB unavailable');
  const r=await store.grantTrial(id,'vpn');
  if(pool&&r.status==='ALREADY_USED'){
    const ready=await activationView(pool,id,true);
    if(ready)return ready;
  }
  const text=r.status==='GRANTED'
    ? '🎁 Пробные 24 часа VPN\n\nЗаявка принята. Сервер готовит VPN-профиль. Как только подключение будет активировано, бот сам пришлёт сообщение с выбором устройства.\n\nНичего проверять не нужно. 24 часа начнутся после активации.'
    :r.status==='PENDING'
    ? '⏳ Бесплатный VPN подключается. Бот автоматически пришлёт инструкцию, когда сервер подтвердит активацию. Проверять вручную не нужно.'
    :r.status==='ALREADY_USED'
    ? '🎁 Пробные 24 часа уже использованы этим Telegram-аккаунтом.'
    : '🎁 Бесплатный VPN сейчас недоступен. Попробуйте позднее.';
  return msg(text,[[{text:'🔐 Мои подключения',callback_data:'nav:status'}],
    [{text:'🌐 Тарифы VPN',callback_data:'nav:vpn'}],[homeButton]]);
}
function info(data:string,id:number){
  if(data==='nav:dns'||data==='info:dns')
    return msg('🧭 Smart DNS\n\nВ разработке. Планируется отдельная квота трафика, которую можно использовать на нескольких устройствах.\n\nПока доступен раздел VPN.',
      [[{text:'🌐 VPN',callback_data:'nav:vpn'}],[homeButton]]);
  if(data==='nav:share')
    return msg('💙 Поддержать проект\n\nМы только в начале пути. Если вам нравится идея простого VPN, поделитесь ссылкой на бота. Это помогает развитию проекта и не требует оплаты.',
      [[{text:'📤 Поделиться',url:'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FMNEBYVPN_bot'}],
       [homeButton]]);
  if(data==='nav:help'||data==='info:help')
    return msg('❔ Помощь\n\n1. Выберите VPN.\n2. Нажмите «24 часа бесплатно» или просмотрите тарифы.\n3. После выдачи пробного VPN бот сам пришлёт инструкцию. В «Мои подключения» смотрите остаток срока.\n\nИнтернет при ограничениях мобильной сети и совместный тариф находятся в разработке.',
      [[support?.operatorId===id
         ?{text:'📥 Входящие заявки',callback_data:'support:page:0'}
         :{text:'✉️ Написать оператору',callback_data:'nav:support'}],
       [{text:'🎁 Пробные сутки',callback_data:'trial:vpn'}],[homeButton]]);
  return main(id);
}
async function render(id:number,data:string):Promise<ReturnType<typeof msg>>{
  if(data==='nav:home'||data==='home')return main(id);
  if(data==='nav:vpn'||data==='info:vpn'||data==='nav:plans:vpn'||
    data==='nav:catalog'||data==='nav:plans')return vpnPlans();
  if(data==='nav:status'||data==='nav:renew'||data==='nav:manage')return packages(id);
  if(data==='nav:trial'||data==='trial:vpn')return trial(id);
  if(data==='nav:connect')return pool?await activationView(pool,id)??dbUnavailable():dbUnavailable();
  if(data==='nav:manual')return pool?manualView(pool,id):dbUnavailable();
  if(data.startsWith('nav:device:'))
    return pool?deviceView(pool,id,data.slice('nav:device:'.length)):dbUnavailable();
  return info(data,id);
}
function oneAction(actor:{id:number;messageId?:number;callbackId?:string;currentText?:string},view:ReturnType<typeof msg>){
  if(actor.callbackId&&actor.currentText===view.text)
    return {method:'answerCallbackQuery',callback_query_id:actor.callbackId,
      text:'Список без изменений.',show_alert:false};
  if(actor.callbackId&&validId(actor.messageId))
    return {method:'editMessageText',chat_id:actor.id,message_id:actor.messageId,...view};
  if(actor.callbackId)return {method:'answerCallbackQuery',callback_query_id:actor.callbackId,
    text:'Нажмите «Главное» в меню бота.',show_alert:true};
  return {method:'sendMessage',chat_id:actor.id,...view};
}
function supportPromptResponse(id:number){
  return {method:'sendMessage',chat_id:id,text:supportPrompt,
    reply_markup:{force_reply:true,input_field_placeholder:'Напишите ваш вопрос…'}};
}
function operatorReplyPrompt(id:number,target:'bot'|'site',address:string){
  const content=target==='bot'
    ?'✉️ MNEBYVPN — обращение из бота\nID Telegram: '+address
    :'✉️ MNEBYVPN — обращение с сайта\nЗаявка: '+address;
  return {method:'sendMessage',chat_id:id,
    text:content+'\n\n✍️ Напишите ответ клиенту. Он будет отправлен после вашего сообщения.',
    reply_markup:{force_reply:true,input_field_placeholder:'Ваш ответ клиенту…'}};
}
async function handleOperatorReply(update:any){
  const m=update.message;
  if(!support||!m||m.chat?.type!=='private'||
     m.chat?.id!==support.operatorId||m.from?.id!==support.operatorId)return null;
  const parsed=operatorReplyTarget(m,support.operatorId);
  if(!parsed){
    // Website visitors did not necessarily open the Telegram bot. A Telegram
    // private message cannot be sent to an unknown email or @username.
    const quoted=m.reply_to_message?.from?.is_bot===true
      ?m.reply_to_message?.text:'';
    const siteTicket=operatorWebsiteReply(m,support.operatorId);
    if(siteTicket){
      const {ticketId,answer}=siteTicket;
      if(!supportAuthKey||!supportWebsiteReady)return {method:'sendMessage',
        chat_id:support.operatorId,
        text:'⚠️ Внутренний канал поддержки ещё не настроен.'};
      const signature=createHmac('sha256',supportAuthKey)
        .update('MNEBYVPN-support\n'+ticketId+'\n'+answer).digest('hex');
      try{
        const response=await fetch(
          'http://127.0.0.1:'+supportWebsitePort+'/api/support/operator-reply',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
          headers:{'Content-Type':'application/json',
            'X-MNEBYVPN-Support-Signature':signature},
          body:JSON.stringify({ticketId,message:answer}),
        });
        if(response.ok)return {method:'sendMessage',chat_id:support.operatorId,
          text:'✅ Ответ сохранён. Посетитель увидит его на сайте.',
          reply_markup:{inline_keyboard:[
            [{text:'📥 К остальным заявкам',callback_data:'support:page:0'}],
            [homeButton]]}};
        if(response.status===409)return {method:'sendMessage',chat_id:support.operatorId,
          text:'⚠️ На это обращение уже ответили или оно закрыто.'};
      }catch{/* Fail closed; do not report a successful reply. */}
      return {method:'sendMessage',chat_id:support.operatorId,
        text:'⚠️ Сайт не подтвердил сохранение ответа. Проверьте заявку.'};
    }
    if(typeof quoted==='string'&&quoted.startsWith('✉️ MNEBYVPN — обращение с сайта')){
      return {method:'sendMessage',chat_id:support.operatorId,
        text:'Для ответа на обращение сайта нажмите «Ответить» и отправьте текст до 1500 символов.'};
    }
    if(typeof quoted==='string'&&
       quoted.startsWith('✉️ MNEBYVPN — обращение из бота')){
      return {method:'sendMessage',chat_id:support.operatorId,
        text:'Напишите ответ обычным текстом до 1500 символов, используя «Ответить» на уведомление клиента.'};
    }
    return null; // /start, /my, /help etc work for the operator too.
  }
  if(!support.botToken){
    // Telegram executes this sendMessage as the webhook response, using the
    // SAME existing bot: no runtime Bot API token or new bot is necessary.
    return {method:'sendMessage',chat_id:parsed.userId,
      text:'✉️ Поддержка MNEBYVPN\n\n'+parsed.answer,
      reply_markup:{inline_keyboard:[[{text:'✉️ Написать ещё',callback_data:'nav:support'}],
        [homeButton]]}};
  }
  try{
    await telegramSupportSend(support,
      '✉️ Поддержка MNEBYVPN\n\n'+parsed.answer,parsed.userId,
      {inline_keyboard:[[{text:'✉️ Написать ещё',callback_data:'nav:support'}],
        [{text:'🏠 Главное',callback_data:'nav:home'}]]});
    return {method:'sendMessage',chat_id:support.operatorId,
      text:'✅ Ответ отправлен клиенту через MNEBYVPN.'};
  }catch{
    return {method:'sendMessage',chat_id:support.operatorId,
      text:'⚠️ Не удалось подтвердить доставку ответа. Проверьте соединение и повторите попытку.'};
  }
}
async function sendSupportFromBot(id:number,updateId:number,message:string){
  const user={id};
  if(!validSupportText(message)){
    return oneAction(user,msg('Напишите вопрос длиной от 10 до 1500 символов. Не отправляйте ключи или пароли.',
      [[{text:'✉️ Повторить',callback_data:'nav:support'}],[homeButton]]));
  }
  if(!support)return oneAction(user,msg('⚠️ Канал поддержки ещё настраивается. Сообщение не отправлено.',
    [[{text:'🌍 Форма на сайте',url:'https://mnebyvpn.site/#contact-support'}],[homeButton]]));
  if(support.botToken&&deliveredUpdates.has(updateId))return oneAction(user,msg('✅ Обращение уже передано оператору.',
    [[{text:'🏠 Главное',callback_data:'nav:home'}]]));
  // Telegram may retry the same update after a lost webhook acknowledgement.
  // Count a retried update only once against support spam limits.
  if(!deliveredUpdates.has(updateId)&&
     (!supportRate(String(id))||!supportGlobalRate('bot-global')))
    return oneAction(user,msg('Слишком много обращений. Попробуйте позже.',
      [[{text:'🏠 Главное',callback_data:'nav:home'}]]));
  if(!support.botToken){
    // Only one Bot API method may be returned in a webhook response.
    // Do not claim confirmed delivery to the sender: the provider performs
    // this operation after accepting our HTTP response.
    // A webhook JSON response has no delivery receipt. On a Telegram retry,
    // return the operator notification again rather than falsely claiming delivery.
    deliveredUpdates.add(updateId);
    if(deliveredUpdates.size>1000)deliveredUpdates.clear();
    return {method:'sendMessage',chat_id:support.operatorId,
      text:'✉️ MNEBYVPN — обращение из бота\nID Telegram: '+id+
        '\n\nВопрос:\n'+message.trim(),
      link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[
        [{text:'✍️ Ответить клиенту',callback_data:'support:reply:bot:'+id}],
        [{text:'📥 Входящие с сайта',callback_data:'support:page:0'}],
      ]}};
  }
  try{
    await telegramSupportSend(support,'✉️ MNEBYVPN — обращение из бота\nID Telegram: '+id+
      '\n\nВопрос:\n'+message.trim(),support.operatorId,
      {inline_keyboard:[
        [{text:'✍️ Ответить клиенту',callback_data:'support:reply:bot:'+id}],
        [{text:'📥 Входящие с сайта',callback_data:'support:page:0'}],
      ]});
    deliveredUpdates.add(updateId);
    if(deliveredUpdates.size>1000)deliveredUpdates.clear();
    return oneAction(user,msg('✅ Обращение отправлено оператору в этот же бот. Ответ придёт сюда, в Telegram.',
      [[{text:'🏠 Главное',callback_data:'nav:home'}]]));
  }catch{
    return oneAction(user,msg('⚠️ Не удалось подтвердить отправку обращения. Попробуйте позже.',
      [[{text:'✉️ Повторить',callback_data:'nav:support'}],[homeButton]]));
  }
}
async function operatorSupportInbox(
  actor:{id:number;messageId?:number;callbackId?:string;currentText?:string},offset:number,
){
  const back:Button[][]=[[{text:'🔄 Обновить',callback_data:'support:page:0'}],
    [homeButton]];
  if(!supportAuthKey||!supportWebsiteReady)
    return oneAction(actor,msg('⚠️ Внутренний канал обращений сайта ещё не настроен.',back));
  if(!Number.isSafeInteger(offset)||offset<0||offset>199)
    return oneAction(actor,msg('⚠️ Неверная страница заявок.',back));
  const stamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',supportAuthKey)
    .update(offset===0?'MNEBYVPN-inbox-v1\n'+stamp:
      'MNEBYVPN-inbox-v2\n'+stamp+'\n'+offset).digest('hex');
  try{
    const response=await fetch(
      'http://127.0.0.1:'+supportWebsitePort+
        '/api/support/operator-inbox?offset='+offset,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{'X-MNEBYVPN-Support-Ts':stamp,
        'X-MNEBYVPN-Support-Signature':signature},
    });
    if(!response.ok)throw Error('Website inbox unavailable');
    const result=await response.json() as {ticket?:{
      id:string;contact:string;question:string}|null;hasNext?:boolean};
    const ticket=result.ticket;
    if(!ticket){
      const buttons:Button[][]=[];
      if(offset>0)buttons.push([{text:'⬅️ Предыдущая',callback_data:'support:page:'+(offset-1)}]);
      buttons.push([{text:'🔄 Обновить',callback_data:'support:page:0'}],[homeButton]);
      return oneAction(actor,msg('📥 Обращения с сайта\n\nНовых заявок на этой странице нет.',buttons));
    }
    const buttons:Button[][]=[
      [{text:'✍️ Ответить',callback_data:'support:reply:site:'+ticket.id}],
    ];
    const pageButtons:Button[]=[];
    if(offset>0)pageButtons.push({text:'⬅️ Назад',callback_data:'support:page:'+(offset-1)});
    if(result.hasNext&&offset<199)
      pageButtons.push({text:'➡️ Далее',callback_data:'support:page:'+(offset+1)});
    if(pageButtons.length)buttons.push(pageButtons);
    buttons.push([{text:'🔄 Обновить',callback_data:'support:page:0'}],[homeButton]);
    return oneAction(actor,msg(
      '✉️ MNEBYVPN — обращение с сайта\nЗаявка: '+ticket.id+
      '\nКонтакт: '+ticket.contact+
      '\n\nСообщение:\n'+ticket.question+
      '\n\n📥 Входящие · заявка '+(offset+1)+
      '\nНажмите «Ответить», чтобы написать клиенту.',buttons));
  }catch{
    return oneAction(actor,msg(
      '⚠️ Не удалось загрузить обращения с сайта. Попробуйте ещё раз.',back));
  }
}
async function processUpdate(update:any){
  if(update.message?.successful_payment||update.message?.refunded_payment||
     update.pre_checkout_query?.id)return receiveStars(update);
  if(update.widget_query?.id)return {
    method:'answerWidgetQuery',widget_query_id:update.widget_query.id,data:'UNAVAILABLE',
  };
  const adminReply=await handleOperatorReply(update);
  if(adminReply)return adminReply;
  const actor=privateActor(update);
  if(!actor)return null;
  const text=actor.text?.trim()??'';
  const operator=support&&actor.id===support.operatorId;
  if(operator){
    const page=/^support:page:(0|[1-9][0-9]{0,2})$/.exec(actor.data??'');
    if(page)return operatorSupportInbox(actor,Number(page[1]));
    // Older inbox cards are upgraded to the new button-based page.
    if(actor.data==='support:next')return operatorSupportInbox(actor,0);
    if(actor.data?.startsWith('support:reply:')){
      const customer=/^support:reply:bot:([1-9][0-9]{0,15})$/.exec(actor.data);
      if(customer&&Number.isSafeInteger(Number(customer[1]))&&
         Number(customer[1])!==actor.id)
        return operatorReplyPrompt(actor.id,'bot',customer[1]);
      const website=/^support:reply:site:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(actor.data);
      if(website)return operatorReplyPrompt(actor.id,'site',website[1]);
      return oneAction(actor,msg('⚠️ Некорректная заявка. Откройте входящие снова.',
        [[{text:'📥 Входящие',callback_data:'support:page:0'}],[homeButton]]));
    }
    if(actor.data==='nav:support'||actor.data==='support:inbox')
      return operatorSupportInbox(actor,0);
  }
  if(!actor.callbackId&&actor.replyToSupport)
    return sendSupportFromBot(actor.id,update.update_id,text);
  if(actor.data==='nav:support')
    return supportPromptResponse(actor.id);
  let action=actor.data??'nav:home';
  if(!actor.callbackId){
    if(text==='/trial'||text==='🆓 Пробный день')action='trial:vpn';
    else if(text==='/my'||text==='/status'||text==='🔐 Мои подписки')action='nav:status';
    else if(text==='/plans'||text==='🌐 Выбрать доступ')action='nav:vpn';
    else if(text==='/connect')action='nav:connect';
    else if(text==='/share')action='nav:share';
    else if(text==='/help')action='nav:help';
  }
  try {
    if(/^buy:stars:[a-z0-9][a-z0-9_-]{0,52}$/.test(action))
      return issueStars(actor.id,action.slice('buy:stars:'.length),update.update_id);
    return oneAction(actor,await render(actor.id,action));
  }
  catch{
    // Never acknowledge a trial that was not durably recorded.
    return oneAction(actor,dbUnavailable());
  }
}
const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){
    respond(res,200,{status:'ok',component:'telegram-primary-cabinet',databaseConfigured:!!pool});return;
  }
  if(req.method==='GET'&&req.url==='/readyz'){
    if(!pool){respond(res,503,{ready:false,reason:'DATABASE_NOT_CONFIGURED'});return;}
    try {await pool.query('SELECT 1');respond(res,200,{ready:true,component:'telegram-primary-cabinet'});}
    catch{respond(res,503,{ready:false,reason:'DATABASE_UNAVAILABLE'});}
    return;
  }
  if(req.method!=='POST'||req.url!=='/webhooks/telegram'){
    respond(res,404,{code:'NOT_FOUND'});return;
  }
  if(!authenticated(req)){respond(res,401,{code:'UNAUTHORIZED'});return;}
  if(!req.headers['content-type']?.toLowerCase().startsWith('application/json')){
    respond(res,415,{code:'UNSUPPORTED_MEDIA_TYPE'});return;
  }
  try {respond(res,200,await processUpdate(await readUpdate(req)));}
  catch {respond(res,503,{code:'RETRY_LATER'});}
});
server.listen(port,'127.0.0.1',()=>{
  console.info('Telegram primary cabinet listening at 127.0.0.1:'+port);
});
