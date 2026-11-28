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
import {operatorReplyTarget,operatorWebsiteReply,sendTelegramBotApi,supportConfig,supportLimiter,telegramSupportSendWithRetry,validSupportText}
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
import {vpnPurchaseWidgetPayload,vpnPurchaseWidgetData} from '../../../packages/telegram-ui/src/purchase-widget.ts';
import {planWidgetKey} from '../../../packages/telegram-ui/src/widget-104.ts';
import {makePersonalStarsLinkPayload,parsePersonalStarsLinkPayload} from '../../../packages/billing/src/stars-links.ts';
import {dnsAdminOwner,dnsAdminIntro,dnsAdminPrompt,dnsAdminSearchPrompt,dnsAdminSearch,dnsAdminAction,dnsAdminAdd,DNS_ADMIN_PROMPT,DNS_ADMIN_SEARCH_PROMPT}
  from './dns-admin.ts';
import {effectiveAccessState,formatRemainingTime,formatRemainingQuota} from '../../../packages/telegram-ui/src/access-format.ts';
import {personalDnsTelegramMenu,personalDnsTelegramAction,personalDnsGuide,
  personalDnsPreview} from './personal-dot-telegram-view.ts';
import {loadSharedTrialWsProxy,parseWsProxyRoutes,wsProxyReleaseReady} from '../../../packages/web/src/telegram-proxy-bonus.ts';
import {approvedPersonalDnsOffer} from '../../../packages/dns-policy/src/smart-dns-offers.ts';
import {sendPersonalDnsMobileconfig} from '../../../packages/dns-policy/src/personal-dot-profile.ts';
import {ownerDnsKey,ownerDnsLinksAction,ownerDnsExpiryPrompt,ownerDnsExpiryReply,OWNER_DNS_EXPIRY_PROMPT} from './owner-dns-links.ts';
import {OFFLINE_SALE_PROMPT,OFFLINE_PAIR_PROMPT,offlineSalePrompt,offlinePairPrompt,offlineSaleMenu,registerOfflineSale,registerOfflineSalePair,listOfflineSales,showOfflineSale} from './manual-sales.ts';

const digest=process.env.TELEGRAM_WEBHOOK_SECRET_SHA256??'';
if(!/^[a-f0-9]{64}$/.test(digest))
  throw new Error('TELEGRAM_WEBHOOK_SECRET_SHA256 is mandatory');
const expected=Buffer.from(digest,'hex');
// The existing high-entropy webhook credential is purpose-separated for invoice
// payload HMAC. A dedicated STARS_PAYLOAD_SECRET overrides it when configured.
const starsSecret=process.env.STARS_PAYLOAD_SECRET||
  createHmac('sha256',expected).update('mnebyvpn:stars:invoice:v1').digest('hex');
// Outbound Bot API credential lets one widget tap create an invoice and return
// answerWidgetQuery. Without it we explicitly report unavailable checkout;
// we never create a second set of tariff buttons.
const outboundBotToken=/^[0-9]{5,20}:[A-Za-z0-9_-]{25,}$/.test(process.env.TELEGRAM_TOKEN_BOT??'')
  ?process.env.TELEGRAM_TOKEN_BOT!:null;
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
// One release switch: enable only after external strict DoT/853 verification.
// Authorization and paid entitlement validation remain mandatory separately.
const personalDnsReady=process.env.MNEBYDNS_PERSONAL_DOT_ENABLED==='yes';
const regionalDnsReady=process.env.MNEBYDNS_REGIONAL_DOT_ENABLED==='yes';
const support=supportConfig();
const dnsAdminId=dnsAdminOwner();
const ownerLinkKey=ownerDnsKey(process.env.MNEBYDNS_OWNER_LINK_KEY);
const offlineSalesEnabled=process.env.MNEBYVPN_OFFLINE_SALES_ENABLED==='yes';
// Owner-only manual-sale DoT issuance is independent of the PUBLIC DNS catalog.
// Activate only after private gateway, wildcard TLS, worker and SQL audit.
const offlineDnsIssueEnabled=offlineSalesEnabled&&
  process.env.MNEBYVPN_OFFLINE_DNS_ISSUE_ENABLED==='yes';
const bridgeSecret=process.env.SUPPORT_BRIDGE_SECRET??'';
const supportAuthKey=/^[a-f0-9]{64}$/.test(bridgeSecret)
  ?bridgeSecret:(support?.botToken??'');
const supportWebsitePort=Number(process.env.SUPPORT_WEBSITE_PORT??'8792');
const supportWebsiteReady=Number.isSafeInteger(supportWebsitePort)&&
  supportWebsitePort>0&&supportWebsitePort<=65535;
