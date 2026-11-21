/** Owner-only, separately audited in-person sales.
 * No public HTTP handler. Telegram usernames here are labels, NOT identity proof.
 * A distinct internal account/order is created per sale without PSP webhooks.
 */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {issueOwnerOfflineSubscriptionLink} from '../../../packages/provisioning/src/owner-offline-subscriptions.ts';
import {makePersonalDoTIdentity} from '../../../packages/dns-policy/src/personal-dot-identity.ts';
import {encryptOwnerDnsLabel,decryptOwnerDnsLabel} from './owner-dns-links.ts';
import {ownerProxyReleaseReady,loadCustomerProxyBonus,parseOwnerProxyRoutes}
  from '../../../packages/web/src/telegram-proxy-bonus.ts';

export const OFFLINE_SALE_PROMPT='💼 MNEBYVPN — личная продажа';
const PLAN='bundle_30d_3device';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE=/^@?([a-z][a-z0-9_]{4,31})$/i;
type Button={text:string;callback_data?:string;copy_text?:{text:string}};
type Page={text:string;reply_markup:{inline_keyboard:Button[][]}};
const home:Button={text:'🏠 Главное',callback_data:'nav:home'};
const back:Button={text:'↩️ Личные продажи',callback_data:'offsale:menu'};
const page=(text:string,buttons:Button[][]=[[back],[home]]):Page=>
  ({text,reply_markup:{inline_keyboard:buttons}});
const authorized=(actor:number,owner:number|null)=>
  owner!==null&&Number.isSafeInteger(actor)&&actor>0&&actor===owner;

export type SaleInput={customerLabel:string;amountMinor:number;receiptReference:string|null};
export function parseSaleInput(raw:string):SaleInput|null{
  if(typeof raw!=='string'||raw.length>160)return null;
  const parts=raw.trim().split(/\s+/);
  if(parts.length<2||parts.length>3)return null;
  const handle=HANDLE.exec(parts[0]);
  const rub=/^[1-9][0-9]{0,4}$/.test(parts[1])?Number(parts[1]):0;
  if(!handle||rub<1||rub>100000)return null;
  const receipt=parts[2]??'-';
  if(receipt!=='-'&&!/^[A-Za-z0-9_-]{4,80}$/.test(receipt))return null;
  return {customerLabel:handle[1].toLowerCase(),amountMinor:rub*100,
    receiptReference:receipt==='-'?null:receipt};
}
export function offlineSalePrompt(){
  return {
    text:OFFLINE_SALE_PROMPT+'\n\nВведите: @username фактически_получено_руб [номер_чека]\n'+
      'Например: @customer 399\n\nТариф: «3 в 1», 30 дней, до 3 устройств.\n'+
      'Если чек уже оформлен, укажите номер третьим словом. '+
      'Если нет — оформите чек отдельно в «Мой налог».\n'+
      'Telegram-имя — только подпись в реестре, без отправки клиенту.',
    reply_markup:{force_reply:true,input_field_placeholder:'@username 399'},
  };
}
export function offlineSaleMenu():Page{
  return page('💼 Личные продажи · MNEBYVPN\n\n'+
    'Регистрация отдельно от сайта и платёжных провайдеров.\n'+
    'Ссылки получает только владелец в личном чате.\n'+
    '30 дней начинаются с регистрации продажи, не с первого подключения.',[
      [{text:'➕ Продать «3 в 1» · 30 дней',callback_data:'offsale:new'}],
      [{text:'📋 Покупатели и ссылки',callback_data:'offsale:list:0'}],
      [home],
    ]);
}

