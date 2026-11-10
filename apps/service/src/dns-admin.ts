/** Owner-only DNS domain requests; NEVER a direct CoreDNS mutation.
 * Verified Telegram private chat identity is checked by the caller AND here.
 * No public Bot API credentials, shell commands or raw DNS config are accepted.
 */
import {isIP} from 'node:net';
import type {Pool} from 'pg';

export type AdminButton={text:string;callback_data:string};
export type AdminPage={text:string;reply_markup:{inline_keyboard:AdminButton[][]}};
type DomainRow={id:string|number;domain:string;product:string;status:string};
const back:AdminButton={text:'↩️ DNS-меню',callback_data:'dnsadmin:menu'};
const home:AdminButton={text:'🏠 Главное',callback_data:'nav:home'};
const page=(text:string,buttons:AdminButton[][]):AdminPage=>({
  text,reply_markup:{inline_keyboard:buttons},
});
const labels:Record<string,string>={
  PENDING:'🟡 На проверке',
  ACTIVE:'🟢 Активен (сверьте с DNS)',
  FAILED:'🔴 Не прошёл проверку',
  CANCELLED:'⚪ Заявка отменена',
  REMOVAL_PENDING:'🟠 Отключение ожидает применения',
};
const badSuffix=/\.(?:localhost|local|internal|test|invalid|example|onion|arpa|lan|home|corp)$/;
const domainPattern=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export function dnsAdminOwner(env:NodeJS.ProcessEnv=process.env):number|null{
  const explicit=env.DNS_ADMIN_TELEGRAM_ID;
  const candidate=explicit===undefined?env.SUPPORT_TELEGRAM_OPERATOR_ID:explicit;
  if(!candidate||!/^[1-9][0-9]{0,15}$/.test(candidate))return null;
  const id=Number(candidate);
  return Number.isSafeInteger(id)&&id>0?id:null;
}
export function normalizeDnsDomain(value:unknown):string|null{
  if(typeof value!=='string'||value.length>255)return null;
  // Accept exactly a DNS hostname, not an URL, wildcard, IP or DNS zone file.
  const trimmed=value.trim().toLowerCase();
  const domain=trimmed.endsWith('.')?trimmed.slice(0,-1):trimmed;
  if(domain.length<4||domain.length>253||isIP(domain)!==0||
     !domainPattern.test(domain)||badSuffix.test(domain))return null;
  if(domain.split('.').some(label=>label.startsWith('xn--')))return null;
  return domain;
}
export function dnsAdminIntro():AdminPage{
  return page('🛠 MNEBYDNS · управление доменами\n\n'+
    'Здесь можно добавлять домены в очередь проверки и отменять заявки. '+
    'Пока статус «На проверке», реальный DNS и прокси НЕ изменяются. '+
    'Включать маршрут можно только после проверки HTTPS, SNI, IPv6 и отката.',[
      [{text:'➕ Добавить домен',callback_data:'dnsadmin:add'}],
      [{text:'📋 Домены и статусы',callback_data:'dnsadmin:list'}],
      [{text:'☁️ Oracle · проверить заявки',callback_data:'dnsadmin:oracle'}],
      [home],
    ]);
}
export const DNS_ADMIN_PROMPT='🛠 MNEBYDNS • новый домен';
export function dnsAdminPrompt(){
  return {text:DNS_ADMIN_PROMPT+'\n\nОтправьте только адрес, например example.org. Без https://, пути или *.\n\nСохранение создаст ЗАЯВКУ, а не включит маршрутизацию.',
    reply_markup:{force_reply:true,input_field_placeholder:'domain.com'}};
}
export function dnsAdminError(message:string):AdminPage{
  return page('⚠️ '+message,[[back],[home]]);
}
function safeId(value:string):number|null{
  if(!/^[1-9][0-9]{0,14}$/.test(value))return null;
  const n=Number(value);
  return Number.isSafeInteger(n)?n:null;
}
function textRow(row:DomainRow):string{
  const state=labels[row.status]??'Неизвестный статус';
  return row.domain+' — '+state+(row.product==='custom'?'':' · '+row.product);
}
export async function dnsAdminList(pool:Pool|null):Promise<AdminPage>{
  if(!pool)return dnsAdminError('База доменов недоступна. DNS не менялся.');
  try{
    const {rows}=await pool.query<DomainRow>(
      'SELECT id,domain,product,status FROM dns_admin_domains ORDER BY updated_at DESC,id DESC LIMIT 15');
    const buttons:AdminButton[][]=rows.map(row=>[{
      text:(labels[row.status]?.slice(0,2)??'•')+' '+row.domain.slice(0,40),
      callback_data:'dnsadmin:domain:'+row.id,
    }]);
    buttons.push([{text:'🔄 Обновить',callback_data:'dnsadmin:list'}],
      [{text:'➕ Добавить',callback_data:'dnsadmin:add'}],[back],[home]);
    return page('📋 MNEBYDNS · заявки\n\n'+
      (rows.length?rows.map((row,i)=>(i+1)+'. '+textRow(row)).join('\n'):'Список пуст.')+
      '\n\nСтатус «На проверке» НЕ означает доступность сайта через Smart DNS.',
      buttons);
  }catch{return dnsAdminError('Не удалось загрузить заявки. DNS не менялся.');}
}
export async function dnsAdminAdd(pool:Pool|null,actorId:number,value:string,product='custom'):
  Promise<AdminPage>{
  const domain=normalizeDnsDomain(value);
  if(!domain)return dnsAdminError('Некорректный адрес. Нужен публичный домен без протокола, порта, пути и маски *.');
  if(!pool)return dnsAdminError('База доменов недоступна. Заявка не сохранена.');
  try{
    // One owner and idempotent unique key: Telegram may retry a webhook update.
    const {rows}=await pool.query<DomainRow>(
      `INSERT INTO dns_admin_domains (domain,product,status,requested_by,updated_by)
       VALUES ($1,$2,'PENDING',$3,$3)
       ON CONFLICT (domain) DO UPDATE SET
         status='PENDING',updated_by=EXCLUDED.updated_by,
         requested_by=EXCLUDED.requested_by,updated_at=now()
       WHERE dns_admin_domains.status IN ('CANCELLED','FAILED')
       RETURNING id,domain,product,status`,
      [domain,product,actorId]);
    if(rows.length){
      return page('✅ '+domain+' добавлен В ОЧЕРЕДЬ ПРОВЕРКИ.\n\n'+
        'Маршрутизация НЕ включена. Сначала проверка TLS, DNS и безопасного отката.',
        [[{text:'📋 Все заявки',callback_data:'dnsadmin:list'}],[back]]);
    }
    return page('ℹ️ '+domain+' уже присутствует в списке. Второй раз не добавлял.',
      [[{text:'📋 Проверить статус',callback_data:'dnsadmin:list'}],[back]]);
  }catch{return dnsAdminError('Не удалось сохранить заявку. DNS не менялся.');}
}
export async function dnsAdminOracle(pool:Pool|null,actorId:number):Promise<AdminPage>{
  if(!pool)return dnsAdminError('База доменов недоступна. Oracle не добавлен.');
  const domains=['oracle.com','cloud.oracle.com'] as const;
  try{
    const outcomes:string[]=[];
    for(const domain of domains){
      const {rowCount}=await pool.query(
        `INSERT INTO dns_admin_domains (domain,product,status,requested_by,updated_by)
         VALUES ($1,'Oracle','PENDING',$2,$2)
         ON CONFLICT (domain) DO UPDATE SET
           status='PENDING',updated_by=EXCLUDED.updated_by,
           requested_by=EXCLUDED.requested_by,updated_at=now()
         WHERE dns_admin_domains.status IN ('CANCELLED','FAILED')`,[domain,actorId]);
      outcomes.push(domain+((rowCount??0)>0?' — добавлен':' — уже в списке'));
    }
    return page('☁️ Oracle\n\n'+outcomes.join('\n')+
      '\n\nЭто кандидаты для проверки, не работающие DNS-маршруты. '+
      'Региональные адреса Oracle Cloud могут отличаться.',[
        [{text:'📋 Все заявки',callback_data:'dnsadmin:list'}],[back]]);
  }catch{return dnsAdminError('Ошибка сохранения Oracle. DNS не менялся.');}
}
export async function dnsAdminDomain(pool:Pool|null,rawId:string):Promise<AdminPage>{
  const id=safeId(rawId);
  if(!id)return dnsAdminError('Некорректный номер заявки.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      'SELECT id,domain,product,status FROM dns_admin_domains WHERE id=$1',[id]);
    const row=rows[0];
    if(!row)return dnsAdminError('Заявка не найдена.');
    const buttons:AdminButton[][]=[];
    if(['PENDING','FAILED','ACTIVE'].includes(row.status))
      buttons.push([{text:row.status==='ACTIVE'?'⏳ Запросить отключение':'🗑 Отменить заявку',
        callback_data:'dnsadmin:cancel:'+row.id}]);
    buttons.push([{text:'📋 Список',callback_data:'dnsadmin:list'}],[back]);
    return page('🌍 '+textRow(row)+'\n\n'+
      (row.status==='ACTIVE'
        ?'Запись в базе требует отдельного подтверждения реальной DNS-конфигурацией.'
        :'Заявка не означает, что домен уже работает через DNS.'),buttons);
  }catch{return dnsAdminError('Не удалось прочитать заявку.');}
}
export async function dnsAdminCancel(pool:Pool|null,actorId:number,rawId:string):Promise<AdminPage>{
  const id=safeId(rawId);
  if(!id)return dnsAdminError('Некорректный номер заявки.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      `UPDATE dns_admin_domains SET
         status=CASE WHEN status='ACTIVE' THEN 'REMOVAL_PENDING' ELSE 'CANCELLED' END,
         updated_by=$2, updated_at=now()
       WHERE id=$1 AND status IN ('PENDING','FAILED','ACTIVE')
       RETURNING id,domain,product,status`,[id,actorId]);
    if(!rows.length)return dnsAdminError('Запись не найдена или уже изменена.');
    return page('✅ '+textRow(rows[0])+'\n\n'+
      (rows[0].status==='REMOVAL_PENDING'
        ?'Маршрут ещё не отключён. Требуется отдельное безопасное применение.'
        :'Заявка отменена. Работающий DNS не изменён.'),[
        [{text:'📋 Список',callback_data:'dnsadmin:list'}],[back]]);
  }catch{return dnsAdminError('Не удалось изменить заявку. DNS не менялся.');}
}
export async function dnsAdminAction(
  owner:number|null,actorId:number,pool:Pool|null,action:string):Promise<AdminPage>{
  if(owner===null||owner!==actorId)return dnsAdminError('Доступ закрыт.');
  if(action==='dnsadmin:menu')return dnsAdminIntro();
  if(action==='dnsadmin:list')return dnsAdminList(pool);
  if(action==='dnsadmin:oracle')return dnsAdminOracle(pool,actorId);
  const domain=/^dnsadmin:domain:([1-9][0-9]{0,14})$/.exec(action);
  if(domain)return dnsAdminDomain(pool,domain[1]);
  const cancel=/^dnsadmin:cancel:([1-9][0-9]{0,14})$/.exec(action);
  if(cancel)return dnsAdminCancel(pool,actorId,cancel[1]);
  return dnsAdminError('Неизвестное действие.');
}