const supportRate=supportLimiter(3,15*60_000);
const supportGlobalRate=supportLimiter(120,60_000);
const deliveredUpdates=new Set<number>();
const TRIAL_INVITE_PROMPT='Восстановление пробного VPN — ответьте email клиента, который уже подтвердил почту и сообщил о сбое выдачи. Будет отправлено одно приглашение без создания подписки.';
const supportPrompt='✉️ MNEBYVPN — напишите вопрос в поддержку. Ответьте на это сообщение обычным текстом (10–1500 символов). Ответ оператора придёт сюда. Не отправляйте пароли и ссылки подписок.';
type Button={text:string;callback_data?:string;url?:string;copy_text?:{text:string}};
const homeButton:Button={text:'🏠 Главное',callback_data:'nav:home'};
const siteButton:Button={text:'🌍 Сайт (резервный)',url:'https://mnebyvpn.site'};
const label=(p:string)=>p==='vpn'?'🌐 VPN':p==='smart_dns'?'🧭 Smart Доступ':'✨ Экосистема «3 в 1»';
const validId=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const msg=(text:string,keyboard:Button[][])=>{
  return {text,reply_markup:{inline_keyboard:keyboard}};
};
const main=(id:number,bundleTrial=false)=>msg(
  '🌐 MNEBYVPN\n\nМы строим понятный сервис «3 в 1» без технической путаницы: Smart DNS (YouTube, ChatGPT, Claude, Gemini), Telegram-прокси и VPN.\n\nВыберите тариф ниже — оплата доступна через ⭐ Telegram Stars или 💳 ЮKassa (карта, СБП).\n\n'+(bundleTrial?'🎁 «3 в 1» бесплатно: VPN и Smart DNS на 24 часа для одного устройства (одно одновременное VPN-подключение), общий Telegram-прокси без ограничения срока.':'🎁 Пробный доступ — 24 часа без оплаты; отсчёт начинается после подтверждения готовности.')+'\n\n💙 Поддержите проект: расскажите о нём друзьям.',
  [
    [{text:'✨ Экосистема «3 в 1»',callback_data:'nav:bundle'}],
    [{text:'🌐 VPN Лайт',callback_data:'nav:vpn'},
     {text:'🧭 Smart Доступ',callback_data:'nav:dns'}],
    [{text:bundleTrial?'🎁 «3 в 1» бесплатно':'🎁 Бесплатные 24 часа',callback_data:'nav:trial'}],
    [{text:'🔐 Мои подключения',callback_data:'nav:status'},
     {text:'🔌 Подключить',callback_data:'nav:connect'}],
    [{text:'🔁 Продление',callback_data:'nav:renew'},
     {text:'💙 Поддержать проект',callback_data:'nav:share'}],
    [{text:'❔ Помощь',callback_data:'nav:help'}],
    ...(id===dnsAdminId ? [[{text:'🛠 Управление Smart DNS',callback_data:'dnsadmin:menu'}]] : []),
     ...(offlineSalesEnabled&&id===dnsAdminId ? [[{text:'💼 Личные продажи',callback_data:'offsale:menu'}]] : []),
    [{text:support?.operatorId===id?'📥 Входящие заявки':'✉️ Поддержка',
      callback_data:support?.operatorId===id?'support:page:0':'nav:support'}],
    ...(support?.operatorId===id ? [[{text:'✉️ Восстановить пробный VPN',callback_data:'support:trial-invite'}]] : []),
    [siteButton],
  ]);
async function homeView(id:number){
  const offers=store?await store.trialProducts().catch(()=>[]):[];
  return main(id,offers.includes('bundle'));
}
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
function privateActor(update:any):{id:number;messageId?:number;callbackId?:string;data?:string;text?:string;currentText?:string;replyToSupport?:boolean;replyToDns?:boolean;replyToDnsSearch?:boolean;replyToOfflineSale?:boolean;replyToOfflinePair?:boolean;ownerDnsPrompt?:string}|null{
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
  const replyToDns=replied?.from?.is_bot===true &&
    typeof replied.text==='string'&&replied.text.startsWith(DNS_ADMIN_PROMPT);
  const replyToDnsSearch=replied?.from?.is_bot===true &&
    typeof replied.text==='string'&&replied.text.startsWith(DNS_ADMIN_SEARCH_PROMPT);
  const replyToOfflineSale=replied?.from?.is_bot===true&&
     typeof replied.text==='string'&&replied.text.startsWith(OFFLINE_SALE_PROMPT);
  const replyToOfflinePair=replied?.from?.is_bot===true&&
     typeof replied.text==='string'&&replied.text.startsWith(OFFLINE_PAIR_PROMPT);
   const ownerDnsPrompt=replied?.from?.is_bot===true&&typeof replied.text==='string'&&
    replied.text.startsWith(OWNER_DNS_EXPIRY_PROMPT)?replied.text:undefined;
  return {id:m.from.id,text:typeof m.text==='string'?m.text:'',replyToSupport,replyToDns,replyToDnsSearch,replyToOfflineSale,replyToOfflinePair,ownerDnsPrompt};
}
async function packages(id:number){
  if(!store)throw new Error('DB unavailable');
  const rows=await store.listUserPackages(id);
  if(!rows.length)return msg('🔐 Мои подключения\n\nПодписок пока нет. Попробуйте бесплатный доступ на 24 часа.',
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
    const quota=personalDnsReady&&row.product==='smart_dns'?null:
      formatRemainingQuota(row.quotaLimitBytes,row.quotaUsedBytes);
    return (index+1)+'. '+label(row.product)+' — '+state+expiry+
      (remaining?' · '+remaining:'')+(quota?'\n'+quota:'');
  });
  return msg('🔐 Мои подключения\n\n'+items.join('\n\n')+
    '\n\nПробный период начинается после подтверждения готовности доступа.',
    [[{text:'🔁 Обновить',callback_data:'nav:status'},
      {text:'🔌 Подключить VPN',callback_data:'nav:connect'}],
     [{text:'🧭 Мой Smart DNS',callback_data:'nav:dns'}],
     [{text:'✈️ Telegram-прокси',callback_data:'nav:trial-proxy'}],
     [{text:'🌐 Тарифы VPN',callback_data:'nav:vpn'}],[homeButton]]);
}