export async function registerOfflineSale(
  pool:Pool,operatorId:number,ownerId:number|null,requestKey:string,raw:string,
):Promise<Page>{
  if(!authorized(operatorId,ownerId))return page('Недостаточно прав.',[[home]]);
  const input=parseSaleInput(raw);
  if(!input)return page('Неверный формат. Укажите @username и фактическую сумму в рублях.',[
    [{text:'➕ Повторить',callback_data:'offsale:new'}],[back]]);
  if(!/^[1-9][0-9]{0,19}$/.test(requestKey))
    return page('Некорректный идентификатор операции.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Serialize both webhook replay and attempts to sell twice to the same handle.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      ['mnebyvpn:manual-sale',input.customerLabel]);
    const replay=await client.query(
      'SELECT m.order_id,m.customer_label,m.declared_amount_minor,m.receipt_reference '+
      'FROM manual_sales m WHERE m.operator_telegram_id=$1 AND m.request_key=$2',
      [String(operatorId),requestKey]);
    if(replay.rowCount){
      const r=replay.rows[0];
      if(r.customer_label!==input.customerLabel||
         Number(r.declared_amount_minor)!==input.amountMinor||
         (r.receipt_reference??null)!==input.receiptReference)
        throw Error('REPLAY_CONFLICT');
      await client.query('COMMIT');
      return saleRecorded(String(r.order_id),input.customerLabel,true);
    }
    // Prevent accidental double charges/double 30-day rights. Future renewals
    // require an explicit separate flow; a username by itself proves no identity.
    const existing=await client.query(
      "SELECT 1 FROM manual_sales m JOIN entitlements e ON e.source_order_id=m.order_id "+
      "WHERE m.operator_telegram_id=$1 AND m.customer_label=$2 AND e.product='vpn' "+
      "AND e.state IN ('ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','SUSPENDED') "+
      "AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp()) LIMIT 1",
      [String(operatorId),input.customerLabel]);
    if(existing.rowCount) {
      await client.query('ROLLBACK');
      return page('Для @'+input.customerLabel+
        ' уже существует действующая личная продажа. Новая не создана.',[
        [{text:'📋 Посмотреть продажи',callback_data:'offsale:list:0'}],[back]]);
    }
    const p=await client.query(
      'SELECT id,title,duration_seconds,dns_quota_bytes,dns_quota_queries_per_30d,'+
      'device_limit FROM billing_plans WHERE id=$1 AND enabled=true FOR SHARE',[PLAN]);
    const plan=p.rows[0];
    if(!plan||Number(plan.duration_seconds)!==2592000||
       Number(plan.dns_quota_queries_per_30d)!==1000000||
       Number(plan.device_limit)!==3||
       plan.dns_quota_bytes!==null)
      throw Error('MANUAL_SALES_CATALOG_NOT_READY');
    const orderId=randomUUID(),accountId=randomUUID();
    const vpnId=randomUUID(),dnsId=randomUUID();
    const started=new Date(),expires=new Date(started.getTime()+2592000*1000);
    await client.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
    await client.query(
      "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
      "VALUES($1,$2,'bundle','manual_sale',$3,'RUB','PAID')",
      [orderId,accountId,input.amountMinor]);
    await client.query(
      'INSERT INTO order_terms(order_id,plan_id,plan_title,duration_seconds,'+
      'dns_quota_bytes,dns_quota_queries_per_30d,device_limit,expires_at) '+
      'VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval \'1 hour\')',
      [orderId,plan.id,plan.title,plan.duration_seconds,plan.dns_quota_bytes,
       plan.dns_quota_queries_per_30d,plan.device_limit]);
    await client.query(
      'INSERT INTO manual_sales(order_id,operator_telegram_id,request_key,'+
      'customer_label,declared_amount_minor,receipt_reference) VALUES($1,$2,$3,$4,$5,$6)',
      [orderId,String(operatorId),requestKey,input.customerLabel,
       input.amountMinor,input.receiptReference]);
    for(const [product,id] of [['vpn',vpnId],['smart_dns',dnsId]] as const){
      const q=product==='smart_dns'?Number(plan.dns_quota_queries_per_30d):null;
      await client.query(
        'INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,'+
        'starts_at,expires_at,quota_limit_bytes,dns_query_quota_per_30d) '+
        "VALUES($1,$2,$3,$4,'PAID_PENDING_PROVISIONING',1,$5,$6,NULL,$7)",
        [id,accountId,orderId,product,started,expires,q]);
      await client.query(
        'INSERT INTO entitlement_credits(entitlement_id,order_id,credit_sequence,'+
        'starts_at,ends_at,duration_seconds,quota_bytes,quota_queries_per_30d) '+
        'VALUES($1,$2,0,$3,$4,$5,NULL,$6)',
        [id,orderId,started,expires,plan.duration_seconds,q]);
      await client.query(
        'INSERT INTO reconcile_outbox(entitlement_id,desired_revision) VALUES($1,1)',
        [id]);
    }
    await client.query('COMMIT');
    return saleRecorded(orderId,input.customerLabel,false);
  }catch{
    try{await client.query('ROLLBACK');}catch{}
    return page('Не удалось зарегистрировать продажу. Оплаченный доступ не подтверждён. '+
      'Проверьте миграцию 0141 и состояние базы.',[[back]]);
  }finally{client.release();}
}
function saleRecorded(orderId:string,label:string,replay:boolean):Page{
  return page((replay?'🔁 Операция уже учтена.':'✅ Личная продажа записана.')+
    '\n\nПокупатель: @'+label+'\nТариф: «3 в 1» · 30 дней\n'+
    'Канал: личная продажа (по сообщению владельца).\n'+
    'Сетевой доступ активируется штатными воркерами; запись ≠ подтверждение подключения.\n'+
    'Чек «Мой налог» оформляется отдельно.\n\nЗаказ: '+orderId,[
      [{text:'🔍 Проверить и получить ссылки',callback_data:'offsale:show:'+orderId}],
      [back],
    ]);
}
type SaleRow={
 order_id:string;account_id:string;customer_label:string;
 declared_amount_minor:string|number;recorded_at:Date;receipt_reference:string|null;
 vpn_id:string;vpn_state:string;vpn_expires:Date|null;vpn_ready:boolean;
 dns_id:string;dns_state:string;dns_expires:Date|null;dns_ready:boolean;
};
async function loadSale(pool:Pool,ownerId:number,orderId:string):Promise<SaleRow|null>{
  if(!UUID.test(orderId))return null;
  const {rows}=await pool.query(
    'SELECT m.order_id,o.account_id,m.customer_label,m.declared_amount_minor,'+
    'm.recorded_at,m.receipt_reference,'+
    'v.id vpn_id,v.state vpn_state,v.expires_at vpn_expires,'+
    "COALESCE(v.state='ACTIVE' AND v.expires_at>clock_timestamp() "+
    "AND pv.applied_revision=v.revision AND pv.last_observed_at IS NOT NULL,false) vpn_ready,"+
    'd.id dns_id,d.state dns_state,d.expires_at dns_expires,'+
    "COALESCE(d.state='ACTIVE' AND d.expires_at>clock_timestamp() "+
    "AND pd.applied_revision=d.revision AND pd.last_observed_at IS NOT NULL,false) dns_ready "+
    'FROM manual_sales m JOIN orders o ON o.id=m.order_id '+
    "JOIN entitlements v ON v.source_order_id=o.id AND v.product='vpn' "+
    "JOIN entitlements d ON d.source_order_id=o.id AND d.product='smart_dns' "+
    "LEFT JOIN provisioning_state pv ON pv.entitlement_id=v.id AND pv.adapter='vpn' "+
    "LEFT JOIN provisioning_state pd ON pd.entitlement_id=d.id AND pd.adapter='smart_dns' "+
    'WHERE m.operator_telegram_id=$1 AND m.order_id=$2 AND o.provider=$3 AND o.state=$4',
    [String(ownerId),orderId,'manual_sale','PAID']);
  return (rows[0] as SaleRow|undefined)??null;
}
export async function listOfflineSales(pool:Pool,actorId:number,ownerId:number|null,
  offset:number):Promise<Page>{
  if(!authorized(actorId,ownerId))return page('Недостаточно прав.',[[home]]);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000)return offlineSaleMenu();
  const {rows}=await pool.query(
    'SELECT m.order_id,m.customer_label,m.recorded_at FROM manual_sales m '+
    'WHERE m.operator_telegram_id=$1 ORDER BY m.recorded_at DESC,m.order_id DESC '+
    'LIMIT 11 OFFSET $2',[String(actorId),offset]);
  const keyboard:Button[][]=rows.slice(0,10).map(r=>[
    {text:'@'+String(r.customer_label),callback_data:'offsale:show:'+String(r.order_id)},
  ]);
  if(offset)keyboard.push([{text:'← Назад',callback_data:'offsale:list:'+Math.max(0,offset-10)}]);
  if(rows.length>10)keyboard.push([{text:'Ещё →',callback_data:'offsale:list:'+(offset+10)}]);
  keyboard.push([back]);
  return page('📋 Личные продажи'+(rows.length?'':'\n\nПока записей нет.'),keyboard);
}
async function ownerDnsHostname(pool:Pool,ownerId:number,orderId:string,
  dnsId:string,key:Buffer):Promise<string|null>{
  if(key.length!==32)return null;
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const {rows}=await c.query(
      "SELECT m.dns_label_ciphertext,e.id,e.state,e.expires_at "+
      "FROM manual_sales m "+
      "JOIN orders o ON o.id=m.order_id AND o.provider='manual_sale' AND o.state='PAID' "+
      "JOIN entitlements e ON e.source_order_id=o.id AND e.account_id=o.account_id "+
      "JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='smart_dns' "+
      "AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL "+
      "WHERE m.operator_telegram_id=$1 AND m.order_id=$2 AND e.id=$3 "+
      "AND e.product='smart_dns' FOR UPDATE OF m,e",
      [String(ownerId),orderId,dnsId]);
    const r=rows[0];
    if(!r||r.state!=='ACTIVE'||!r.expires_at||
       new Date(r.expires_at).getTime()<=Date.now()){
      await c.query('ROLLBACK');return null;
    }
    if(r.dns_label_ciphertext){
      const label=decryptOwnerDnsLabel(r.dns_label_ciphertext,dnsId,ownerId,key);
      const hash=await c.query(
        'SELECT token_sha256 FROM personal_dns_credentials WHERE entitlement_id=$1 '+
        'AND revoked_at IS NULL',[dnsId]);
      const valid=hash.rows[0]?.token_sha256;
      const {createHash}=await import('node:crypto');
      if(valid!==createHash('sha256').update(label,'ascii').digest('hex')){
        await c.query('ROLLBACK');return null;
      }
      await c.query('COMMIT');
      return label+'.dns.mnebyvpn.site';
    }
    for(let attempt=0;attempt<3;attempt++){
      const id=makePersonalDoTIdentity();
      const status=await c.query(
        'SELECT issue_personal_dns_credential($1,$2,$3,$4) AS result',
        [dnsId,id.label,id.tokenSha256,id.queryLimitPer30d]);
      if(status.rows[0]?.result==='DENY_TOKEN_COLLISION')continue;
      if(status.rows[0]?.result!=='ISSUED')break;
      await c.query(
        'UPDATE manual_sales SET dns_label_ciphertext=$3 '+
        'WHERE order_id=$1 AND operator_telegram_id=$2',
        [orderId,String(ownerId),encryptOwnerDnsLabel(id.label,dnsId,ownerId,key)]);
      await c.query('COMMIT');
      return id.hostname;
    }
    await c.query('ROLLBACK');
    return null;
  }catch{
    try{await c.query('ROLLBACK');}catch{}
    return null;
  }finally{c.release();}
}

