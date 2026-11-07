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
import {activationView,awaitActivation,deviceView,manualView}
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
const main=()=>msg(
  '🌐 MNEBYVPN\n\nМы только начинаем. Наша цель — простое подключение, понятное управление и оперативная помощь без технической путаницы. Со временем хотим объединить больше возможностей в одном сервисе.\n\nСейчас развиваем VPN. Smart DNS — в разработке.\n\n🎁 Пробные 24 часа зависят от готовности выдачи VPN; отсчёт начинается после активации.\n\n💙 Поддержите проект: расскажите о нём друзьям. Выберите действие ниже.',
  [
    [{text:'🌐 VPN и тарифы',callback_data:'nav:vpn'}],
    [{text:'🎁 Бесплатные 24 часа',callback_data:'nav:trial'}],
    [{text:'🔐 Мои подключения',callback_data:'nav:status'},
     {text:'🔌 Подключить',callback_data:'nav:connect'}],
    [{text:'🔁 Продление',callback_data:'nav:renew'},
     {text:'💙 Поддержать проект',callback_data:'nav:share'}],
    [{text:'🧭 Smart DNS — в разработке',callback_data:'nav:dns'}],
    [{text:'❔ Помощь',callback_data:'nav:help'},
     {text:'✉️ Поддержка',callback_data:'nav:support'}],
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
function privateActor(update:any):{id:number;messageId?:number;callbackId?:string;data?:string;text?:string;replyToSupport?:boolean}|null{
  const cb=update.callback_query;
  if(cb){
    if(!validId(cb.from?.id)||!cb.message||cb.message.chat?.type!=='private'||
      cb.message.chat.id!==cb.from.id||typeof cb.id!=='string'||!cb.id||
      typeof cb.data!=='string'||Buffer.byteLength(cb.data,'utf8')>64)return null;
    return {id:cb.from.id,messageId:cb.message.message_id,
      callbackId:cb.id,data:cb.data};
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
  if(!validId(m?.from?.id)||m.chat?.type!=='private'||m.chat.id!==m.from.id)
    throw new Error('Untrusted Telegram payment actor');
  if(m.successful_payment){
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
       record.telegramUserId!==m.from.id||refund.currency!=='XTR'||
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
      return {method:'sendMessage',chat_id:m.from.id,
        text:'↩️ Возврат Stars зарегистрирован. Доступ пересчитывается. Проверьте «Мои подключения».'};
    return null;
  }
  return null;
}
async function trial(id:number){
  if(!store)throw new Error('DB unavailable');
  const r=await store.grantTrial(id,'vpn');
  if(pool&&(r.status==='GRANTED'||r.status==='PENDING'||r.status==='ALREADY_USED')){
    const ready=r.status==='ALREADY_USED'?await activationView(pool,id,true)
      :await awaitActivation(pool,id);
    if(ready)return ready;
  }
  const text=r.status==='GRANTED'
    ? '🎁 Пробные 24 часа VPN\n\nЗаявка записана. Выдача VPN-профиля поставлена в очередь. Время начнётся только после подтверждения активации на узле.'
    :r.status==='PENDING'
    ? '⏳ Пробная заявка уже есть. Проверяем выдачу доступа. 24 часа ещё не отсчитываются.'
    :r.status==='ALREADY_USED'
    ? '🎁 Пробные 24 часа уже использованы этим Telegram-аккаунтом.'
    : '🎁 Пробные 24 часа VPN пока не активированы в настройках сервера.';
  return msg(text,[[{text:'🔐 Проверить статус',callback_data:'nav:status'}],
    [{text:'🌐 Выбрать VPN',callback_data:'nav:vpn'}],[homeButton]]);
}
function info(data:string){
  if(data==='nav:dns'||data==='info:dns')
    return msg('🧭 Smart DNS\n\nВ разработке. Планируется отдельная квота трафика, которую можно использовать на нескольких устройствах.\n\nПока доступен раздел VPN.',
      [[{text:'🌐 VPN',callback_data:'nav:vpn'}],[homeButton]]);
  if(data==='nav:share')
    return msg('💙 Поддержать проект\n\nМы только в начале пути. Если вам нравится идея простого VPN, поделитесь ссылкой на бота. Это помогает развитию проекта и не требует оплаты.',
      [[{text:'📤 Поделиться',url:'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FMNEBYVPN_bot'}],
       [homeButton]]);
  if(data==='nav:help'||data==='info:help')
    return msg('❔ Помощь\n\n1. Выберите VPN.\n2. Нажмите «24 часа бесплатно» или просмотрите тарифы.\n3. В разделе «Мои подключения» проверяйте статус и остаток срока.\n\nИнтернет при ограничениях мобильной сети и совместный тариф находятся в разработке.',
      [[{text:'✉️ Написать оператору',callback_data:'nav:support'}],
       [{text:'🎁 Пробные сутки',callback_data:'trial:vpn'}],[homeButton]]);
  return main();
}
async function render(id:number,data:string):Promise<ReturnType<typeof msg>>{
  if(data==='nav:home'||data==='home')return main();
  if(data==='nav:vpn'||data==='info:vpn'||data==='nav:plans:vpn'||
    data==='nav:catalog'||data==='nav:plans')return vpnPlans();
  if(data==='nav:status'||data==='nav:renew'||data==='nav:manage')return packages(id);
  if(data==='nav:trial'||data==='trial:vpn')return trial(id);
  if(data==='nav:connect')return pool?await activationView(pool,id)??dbUnavailable():dbUnavailable();
  if(data==='nav:manual')return pool?manualView(pool,id):dbUnavailable();
  if(data.startsWith('nav:device:'))
    return pool?deviceView(pool,id,data.slice('nav:device:'.length)):dbUnavailable();
  return info(data);
}
function oneAction(actor:{id:number;messageId?:number;callbackId?:string},view:ReturnType<typeof msg>){
  if(actor.callbackId&&validId(actor.messageId))
    return {method:'editMessageText',chat_id:actor.id,message_id:actor.messageId,...view};
  if(actor.callbackId)return {method:'answerCallbackQuery',callback_query_id:actor.callbackId,
    text:'Откройте меню командой /start',show_alert:true};
  return {method:'sendMessage',chat_id:actor.id,...view};
}
function supportPromptResponse(id:number){
  return {method:'sendMessage',chat_id:id,text:supportPrompt,
    reply_markup:{force_reply:true,input_field_placeholder:'Напишите ваш вопрос…'}};
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
      if(!support.botToken){
        // Same webhook bot, tokenless mode: the operator's private reply
        // updates the same PostgreSQL ticket visible to its browser owner.
        if(!pool)return {method:'sendMessage',chat_id:support.operatorId,
          text:'⚠️ База обращений временно недоступна.'};
        try{
          const result=await pool.query(
            "UPDATE website_support_tickets SET answer=$2,answered_at=clock_timestamp() "+
            "WHERE id=$1 AND answer IS NULL AND delivery_state<>'FAILED' RETURNING id",
            [ticketId,answer]);
          return {method:'sendMessage',chat_id:support.operatorId,
            text:result.rowCount===1
              ?'✅ Ответ сохранён. Посетитель увидит его на сайте.'
              :'⚠️ Обращение не найдено или ответ уже сохранён.'};
        }catch{return {method:'sendMessage',chat_id:support.operatorId,
          text:'⚠️ Сохранение ответа не подтверждено. Попробуйте позже.'};}
      }
      const webPort=Number(process.env.SUPPORT_WEBSITE_PORT??'8792');
      if(!Number.isSafeInteger(webPort)||webPort<1||webPort>65535)
        return {method:'sendMessage',chat_id:support.operatorId,
          text:'Не настроен внутренний канал ответов на сайт.'};
      const payload=JSON.stringify({ticketId,message:answer});
      const signature=createHmac('sha256',support.botToken)
        .update('MNEBYVPN-support\n'+ticketId+'\n'+answer).digest('hex');
      // Try co-located website first; if site and bot are deployed on
      // different hosts, use the fixed public HTTPS origin with the same
      // HMAC authentication. Do not allow an arbitrary destination URL.
      const origins=['http://127.0.0.1:'+webPort,'https://mnebyvpn.site'];
      for(const origin of origins){
        try{
          const response=await fetch(origin+'/api/support/operator-reply',{
            method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
            headers:{'Content-Type':'application/json',
              'X-MNEBYVPN-Support-Signature':signature},
            body:payload,
          });
          if(response.ok){
            return {method:'sendMessage',chat_id:support.operatorId,
              text:'✅ Ответ сохранён в обращении. Посетитель увидит его на сайте.'};
          }
          if(response.status===409)break; // already answered or closed
        }catch{/* Next known origin, no fabricated success. */}
      }
      return {method:'sendMessage',chat_id:support.operatorId,
        text:'⚠️ Сайт не подтвердил сохранение ответа. Проверьте обращение, прежде чем повторять.'};
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
      text:'✉️ Поддержка MNEBYVPN\n\n'+parsed.answer};
  }
  try{
    await telegramSupportSend(support,
      '✉️ Поддержка MNEBYVPN\n\n'+parsed.answer,parsed.userId);
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
  if(deliveredUpdates.has(updateId))return oneAction(user,msg('✅ Обращение уже передано оператору.',
    [[{text:'🏠 Главное',callback_data:'nav:home'}]]));
  if(!supportRate(String(id))||!supportGlobalRate('bot-global'))
    return oneAction(user,msg('Слишком много обращений. Попробуйте позже.',
      [[{text:'🏠 Главное',callback_data:'nav:home'}]]));
  if(!support.botToken){
    // Only one Bot API method may be returned in a webhook response.
    // Do not claim confirmed delivery to the sender: the provider performs
    // this operation after accepting our HTTP response.
    deliveredUpdates.add(updateId);
    if(deliveredUpdates.size>1000)deliveredUpdates.clear();
    return {method:'sendMessage',chat_id:support.operatorId,
      text:'✉️ MNEBYVPN — обращение из бота\nID Telegram: '+id+
        '\n\nВопрос:\n'+message.trim(),
      link_preview_options:{is_disabled:true}};
  }
  try{
    await telegramSupportSend(support,'✉️ MNEBYVPN — обращение из бота\nID Telegram: '+id+
      '\n\nВопрос:\n'+message.trim());
    deliveredUpdates.add(updateId);
    if(deliveredUpdates.size>1000)deliveredUpdates.clear();
    return oneAction(user,msg('✅ Обращение отправлено оператору в этот же бот. Ответ придёт сюда, в Telegram.',
      [[{text:'🏠 Главное',callback_data:'nav:home'}]]));
  }catch{
    return oneAction(user,msg('⚠️ Не удалось подтвердить отправку обращения. Попробуйте позже.',
      [[{text:'✉️ Повторить',callback_data:'nav:support'}],[homeButton]]));
  }
}
async function operatorSupportInbox(id:number){
  if(!pool)return {method:'sendMessage',chat_id:id,
    text:'⚠️ База обращений с сайта временно недоступна.'};
  try{
    const {rows}=await pool.query(
      "SELECT id,contact,question FROM website_support_tickets "+
      "WHERE answer IS NULL AND delivery_state IN ('PENDING','DELIVERED') "+
      "ORDER BY created_at ASC LIMIT 1");
    if(!rows.length)return {method:'sendMessage',chat_id:id,
      text:'📥 Новых обращений с сайта пока нет.',
      reply_markup:{inline_keyboard:[[{text:'🔄 Проверить ещё',callback_data:'support:next'}]]}};
    const ticket=rows[0] as {id:string;contact:string;question:string};
    return {method:'sendMessage',chat_id:id,
      text:'✉️ MNEBYVPN — обращение с сайта\nЗаявка: '+ticket.id+
        '\nКонтакт: '+ticket.contact+'\n\nСообщение:\n'+ticket.question+
        '\n\nОтветьте на это сообщение. Ответ появится на сайте.',
      reply_markup:{inline_keyboard:[[{text:'📥 Следующее обращение',callback_data:'support:next'}]]}};
  }catch{return {method:'sendMessage',chat_id:id,
    text:'⚠️ Не удалось загрузить обращения. Попробуйте позже.'};}
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
  if(support&&actor.id===support.operatorId&&
     (actor.data==='nav:support'||actor.data==='support:next'||
      (!actor.callbackId&&/^\/(?:inbox|support)(?:@MnebyVPN_bot)?$/i.test(text))))
    return operatorSupportInbox(actor.id);
  const explicitSupport=/^\/support(?:@MnebyVPN_bot)?(?:\s+([\s\S]+))?$/i.exec(text);
  if(!actor.callbackId&&(explicitSupport?.[1]||actor.replyToSupport))
    return sendSupportFromBot(actor.id,update.update_id,
      explicitSupport?.[1]??text);
  if(actor.data==='nav:support'||(!actor.callbackId&&explicitSupport))
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