// All outgoing Bot API requests are server-only; no credential reaches HTML.
// The widget's chat_data carries only the personal link returned by Telegram.
async function botApi(method:string,args:Record<string,unknown>):Promise<unknown>{
  if(!outboundBotToken)throw Error('Outbound Telegram Bot API unavailable');
  return sendTelegramBotApi(outboundBotToken,method,args,{maxAttempts:2,baseDelayMs:300,timeoutMs:4800});
}
async function widgetMenuAction(id:number,key:string):Promise<string>{
  const map:Record<string,string>={
    vpn:'nav:vpn',trial:'nav:trial',status:'nav:status',connect:'nav:connect',
    renew:'nav:renew',share:'nav:share',dns:'nav:dns',help:'nav:help',
    support:'nav:support',dnsadmin:'dnsadmin:menu',
  };
  if(key==='dnsadmin'&&id!==dnsAdminId)return 'NOT_ALLOWED';
  const action=key==='support'&&support?.operatorId===id?'support:page:0':map[key];
  if(!action)return 'NOT_ALLOWED';
  const fake={update_id:0,callback_query:{id:'widget-menu',from:{id},
    message:{chat:{id,type:'private'},message_id:1},data:action}};
  try{
    const reply=await processUpdate(fake);
    if(!reply||typeof reply!=='object'||!('method' in reply))return 'UNAVAILABLE';
    const r=reply as Record<string,unknown>;
    let method=String(r.method),args:Record<string,unknown>={...r};
    delete args.method;
    if(method==='editMessageText'){
      method='sendMessage';delete args.message_id;args.chat_id=id;
    }
    if(!['sendMessage','sendWidget','sendInvoice'].includes(method))return 'UNAVAILABLE';
    if(args.chat_id!==id)return 'NOT_ALLOWED';
    await botApi(method,args);
    return 'OPENED';
  }catch{return 'UNAVAILABLE'}
}