export async function showOfflineSale(
  pool:Pool,actorId:number,ownerId:number|null,orderId:string,
  reveal:boolean,dnsEnabled:boolean,dnsKey:Buffer|null,
):Promise<Page>{
  if(!authorized(actorId,ownerId))return page('Недостаточно прав.',[[home]]);
  const r=await loadSale(pool,actorId,orderId);
  if(!r)return page('Продажа не найдена.',[[back]]);
  const money=Number(r.declared_amount_minor)/100;
  const ready=r.vpn_ready===true;
  const dnsReady=r.dns_ready===true;
  const lines=[
    '💼 Личная продажа · @'+r.customer_label,
    '«3 в 1» · 30 дней · до 3 устройств (по тарифу)',
    'VPN: одна обновляемая подписка; отдельная активация 3 ключей будет позже.',
    'Сумма по записи владельца: '+money+' ₽',
    'Чек: '+(r.receipt_reference??'не отмечен — оформить отдельно'),
    'VPN: '+(ready?'подтверждён сервером':r.vpn_state),
    'Smart DNS: '+(dnsReady?'подтверждён обработчиком':r.dns_state),
  ];
  const buttons:Button[][]=[];
  if(reveal){
    if(ready){
      // A single provider failure must never hide another service's link.
      let vpn:Awaited<ReturnType<typeof issueOwnerOfflineSubscriptionLink>>=null;
      try{
        if(dnsKey)vpn=await issueOwnerOfflineSubscriptionLink(pool,actorId,r.order_id,r.vpn_id,dnsKey);
      }catch{/* Fail closed; keep the owner card and other services available. */}
      if(vpn){
        lines.push('\n🔐 VPN (одна обновляемая ссылка):\n'+vpn.link);
        buttons.push([{text:'📋 Скопировать VPN',copy_text:{text:vpn.link}}]);
      }else lines.push('\nVPN-ссылка пока не выдана: проверьте ключ владельца, отзыв и состояние узла.');
    }else lines.push('\nVPN-ссылка ещё недоступна: узел не подтвердил активацию.');
    if(dnsReady&&dnsEnabled&&dnsKey){
      const hostname=await ownerDnsHostname(pool,actorId,r.order_id,r.dns_id,dnsKey);
      if(hostname){
        lines.push('\n🧭 Частный DNS (DoT):\n'+hostname);
        buttons.push([{text:'📋 Скопировать DNS',copy_text:{text:hostname}}]);
      }else lines.push('\nDNS-ключ пока не выдан. Проверьте реестр credentials.');
    }else lines.push('\nDNS-ссылка пока не доступна: DNS не активирован или выдача отключена.');
    if(dnsReady&&ownerProxyReleaseReady(process.env)){
      const routes=parseOwnerProxyRoutes(process.env.MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON);
      if(routes){
        let bonus:Awaited<ReturnType<typeof loadCustomerProxyBonus>>=null;
        try{
          bonus=await loadCustomerProxyBonus(pool,r.account_id,r.dns_id,
            process.env.WEB_DNS_MT_PROXY_BONUS_KEY!,routes,5,true);
        }catch{/* Never expose ciphertext or customer secrets in errors. */}
        if(bonus)for(const p of bonus.links){
          lines.push('\n📨 Telegram-прокси ('+p.label+'):\n'+p.url);
          buttons.push([{text:'📋 Прокси · '+p.route,copy_text:{text:p.url}}]);
        }
        if(!bonus)lines.push('\nTelegram-прокси: ожидается подтверждение Telemt.');
      }
    }else lines.push('\nTelegram-прокси: ожидается подтверждение или включение выдачи.');
    lines.push('\n⚠️ Ссылки предназначены только владельцу. Не публикуйте их.');
  }
  buttons.push([{text:reveal?'🔄 Обновить ссылки':'🔑 Получить ссылки',
    callback_data:'offsale:links:'+r.order_id}]);
  buttons.push([{text:'📋 Все продажи',callback_data:'offsale:list:0'}],[home]);
  return page(lines.join('\n'),buttons);
}
