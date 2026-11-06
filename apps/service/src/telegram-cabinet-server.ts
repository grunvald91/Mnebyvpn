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
import {createHash,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../../packages/billing/src/store.ts';
import {activationView,awaitActivation,deviceView,manualView}
  from './vpn-onboarding.ts';
import {RemnawaveApi} from '../../../packages/provisioning/src/remnawave-api.ts';
import {formatDuration,formatRoubles} from '../../../packages/telegram-ui/src/menu.ts';
import {effectiveAccessState,formatRemainingTime,formatRemainingQuota} from '../../../packages/telegram-ui/src/access-format.ts';

const digest=process.env.TELEGRAM_WEBHOOK_SECRET_SHA256??'';
if(!/^[a-f0-9]{64}$/.test(digest))
  throw new Error('TELEGRAM_WEBHOOK_SECRET_SHA256 is mandatory');
const expected=Buffer.from(digest,'hex');
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
// A bot must never silently inherit the provisioning worker's write token.
const vpnReadToken=process.env.REMNAWAVE_READ_API_TOKEN;
const nodeProfileToken=process.env.VPN_WORKER_PROFILE_TOKEN??'';
const vpnApi=(process.env.REMNAWAVE_API_URL&&vpnReadToken&&
  process.env.VPN_SUBSCRIPTION_ORIGIN&&process.env.REMNAWAVE_SQUAD_UUIDS)
  ?new RemnawaveApi({
    panelUrl:process.env.REMNAWAVE_API_URL,
    apiToken:vpnReadToken,
    subscriptionOrigin:process.env.VPN_SUBSCRIPTION_ORIGIN,
    squadUuids:process.env.REMNAWAVE_SQUAD_UUIDS.split(',').map(x=>x.trim()),
  }):null;
type Button={text:string;callback_data?:string;url?:string;copy_text?:{text:string}};
const homeButton:Button={text:'🏠 Главное',callback_data:'nav:home'};
const siteButton:Button={text:'🌍 Сайт (резервный)',url:'https://mnebyvpn.site'};
const label=(p:string)=>p==='vpn'?'🌐 VPN':p==='smart_dns'?'🧭 Smart DNS':'🔐 VPN + DNS';
const validId=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const msg=(text:string,keyboard:Button[][])=>{
  return {text,reply_markup:{inline_keyboard:keyboard}};
};
const main=()=>msg(
  '🌐 Мне бы VPN\n\nУправляйте подключением здесь, в Telegram. Выберите действие ниже.\n\n🎁 Пробные 24 часа VPN — без оплаты. Время начнётся после реальной выдачи доступа.',
  [
    [{text:'🌐 VPN и тарифы',callback_data:'nav:vpn'}],
    [{text:'🎁 Бесплатные 24 часа',callback_data:'nav:trial'}],
    [{text:'🔐 Мои подключения',callback_data:'nav:status'},
     {text:'🔌 Подключить',callback_data:'nav:connect'}],
    [{text:'🔁 Продление',callback_data:'nav:renew'},
     {text:'🎁 Пригласить друга',callback_data:'nav:share'}],
    [{text:'🧭 Smart DNS — в разработке',callback_data:'nav:dns'}],
    [{text:'❔ Помощь',callback_data:'nav:help'}],
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
function privateActor(update:any):{id:number;messageId?:number;callbackId?:string;data?:string;text?:string}|null{
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
  return {id:m.from.id,text:typeof m.text==='string'?m.text:''};
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
async function connectVpn(id:number){
  if(!store)throw new Error('DB unavailable');
  const candidate=await store.confirmedVpnProfile(id);
  if(!candidate)return msg(
    '🔌 Подключение VPN\n\nПока нет действующего VPN-доступа, полностью подтверждённого узлом. Если вы запросили пробные сутки, проверьте статус.',
    [[{text:'🔐 Мои подключения',callback_data:'nav:status'}],[homeButton]]);
  if(/^[a-f0-9]{64}$/i.test(nodeProfileToken)){
    try{
      const response=await fetch('http://127.0.0.1:8794/profile',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
        headers:{'Authorization':'Bearer '+nodeProfileToken,
          'Content-Type':'application/json'},
        body:JSON.stringify({telegramUserId:id}),
      });
      if(!response.ok)throw Error('VPN profile worker unavailable');
      const payload:unknown=await response.json();
      const url=(payload as {profile?:unknown})?.profile;
      if(typeof url!=='string'||!url.startsWith('vless://')||
         !url.includes('@cdn.servgo.ru:8443?'))
        throw Error('Unconfirmed VPN credential');
      return msg('🔌 Ваш VPN готов\n\nСкопируйте личную ссылку VLESS ниже и импортируйте её в приложение с поддержкой VLESS / WebSocket / TLS. Не пересылайте ссылку другим людям.\n\n'+url,
        [[{text:'🔐 Мои подключения',callback_data:'nav:status'}],[homeButton]]);
    }catch{
      return msg('🔌 Подключение VPN\n\nУзел ещё не подтвердил профиль. Проверьте статус через несколько секунд.',
        [[{text:'🔁 Проверить снова',callback_data:'nav:connect'}],[homeButton]]);
    }
  }
  if(!vpnApi)return msg(
    '🔌 Подключение VPN\n\nДоступ подтверждён в кабинете, но серверная выдача конфигураций ещё не настроена. Данные не изменены.',
    [[{text:'🔁 Проверить снова',callback_data:'nav:connect'}],[homeButton]]);
  let url:string|null=null;
  try {url=await vpnApi.subscriptionFor(candidate.entitlementId,candidate.expiresAt,candidate.revision);}
  catch { /* Credentials, remote paths and provider payloads must never be logged. */ }
  if(!url)return msg(
    '🔌 Подключение VPN\n\nСсылка ещё не подтверждена сервером. Попробуйте снова позже.',
    [[{text:'🔁 Повторить',callback_data:'nav:connect'}],[homeButton]]);
  return msg('🔌 Ваш VPN готов\n\nОткройте персональную ссылку и импортируйте профиль в поддерживаемое VPN-приложение. Не пересылайте ссылку другим людям.',
    [[{text:'🔗 Получить VPN-конфигурацию',url}],
     [{text:'🔐 Мои подключения',callback_data:'nav:status'}],[homeButton]]);
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
  return msg('🌐 VPN\n\n'+(list.length?list.join('\n'):'Тарифы готовятся к публикации.')+
    '\n\nПодключение и управление полностью через этот бот. Пробные 24 часа — без оплаты.\n\nДо подтверждённой выдачи доступа платежи не принимаются.',
    [[{text:'🎁 Получить 24 часа бесплатно',callback_data:'trial:vpn'}],
     [{text:'🔐 Мои подключения',callback_data:'nav:status'}],[homeButton]]);
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
    return msg('🎁 Пригласить друга\n\nПерешлите ссылку на бота. Реферальные бонусы появятся вместе с опубликованными тарифами.',
      [[{text:'📤 Поделиться',url:'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FMnebyVPN_bot'}],
       [homeButton]]);
  if(data==='nav:help'||data==='info:help')
    return msg('❔ Помощь\n\n1. Выберите VPN.\n2. Нажмите «24 часа бесплатно» или просмотрите тарифы.\n3. В разделе «Мои подключения» проверяйте статус и остаток срока.\n\nИнтернет при ограничениях мобильной сети и совместный тариф находятся в разработке.',
      [[{text:'🎁 Пробные сутки',callback_data:'trial:vpn'}],[homeButton]]);
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
async function processUpdate(update:any){
  if(update.message?.successful_payment||update.message?.refunded_payment)
    throw new Error('Financial event needs durable settlement');
  if(update.pre_checkout_query?.id)return {
    method:'answerPreCheckoutQuery',pre_checkout_query_id:update.pre_checkout_query.id,
    ok:false,error_message:'Оплата откроется после проверки реальной выдачи VPN.',
  };
  if(update.widget_query?.id)return {
    method:'answerWidgetQuery',widget_query_id:update.widget_query.id,data:'UNAVAILABLE',
  };
  const actor=privateActor(update);
  if(!actor)return null;
  const text=actor.text?.trim()??'';
  let action=actor.data??'nav:home';
  if(!actor.callbackId){
    if(text==='/trial'||text==='🆓 Пробный день')action='trial:vpn';
    else if(text==='/my'||text==='/status'||text==='🔐 Мои подписки')action='nav:status';
    else if(text==='/plans'||text==='🌐 Выбрать доступ')action='nav:vpn';
    else if(text==='/connect')action='nav:connect';
    else if(text==='/share')action='nav:share';
    else if(text==='/help'||text==='/support')action='nav:help';
  }
  try {return oneAction(actor,await render(actor.id,action));}
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