async function vpnBubble(id:number) {
  if(!store)throw Error('DB unavailable');
  const offers=(await store.plans('telegram_stars'))
    .filter(p=>p.product==='vpn'&&p.stars!==null)
    // Old/experimental published rows may not represent a sellable widget
    // offer. Validate each row independently so one bad row cannot break
    // the entire checkout, and never fabricate corrected terms.
    .filter(p=>{try{vpnPurchaseWidgetData([p]);return true}catch{return false}})
    .sort((a,b)=>a.durationSeconds-b.durationSeconds||a.planId.localeCompare(b.planId));
  if(!offers.length)return {method:'sendMessage',chat_id:id,
    ...msg('🌐 VPN\\n\\nОпубликованных тарифов сейчас нет. Попробуйте позднее.',
      [[{text:'🎁 Бесплатные 24 часа',callback_data:'trial:vpn'}],[homeButton]])};
  // Direct Stars sheet: the Telegram invoice URLs are generated BEFORE
  // sending the widget. openTelegramLink must be called synchronously on tap;
  // a widget_query response cannot open a link later without another tap.
  if(!outboundBotToken)return {method:'sendWidget',...vpnPurchaseWidgetPayload(id,offers)};
  const links:Record<string,string>={};
  const selected=offers.slice(0,4);
  await Promise.all(selected.map(async plan=>{
    const payload=makePersonalStarsLinkPayload(id,planWidgetKey(plan),starsSecret);
    const title=Array.from(plan.title.trim()).slice(0,32).join('')||'Мне бы VPN';
    const url=await botApi('createInvoiceLink',{
      title,description:'Разовый пакет MNEBYVPN. Продление вручную.',
      payload,provider_token:'',currency:'XTR',prices:[{label:title,amount:plan.stars}],
    });
    if(typeof url!=='string'||!/^https:\/\/t\.me\/(?:\$[A-Za-z0-9_=-]{4,160}|invoice\/[A-Za-z0-9_=-]{4,160})$/.test(url))
      throw Error('Telegram invoice link invalid');
    links[plan.planId]=url;
  }));
  return {method:'sendWidget',...vpnPurchaseWidgetPayload(id,selected,links)};
}
async function catalogPlansView(
  product:'vpn'|'bundle'|'smart_dns',
  heading:string,
  extraButtons:Button[][]=[],
){
  if(!pool||!store)throw new Error('DB unavailable');
  const {rows}=await pool.query(
    `SELECT product,title,duration_seconds,rub_minor,stars,enabled
       FROM billing_plans WHERE product=$1 AND enabled=true
       UNION ALL
       SELECT p.product,p.title,p.duration_seconds,p.rub_minor,p.stars,false AS enabled
       FROM pricing_drafts p
       WHERE p.product=$1 AND NOT EXISTS(
         SELECT 1 FROM billing_plans b WHERE b.enabled=true
           AND b.product=p.product AND b.duration_seconds=p.duration_seconds)
       ORDER BY duration_seconds LIMIT 16`,
    [product],
  );
  const list=rows
    .filter(x=>!(product==='smart_dns'&&Number(x.duration_seconds)===14*86400&&x.rub_minor===null))
    .map(x=>formatDuration(Number(x.duration_seconds))+' — '+
      (x.rub_minor!==null?formatRoubles(Number(x.rub_minor)):'цена уточняется')+
      (x.stars!==null?' / '+Number(x.stars)+' ⭐':''));
  const stars=(await store.plans('telegram_stars'))
    .filter(p=>p.product===product&&p.stars!==null)
    .sort((a,b)=>a.durationSeconds-b.durationSeconds);
  const rub=(await store.plans('yookassa'))
    .filter(p=>p.product===product&&p.rubMinor!==null)
    .sort((a,b)=>a.durationSeconds-b.durationSeconds);
  const options:Button[][]=[];
  for(const p of stars){
    if(p.planId.length>53)continue;
    const days=Math.round(p.durationSeconds/86400);
    const pair:Button[]=[{
      text:'⭐ '+days+' дн · '+p.stars+' Stars',
      callback_data:'buy:stars:'+p.planId,
    }];
    const matchingRub=rub.find(r=>r.durationSeconds===p.durationSeconds);
    if([15,30,60,90].includes(days)&&matchingRub?.rubMinor){
      pair.push({
        text:'💳 ЮKassa · '+Math.round(matchingRub.rubMinor/100)+' ₽',
        url:'https://mnebyvpn.site/?product='+product+'&days='+days,
      });
    }
    options.push(pair);
  }
  for(const p of rub.filter(r=>!stars.some(s=>s.durationSeconds===r.durationSeconds))){
    const days=Math.round(p.durationSeconds/86400);
    if([15,30,60,90].includes(days)&&p.rubMinor){
      options.push([{
        text:'💳 '+days+' дн · ЮKassa '+Math.round(p.rubMinor/100)+' ₽',
        url:'https://mnebyvpn.site/?product='+product+'&days='+days,
      }]);
    }
  }
  return msg(
    heading+'\n\n'+(list.length?list.join('\n'):'Тарифы готовятся к публикации.')+
      '\n\n⭐ Stars — оплата внутри Telegram.\n💳 ЮKassa (карта, СБП) — оплата на сайте без автосписаний.',
    [...options,...extraButtons,
     ...((await store.trialProducts()).includes('bundle')?[[{text:'🎁 «3 в 1» бесплатно',callback_data:'trial:bundle'}]]:product==='vpn'?[[{text:'🎁 Получить 24 часа бесплатно',callback_data:'trial:vpn'}]]:[]),
     [{text:'🔐 Мои подключения',callback_data:'nav:status'}],[homeButton]],
  );
}
async function vpnPlans(){
  return catalogPlansView('vpn','🌐 VPN Лайт · 1 устройство');
}
async function bundlePlans(){
  return catalogPlansView(
    'bundle',
    '✨ Экосистема «3 в 1»\nSmart DNS + Telegram-прокси + VPN до 3 устройств. Не конфликтуют друг с другом.',
  );
}
async function dnsStorefrontMenu(){
  return catalogPlansView(
    'smart_dns',
    '🧭 Smart Доступ · DNS + Telegram-прокси\nYouTube, ChatGPT, Claude, Gemini без постоянного VPN + автовыдача Apple (.mobileconfig), DoT для Android и Telegram-прокси.',
    [[{text:'📱 iPhone / iPad',callback_data:'dns:guide:ios'},
      {text:'🤖 Android',callback_data:'dns:guide:android'}],
     [{text:'📡 Роутер / ТВ',callback_data:'dns:guide:router'},
      {text:'🌐 Сервисы',callback_data:'dns:guide:services'}]],
  );
}
async function widgetStarsInvoice(id:number,key:string,queryId:string):Promise<string>{
  if(!store)return 'UNAVAILABLE';
  // Each widget query is an untrusted request. Never use a price or plan ID
  // provided by the widget to create an order.
  if(!/^[A-Za-z0-9_-]{16}$/.test(key))return 'PLAN_UNAVAILABLE';
  const published=(await store.plans('telegram_stars'))
    .filter(p=>p.product==='vpn'&&p.stars!==null)
    .filter(p=>{try{vpnPurchaseWidgetData([p]);return true}catch{return false}})
    .sort((a,b)=>a.durationSeconds-b.durationSeconds||a.planId.localeCompare(b.planId))
    .slice(0,4).filter(p=>planWidgetKey(p)===key);
  if(published.length!==1)return 'PLAN_UNAVAILABLE';
  const plan=await store.plan(published[0].planId);
  if(!plan||plan.product!=='vpn'||plan.stars===null||planWidgetKey(plan)!==key)
    return 'PLAN_UNAVAILABLE';
  // Tokenless webhook mode can only make one Bot API action. Do not reserve
  // or pretend to send an invoice when the outbound credential is absent.
  if(!outboundBotToken)return 'PAYMENT_UNAVAILABLE';
  try{
    const order=await store.createTelegramOrder(id,plan.planId,'cabinet-widget:'+queryId,
      undefined,key);
    if(!await store.reserveStarsInvoice(order.id,id))return 'ALREADY_REQUESTED';
    const invoice=buildStarsInvoice(starsOrderFromDB(order),
      pricedPlanForOrder(order),starsSecret);
    try{
      const res=await fetch('https://api.telegram.org/bot'+outboundBotToken+'/sendInvoice',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(6500),
        headers:{'Content-Type':'application/json'},body:JSON.stringify(invoice),
      });
      if(!res.ok)throw Error('Telegram invoice request failed');
      const data:unknown=await res.json();
      if(!data||typeof data!=='object'||(data as {ok?:boolean}).ok!==true)
        throw Error('Telegram invoice result unconfirmed');
      await store.finishStarsInvoice(order.id,'SENT');
      return 'INVOICE_SENT';
    }catch{
      // Delivery was attempted. A network failure may hide a delivered invoice.
      // Never resend the same order or falsely say payment is confirmed.
      await store.finishStarsInvoice(order.id,'UNKNOWN').catch(()=>{});
      return 'CHECK_CHAT';
    }
  }catch(error){
    if(String(error).includes('PENDING_CHECKOUT_RATE_LIMIT'))return 'RATE_LIMITED';
    return 'CHECK_CHAT';
  }
}
async function issueStars(id:number,planId:string,updateId:number){
  if(!store)throw new Error('DB unavailable');
  const plan=await store.plan(planId);
  const dnsAllowed=plan?.product==='smart_dns' &&
    (plan.rubMinor!==null || (personalDnsReady&&approvedPersonalDnsOffer(plan)!==null));
  if(!plan||plan.stars===null||
     (plan.product!=='vpn'&&plan.product!=='bundle'&&!dnsAllowed))
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
          const link=parsePersonalStarsLinkPayload(pc.invoice_payload,starsSecret);
          if(link){
            if(!validId(pc.from?.id)||link.telegramUserId!==pc.from.id)
              return {ok:false as const,error_message:'Ссылка предназначена другому пользователю.'};
            const offers=(await store.plans('telegram_stars'))
              .filter(p=>p.product==='vpn'&&p.stars!==null)
              .filter(p=>{try{vpnPurchaseWidgetData([p]);return true}catch{return false}})
              .sort((a,b)=>a.durationSeconds-b.durationSeconds||a.planId.localeCompare(b.planId))
              .slice(0,4);
            const plan=offers.find(p=>planWidgetKey(p)===link.offerKey&&
              p.stars===pc.total_amount);
            if(!plan)return {ok:false as const,error_message:'Тариф изменился. Откройте новое меню.'};
            await store.createTelegramOrder(pc.from.id,plan.planId,
              'invoice-link:'+link.orderId,undefined,link.offerKey,link.orderId);
          }
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
        text:record?.product==='smart_dns'
          ?'✅ Оплата '+record.amount+' ⭐ подтверждена. Заказ записан. После активации в «Мой Smart DNS» (или на сайте) можно получить персональный адрес и файл iPhone/iPad.'
          :record?.product==='bundle'
            ?'✅ Оплата '+record.amount+' ⭐ подтверждена. Экосистема «3 в 1» активируется: VPN (до 3 устройств), Smart DNS и Telegram-прокси.'
            :'✅ Оплата Stars подтверждена. Заказ записан, проверяем выдачу VPN. Статус — в «Мои подключения».',
        reply_markup:{inline_keyboard:[[{text:'🔐 Мои подключения',callback_data:'nav:status'}],
          ...(record?.product==='smart_dns'||record?.product==='bundle'?
            [[{text:'🧭 Мой DNS',callback_data:'nav:dns'}]]:[]) ]}};
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
async function sharedTrialProxy(id:number){
  if(!pool)throw Error('DB unavailable');
  const account=await pool.query('SELECT id FROM accounts WHERE telegram_user_id=$1',[String(id)]);
  const accountId=account.rows[0]?.id;
  const routes=wsProxyReleaseReady(process.env)?parseWsProxyRoutes(process.env.WEB_TELEGRAM_WS_PROXY_ROUTES_JSON):null;
  const links=accountId&&routes?await loadSharedTrialWsProxy(pool,accountId,routes):null;
  if(!links)return msg('✈️ Telegram-прокси\n\nЕсли вы оформили «3 в 1», общие ссылки доступны в личном кабинете при готовности сервиса. Они не зависят от срока VPN и Smart DNS.',
    [[{text:'🌍 Мой доступ',url:'https://mnebyvpn.site/#account'}],[homeButton]]);
  return msg('✈️ Общий Telegram-прокси\n\nОткройте ссылку и подтвердите добавление в Telegram. Эти общие подключения остаются доступными после окончания пробных суток VPN и Smart DNS.',
    [...links.wsLinks.map(link=>[{text:link.route==='ru'?'Подключить через российский сервер':'Подключить через зарубежный сервер',url:link.url}]),[homeButton]]);
}
async function trial(id:number,requested:'vpn'|'smart_dns'|'bundle'='vpn',inviteToken?:string){
  if(!store)throw new Error('DB unavailable');
  const enabled=await store.trialProducts();
  const product=enabled.includes('bundle')?'bundle':requested;
  // The store resumes a previously issued grant before checking offer flags.
  // A disabled catalog must not hide an existing user's access.
  const r=await store.grantTrial(id,product,inviteToken);
  if(r.status==='UNAVAILABLE')return msg('🎁 Бесплатный доступ сейчас недоступен. Попробуйте позднее.',[[homeButton]]);
  // Use actual existing order, not requested tariff, when resuming an older trial.
  const actual=pool&&r.orderId?(await pool.query(
    "SELECT t.product FROM trial_grants t JOIN accounts a ON a.id=t.account_id WHERE t.order_id=$1 AND a.telegram_user_id=$2",
    [r.orderId,String(id)])).rows[0]?.product:product;
  const bundle=actual==='bundle';
  if(pool&&r.status==='ALREADY_USED'&&!bundle){
    const ready=await activationView(pool,id,true);
    if(ready)return ready;
  }
  if(bundle){
    const text=r.status==='GRANTED'
      ? '🎁 «3 в 1» бесплатно на 24 часа\n\nЗаявка принята. Пробный доступ для одного устройства (одно одновременное VPN-подключение). Готовим VPN и Smart DNS. Бот автоматически пришлёт инструкцию после подтверждения готовности обоих сервисов. Общий Telegram-прокси не ограничен пробными сутками.'
      :r.status==='PENDING'
      ? '⏳ Пакет «3 в 1» подключается. Бот автоматически пришлёт инструкцию, когда VPN и Smart DNS будут готовы.'
      :r.status==='ALREADY_USED'
      ? '🎁 Пробный пакет уже оформлялся. Проверьте действующие подключения в личном кабинете. Общий Telegram-прокси доступен и после окончания пробного периода.'
      : '🎁 Бесплатный доступ сейчас недоступен. Попробуйте позднее.';
    return msg(text,[[{text:'🔐 Мои подключения',callback_data:'nav:status'}],
      [{text:'🔌 VPN',callback_data:'nav:connect'},{text:'🧭 Smart DNS',callback_data:'nav:dns'}],
      [{text:'✈️ Telegram-прокси',callback_data:'nav:trial-proxy'}],
      [{text:'✨ Тарифы «3 в 1»',callback_data:'nav:bundle'}],[homeButton]]);
  }
  const text=r.status==='GRANTED'
    ? '🎁 Пробные 24 часа '+(actual==='smart_dns'?'Smart DNS':'VPN')+'\n\nЗаявка принята. 24 часа начнутся после активации.'
    :r.status==='PENDING'
    ? (actual==='smart_dns'?'⏳ Smart DNS подключается. Проверьте готовность в разделе «Мой Smart DNS».':'⏳ Бесплатный доступ подключается. Бот автоматически пришлёт инструкцию, когда сервер подтвердит активацию VPN. Проверять вручную не нужно.')
    :r.status==='ALREADY_USED'
    ? '🎁 Пробные 24 часа уже использованы этим Telegram-аккаунтом.'
    : '🎁 Бесплатный доступ сейчас недоступен. Попробуйте позднее.';
  return msg(text,[[{text:'🔐 Мои подключения',callback_data:'nav:status'}],
    [{text:'🌐 Тарифы VPN',callback_data:'nav:vpn'}],[homeButton]]);
}
function info(data:string,id:number){
  if(data==='nav:dns'||data==='info:dns')return personalDnsPreview();
  if(data==='nav:share')
    return msg('💙 Поддержать проект\n\nМы только в начале пути. Если вам нравится идея простого VPN, поделитесь ссылкой на бота. Это помогает развитию проекта и не требует оплаты.',
      [[{text:'📤 Поделиться',url:'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FMNEBYVPN_bot'}],
       [homeButton]]);
  if(data==='nav:help'||data==='info:help')
    return msg('❔ Помощь\n\n1. Нажмите «24 часа бесплатно» или просмотрите тарифы.\n2. После подтверждения готовности VPN бот пришлёт инструкцию.\n3. В «Мои подключения» смотрите остаток срока и кнопки настройки.',
      [[support?.operatorId===id
         ?{text:'📥 Входящие заявки',callback_data:'support:page:0'}
         :{text:'✉️ Написать оператору',callback_data:'nav:support'}],
       [{text:'🎁 Пробные сутки',callback_data:'trial:vpn'}],[homeButton]]);
  return main(id);
}
async function render(id:number,data:string):Promise<ReturnType<typeof msg>>{
  if(data==='nav:home'||data==='home')return homeView(id);
  if(data==='nav:vpn'||data==='info:vpn'||data==='nav:plans:vpn'||
    data==='nav:catalog'||data==='nav:plans')return vpnPlans();
  if(data==='nav:bundle'||data==='info:bundle'||data==='nav:plans:bundle')
    return bundlePlans();
  if(data==='nav:status'||data==='nav:renew'||data==='nav:manage')return packages(id);
  if((data==='nav:dns'||data==='info:dns')&&pool&&store){
    const starPlans=(await store.plans('telegram_stars')).filter(p=>p.product==='smart_dns');
    const rubPlans=(await store.plans('yookassa'))
      .filter(p=>p.product==='smart_dns'&&p.rubMinor!==null)
      .map(p=>({days:Math.round(p.durationSeconds/86400),rubMinor:p.rubMinor!}));
    if(personalDnsReady){
      const offers=starPlans.filter(p=>
        approvedPersonalDnsOffer(p)!==null||
        (p.rubMinor!==null&&p.stars!==null&&p.dnsQuotaBytes===null&&p.dnsQuotaQueriesPer30d===1_000_000n));
      return personalDnsTelegramMenu(pool,id,offers,rubPlans,regionalDnsReady);
    }
    return dnsStorefrontMenu();
  }
  if(data==='nav:trial')return trial(id);
  if(data==='trial:vpn'||data==='trial:smart_dns'||data==='trial:bundle')return trial(id,data.slice(6) as 'vpn'|'smart_dns'|'bundle');
  if(data==='nav:trial-proxy')return sharedTrialProxy(id);
  if(data==='nav:connect')return pool?await activationView(pool,id)??dbUnavailable():dbUnavailable();
  if(data==='nav:manual')return pool?manualView(pool,id):dbUnavailable();
  if(data.startsWith('nav:device:'))
    return pool?deviceView(pool,id,data.slice('nav:device:'.length)):dbUnavailable();
  return info(data,id);
}
function oneAction(actor:{id:number;messageId?:number;callbackId?:string;currentText?:string;data?:string},view:ReturnType<typeof msg>){
  // Shared proxy links may rotate without changing the message text. Do not
  // suppress the keyboard update in this case.
  if(actor.callbackId&&actor.currentText===view.text&&actor.data!=='nav:trial-proxy')
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
  if(m.reply_to_message?.from?.is_bot===true&&m.reply_to_message.text===TRIAL_INVITE_PROMPT){
    const email=typeof m.text==='string'?m.text.trim().toLowerCase():'';
    const answer=(text:string)=>({method:'sendMessage',chat_id:support.operatorId,text});
    if(!email||email.length>254||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email))
      return answer('Укажите один корректный email.');
    if(!supportAuthKey||!supportWebsiteReady)return answer('Канал восстановления недоступен.');
    const stamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',supportAuthKey)
      .update('MNEBYVPN-trial-invite-v1\n'+stamp+'\n'+support.operatorId+'\n'+email).digest('hex');
    try{
      const r=await fetch('http://127.0.0.1:'+supportWebsitePort+'/api/support/operator-trial-invite',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{'Content-Type':'application/json','X-MNEBYVPN-Support-Ts':stamp,
          'X-MNEBYVPN-Support-Signature':signature},
        body:JSON.stringify({email,operator:support.operatorId}),
      });
      if(r.ok){
        const result=await r.json() as {status?:string};
        if(result.status==='SENT')return answer('✅ Почтовый шлюз подтвердил отправку приглашения.');
        if(result.status==='ALREADY_SENT')return answer('Приглашение уже отправлено.');
        if(result.status==='NOT_ELIGIBLE')return answer('Не найден подходящий аккаунт без заказов или пробного доступа.');
        if(result.status==='IN_PROGRESS')return answer('Предыдущая отправка не завершена однозначно. Повторное письмо заблокировано.');
      }
    }catch{}
    return answer('Отправку подтвердить не удалось. Не создавайте повторную заявку до проверки.');
  }
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
    await telegramSupportSendWithRetry(support,
      '✉️ Поддержка MNEBYVPN\n\n'+parsed.answer,parsed.userId,
      {inline_keyboard:[[{text:'✉️ Написать ещё',callback_data:'nav:support'}],
        [{text:'🏠 Главное',callback_data:'nav:home'}]]},{maxAttempts:2,baseDelayMs:300,timeoutMs:6000});
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
    await telegramSupportSendWithRetry(support,'✉️ MNEBYVPN — обращение из бота\nID Telegram: '+id+
      '\n\nВопрос:\n'+message.trim(),support.operatorId,
      {inline_keyboard:[
        [{text:'✍️ Ответить клиенту',callback_data:'support:reply:bot:'+id}],
        [{text:'📥 Входящие с сайта',callback_data:'support:page:0'}],
      ]},{maxAttempts:2,baseDelayMs:300,timeoutMs:6000});
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
  if(update.widget_query?.id||update.shared_widget_query?.id){
    const w=update.widget_query??update.shared_widget_query;
    let result='NOT_ALLOWED';
    const valid=update.widget_query&&validId(w.from?.id)&&w.chat?.type==='private'&&
      w.chat.id===w.from.id&&validId(w.message_id)&&typeof w.data==='string'&&
      Buffer.byteLength(w.data,'utf8')<=64&&
      (w.type===undefined||w.type?.type==='data')&&!w.widget_id;
    if(valid&&/^menu:(vpn|trial|status|connect|renew|share|dns|help|support|dnsadmin)$/.test(w.data)){
      result=await widgetMenuAction(w.from.id,w.data.slice(5));
    }else if(valid&&/^buy:[A-Za-z0-9_-]{16}$/.test(w.data)){
      try{result=await widgetStarsInvoice(w.from.id,w.data.slice(4),w.id)}
      catch{result='CHECK_CHAT'}
    }
    return {method:'answerWidgetQuery',widget_query_id:w.id,data:result};
  }
  const adminReply=await handleOperatorReply(update);
  if(adminReply)return adminReply;
  const actor=privateActor(update);
  if(!actor)return null;
  const text=actor.text?.trim()??'';
  const operator=support&&actor.id===support.operatorId;
   const saleAction=actor.data?.startsWith('offsale:')??false;
   if(saleAction||actor.replyToOfflineSale||actor.replyToOfflinePair){
     if(!offlineSalesEnabled||dnsAdminId===null||actor.id!==dnsAdminId){
       if(actor.callbackId)return {method:'answerCallbackQuery',
         callback_query_id:actor.callbackId,text:'Недоступно',show_alert:true};
       return oneAction(actor,msg('Недостаточно прав.',[[homeButton]]));
     }
     if(actor.data==='offsale:new')
       return {method:'sendMessage',chat_id:actor.id,...offlineSalePrompt()};
     if(actor.data==='offsale:pair:new')
       return {method:'sendMessage',chat_id:actor.id,...offlinePairPrompt()};
     if(!pool)return oneAction(actor,dbUnavailable());
     try{
       if(actor.replyToOfflineSale)
         return oneAction(actor,await registerOfflineSale(pool,actor.id,dnsAdminId,
           String(update.update_id),text));
       if(actor.replyToOfflinePair)
         return oneAction(actor,await registerOfflineSalePair(pool,actor.id,dnsAdminId,
           String(update.update_id),text));
       if(actor.data==='offsale:menu')return oneAction(actor,offlineSaleMenu());
       const listing=/^offsale:list:(0|[1-9][0-9]{0,3})$/.exec(actor.data??'');
       if(listing)return oneAction(actor,await listOfflineSales(pool,actor.id,dnsAdminId,
         Number(listing[1])));
       const show=/^offsale:(show|links):([0-9a-f-]{36})$/.exec(actor.data??'');
       if(show)return oneAction(actor,await showOfflineSale(pool,actor.id,dnsAdminId,
         show[2],show[1]==='links',offlineDnsIssueEnabled,ownerLinkKey));
       return oneAction(actor,offlineSaleMenu());
     }catch{return oneAction(actor,dbUnavailable());}
   }
  const dnsAction=actor.data?.startsWith('dnsadmin:')??false;
  const ownerLinkAction=actor.data?.startsWith('dnslinks:')??false;
  const dnsTextCommand=text==='/dnsadmin';
  if((dnsAction||ownerLinkAction||actor.ownerDnsPrompt||dnsTextCommand||actor.replyToDns||actor.replyToDnsSearch)&&
      (dnsAdminId===null||actor.id!==dnsAdminId)){
    if(actor.callbackId)return {method:'answerCallbackQuery',
      callback_query_id:actor.callbackId,text:'Недоступно',show_alert:true};
    return oneAction(actor,msg('Эта функция недоступна.',[[homeButton]]));
  }
  if(dnsAdminId!==null&&actor.id===dnsAdminId){
    if(ownerLinkAction||actor.ownerDnsPrompt){
      const prompt=ownerDnsExpiryPrompt(actor.data??'');
      if(prompt)return {method:'sendMessage',chat_id:actor.id,...prompt};
      const action=actor.ownerDnsPrompt?ownerDnsExpiryReply(actor.ownerDnsPrompt,text):actor.data;
      if(!action)return oneAction(actor,msg('Неверный срок. Ответьте, например: «12 ч» или «7 д».',[
        [{text:'↩️ Мои DNS-ссылки',callback_data:'dnslinks:menu'}]]));
      return oneAction(actor,await ownerDnsLinksAction(pool,dnsAdminId,actor.id,ownerLinkKey,action,
        String(update.update_id)));
    }
    if(actor.data==='dnsadmin:add')
      return {method:'sendMessage',chat_id:actor.id,...dnsAdminPrompt()};
    if(actor.data==='dnsadmin:search')
      return {method:'sendMessage',chat_id:actor.id,...dnsAdminSearchPrompt()};
    if(actor.replyToDns)return oneAction(actor,await dnsAdminAdd(pool,actor.id,text));
    if(actor.replyToDnsSearch)return oneAction(actor,await dnsAdminSearch(pool,text));
    if(dnsAction)return oneAction(actor,
      await dnsAdminAction(dnsAdminId,actor.id,pool,actor.data??''));
    if(dnsTextCommand)return oneAction(actor,dnsAdminIntro());
  }
  if(operator){
    if(actor.data==='support:trial-invite')return {method:'sendMessage',chat_id:actor.id,
      text:TRIAL_INVITE_PROMPT,reply_markup:{force_reply:true,input_field_placeholder:'Email клиента'}};
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
  // Telegram opens https://t.me/MNEBYVPN_bot?start=support as /start support.
  // Route INCY's support-url directly to the existing support flow, instead
  // of silently falling back to the home screen. Keep operator inbox private.
  if(!actor.callbackId&&text==='/start support')
    return operator?operatorSupportInbox(actor,0):supportPromptResponse(actor.id);
  let action=actor.data??'nav:home';
  if(!actor.callbackId){
    if(text==='/trial'||text==='🆓 Пробный день')action='trial:vpn';
    else if(text==='/my'||text==='/status'||text==='🔐 Мои подписки')action='nav:status';
    else if(text==='/plans'||text==='🌐 Выбрать доступ')action='nav:vpn';
    else if(text==='/connect')action='nav:connect';
    else if(text==='/share')action='nav:share';
    else if(text==='/help')action='nav:help';
    else if(text==='/dns')action='nav:dns';
  }
  try {
    const trialInvite=!actor.callbackId?/^\/start\s+t([A-Za-z0-9_-]{16,24})$/.exec(text):null;
    if(trialInvite&&store){
      const offer=await store.referralPlan(trialInvite[1]);
      if(!offer)return oneAction(actor,msg('Ссылка приглашения недействительна.',[[homeButton]]));
      return oneAction(actor,await trial(actor.id,offer.product,trialInvite[1]));
    }
    if(action==='nav:menu:legacy')
      return {method:'sendMessage',chat_id:actor.id,...await homeView(actor.id)};
    // Bot API 10.4 widgets are restricted for general bots in production.
    // Use reliable standard Telegram messages for the public entry and shop.
    if(action==='nav:home'||action==='home')
      return oneAction(actor,await homeView(actor.id));
    if(['nav:vpn','info:vpn','nav:plans:vpn','nav:catalog','nav:plans'].includes(action))
      return oneAction(actor,await vpnPlans());
    if(['nav:bundle','info:bundle','nav:plans:bundle'].includes(action))
      return oneAction(actor,await bundlePlans());
    if(action==='nav:vpn:list')return oneAction(actor,await vpnPlans());
    if(/^dns:guide:(ios|android|router|services)$/.test(action))
      return oneAction(actor,personalDnsGuide(action.slice('dns:guide:'.length)));
    if(action==='dns:issue'||/^dns:rotate:(confirm|execute):[1-9][0-9]{0,12}$/.test(action)||
       (regionalDnsReady&&/^dns:fi:(confirm|execute):(0|[1-9][0-9]{0,8})$/.test(action))){
      // Paid entitlement and public DNS readiness are independent gates.
      if(!personalDnsReady||!pool)return oneAction(actor,info('nav:dns',actor.id));
      const view=await personalDnsTelegramAction(pool,actor.id,action,hostname=>
        sendPersonalDnsMobileconfig(actor.id,hostname,outboundBotToken),regionalDnsReady);
      // One-time credential and sendDocument result are private, not editable.
      return {method:'sendMessage',chat_id:actor.id,...view};
    }
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
