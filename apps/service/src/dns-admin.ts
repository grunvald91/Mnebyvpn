/** Owner-only DNS domain requests; NEVER a direct CoreDNS mutation.
 * Verified Telegram private chat identity is checked by the caller AND here.
 * No public Bot API credentials, shell commands or raw DNS config are accepted.
 */
import {isIP} from 'node:net';
import type {Pool} from 'pg';

export type AdminButton={text:string;callback_data:string};
export type AdminPage={text:string;reply_markup:{inline_keyboard:AdminButton[][]}};
type DomainRow={id:string|number;domain:string;product:string;status:string;canary_expires_at?:Date|null;last_error_code?:string|null};
const back:AdminButton={text:'↩️ DNS-меню',callback_data:'dnsadmin:menu'};
const home:AdminButton={text:'🏠 Главное',callback_data:'nav:home'};
const page=(text:string,buttons:AdminButton[][]):AdminPage=>({
  text,reply_markup:{inline_keyboard:buttons},
});
const labels:Record<string,string>={
  PENDING:'🟡 Ожидает проверки',
  APPLY_REQUESTED:'⏳ Запрошен запуск',
  CANARY:'🧪 Тест 60 минут',
  CONFIRM_REQUESTED:'⏳ Ожидает закрепления',
  ROLLBACK_REQUESTED:'⏳ Запрошен откат',
  ACTIVE:'🟢 Активен',
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
    'Добавляй домены, затем из карточки запускай проверку и временное включение. '+
    'Постоянное включение — только после проверки на телефоне и отдельного подтверждения. '+
    'Если тест не подтверждён, маршрут отключится автоматически.',[
      [{text:'➕ Добавить домен',callback_data:'dnsadmin:add'}],
      [{text:'📋 Домены и статусы',callback_data:'dnsadmin:list:0'}],
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
export async function dnsAdminList(pool:Pool|null,pageNo=0):Promise<AdminPage>{
  if(!Number.isSafeInteger(pageNo)||pageNo<0||pageNo>99)
    return dnsAdminError('Некорректная страница.');
  if(!pool)return dnsAdminError('База доменов недоступна. DNS не менялся.');
  try{
    const {rows}=await pool.query<DomainRow>(
      'SELECT id,domain,product,status FROM dns_admin_domains ORDER BY updated_at DESC,id DESC LIMIT 9 OFFSET $1',
      [pageNo*8]);
    const visible=rows.slice(0,8);
    const buttons:AdminButton[][]=visible.map(row=>[{
      text:(labels[row.status]?.slice(0,2)??'•')+' '+row.domain.slice(0,42),
      callback_data:'dnsadmin:domain:'+row.id,
    }]);
    const nav:AdminButton[]=[];
    if(pageNo>0)nav.push({text:'⬅️ Назад',callback_data:'dnsadmin:list:'+(pageNo-1)});
    if(rows.length>8)nav.push({text:'Далее ➡️',callback_data:'dnsadmin:list:'+(pageNo+1)});
    if(nav.length)buttons.push(nav);
    buttons.push([{text:'🔄 Обновить',callback_data:'dnsadmin:list:'+pageNo}],
      [{text:'➕ Добавить',callback_data:'dnsadmin:add'}],[back],[home]);
    return page('📋 MNEBYDNS · домены · страница '+(pageNo+1)+'\n\n'+
      (visible.length?visible.map((row,i)=>(pageNo*8+i+1)+'. '+
        (row.domain.length>65?row.domain.slice(0,62)+'…':row.domain)+' — '+
        (labels[row.status]??'Неизвестный статус')).join('\n'):'Список пуст.')+
      '\n\nПока тест не прошёл, маршрут не считается активным.',
      buttons);
  }catch{return dnsAdminError('Не удалось загрузить домены. DNS не менялся.');}
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
  const domains=['oracle.com','www.oracle.com','cloud.oracle.com'] as const;
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
  if(!id)return dnsAdminError('Некорректный номер записи.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      'SELECT id,domain,product,status,canary_expires_at,last_error_code FROM dns_admin_domains WHERE id=$1',[id]);
    const row=rows[0];
    if(!row)return dnsAdminError('Домен не найден.');
    const buttons:AdminButton[][]=[];
    if(['PENDING','FAILED'].includes(row.status))
      buttons.push([{text:'🧪 Проверить и включить на 60 минут',
        callback_data:'dnsadmin:apply:'+row.id}]);
    if(row.status==='CANARY')buttons.push([
      {text:'✅ Работает — оставить',callback_data:'dnsadmin:keep:'+row.id},
      {text:'↩️ Откат',callback_data:'dnsadmin:cancel:'+row.id},
    ]);
    if(['PENDING','FAILED','ACTIVE','APPLY_REQUESTED','CANARY','CONFIRM_REQUESTED'].includes(row.status)&&
       row.status!=='CANARY')
      buttons.push([{text:row.status==='ACTIVE'?'⏳ Запросить отключение':'🗑 Отменить / откатить',
        callback_data:'dnsadmin:cancel:'+row.id}]);
    buttons.push([{text:'📋 Список',callback_data:'dnsadmin:list:0'}],[back]);
    const expires=row.canary_expires_at instanceof Date
      ?'\nАвтооткат: '+row.canary_expires_at.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК':'';
    const error=row.last_error_code?'\nПоследняя проверка: '+row.last_error_code.slice(0,96):'';
    return page('🌍 '+textRow(row)+expires+error+'\n\n'+
      (row.status==='ACTIVE'
        ?'Маршрут подтверждён. Для отключения нажми кнопку и подтверди действие.'
        :row.status==='CANARY'
        ?'Сейчас временный тест. Проверь сайт на телефоне. Если не подтвердить, сервер вернёт прежнюю конфигурацию.'
        :'Статус заявки не означает работающий DNS-маршрут.'),buttons);
  }catch{return dnsAdminError('Не удалось прочитать домен.');}
}
export async function dnsAdminReview(pool:Pool|null,kind:'apply'|'keep'|'cancel',rawId:string):Promise<AdminPage>{
  const id=safeId(rawId);
  if(!id)return dnsAdminError('Некорректный номер домена.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      'SELECT id,domain,product,status FROM dns_admin_domains WHERE id=$1',[id]);
    const row=rows[0];
    if(!row)return dnsAdminError('Домен не найден.');
    const allowed=kind==='apply'?['PENDING','FAILED']:
      kind==='keep'?['CANARY']:
      ['PENDING','FAILED','APPLY_REQUESTED','ACTIVE','CANARY','CONFIRM_REQUESTED'];
    if(!allowed.includes(row.status))return dnsAdminError('Действие недоступно для текущего состояния.');
    const description=kind==='apply'
      ?'Это запустит предварительные проверки и 60-минутный тест DNS/TLS. Если маршрут не проходит проверки, он не включится.'
      :kind==='keep'
      ?'Подтверди ТОЛЬКО если лично проверил работу на телефоне. Сервер дополнительно проверит активный тест перед закреплением.'
      :'Если маршрут работает, сервер отправит запрос на отключение/откат; если ещё не включён, заявка будет отменена.';
    const label=kind==='apply'?'🚀 Запросить тест 60 минут':
      kind==='keep'?'✅ Да, сохранить':'↩️ Подтвердить отключение';
    return page('🌍 '+row.domain+'\n\n'+description,[
      [{text:label,callback_data:'dnsadmin:yes-'+kind+':'+id}],
      [{text:'Не менять',callback_data:'dnsadmin:domain:'+id}],
      [back],
    ]);
  }catch{return dnsAdminError('Не удалось подготовить подтверждение.');}
}
export async function dnsAdminApply(pool:Pool|null,actorId:number,rawId:string):Promise<AdminPage>{
  const id=safeId(rawId);
  if(!id)return dnsAdminError('Некорректный номер домена.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      `UPDATE dns_admin_domains SET status='APPLY_REQUESTED',revision=revision+1,
       updated_by=$2,updated_at=now(),last_error_code=NULL
       WHERE id=$1 AND status IN ('PENDING','FAILED')
       RETURNING id,domain,product,status`,[id,actorId]);
    if(!rows.length)return dnsAdminError('Состояние уже изменилось. Обнови карточку.');
    return page('⏳ '+rows[0].domain+'\n\nЗапрос на тест записан. Сначала проверка TLS, DNS, SNI и исключений. '+
      'Затем — временное подключение с независимым откатом. '+
      'Следи за статусом в меню. Пока не написано «Тест 60 минут», домен не активен.',[
       [{text:'🔄 Проверить статус',callback_data:'dnsadmin:domain:'+id}],
       [back]]);
  }catch{return dnsAdminError('Запрос не сохранён; рабочий DNS не менялся.');}
}
export async function dnsAdminKeep(pool:Pool|null,actorId:number,rawId:string):Promise<AdminPage>{
  const id=safeId(rawId);
  if(!id)return dnsAdminError('Некорректный номер домена.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      `UPDATE dns_admin_domains SET status='CONFIRM_REQUESTED',revision=revision+1,
       updated_by=$2,updated_at=now()
       WHERE id=$1 AND status='CANARY' AND canary_expires_at>now()+interval '2 minutes'
       RETURNING id,domain,product,status`,[id,actorId]);
    if(!rows.length)return dnsAdminError('Тест уже завершён или срок слишком близок. Запроси новый тест.');
    return page('⏳ '+rows[0].domain+'\n\nПодтверждение принято, но постоянное включение '+
      'ещё не завершено. Статус изменится после сверки конфигураций сервером.',[
        [{text:'🔄 Проверить статус',callback_data:'dnsadmin:domain:'+id}],
        [back]]);
  }catch{return dnsAdminError('Не удалось записать подтверждение.');}
}
export async function dnsAdminCancel(pool:Pool|null,actorId:number,rawId:string):Promise<AdminPage>{
  const id=safeId(rawId);
  if(!id)return dnsAdminError('Некорректный номер домена.');
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<DomainRow>(
      `UPDATE dns_admin_domains SET
         status=CASE
          WHEN status='ACTIVE' THEN 'REMOVAL_PENDING'
          WHEN status IN ('CANARY','CONFIRM_REQUESTED') THEN 'ROLLBACK_REQUESTED'
          ELSE 'CANCELLED' END,
         revision=revision+1,updated_by=$2,updated_at=now()
       WHERE id=$1 AND status IN
        ('PENDING','FAILED','APPLY_REQUESTED','ACTIVE','CANARY','CONFIRM_REQUESTED')
       RETURNING id,domain,product,status`,[id,actorId]);
    if(!rows.length)return dnsAdminError('Состояние уже изменилось. Обнови список.');
    const changed=rows[0];
    return page('✅ '+textRow(changed)+'\n\n'+
      (changed.status==='CANCELLED'?'Заявка отменена; новый DNS-маршрут не включался.':
        'Заявка на изменение принята. Нельзя считать маршрут отключённым до проверки сервера.'),[
        [{text:'🔄 Проверить',callback_data:'dnsadmin:domain:'+id}],[back]]);
  }catch{return dnsAdminError('Не удалось изменить заявку. DNS не менялся.');}
}
export async function dnsAdminAction(
  owner:number|null,actorId:number,pool:Pool|null,action:string):Promise<AdminPage>{
  if(owner===null||owner!==actorId)return dnsAdminError('Доступ закрыт.');
  if(action==='dnsadmin:menu')return dnsAdminIntro();
  if(action==='dnsadmin:list')return dnsAdminList(pool,0);
  const list=/^dnsadmin:list:(0|[1-9][0-9]{0,1})$/.exec(action);
  if(list)return dnsAdminList(pool,Number(list[1]));
  if(action==='dnsadmin:oracle')return dnsAdminOracle(pool,actorId);
  const domain=/^dnsadmin:domain:([1-9][0-9]{0,14})$/.exec(action);
  if(domain)return dnsAdminDomain(pool,domain[1]);
  const review=/^dnsadmin:(apply|keep|cancel):([1-9][0-9]{0,14})$/.exec(action);
  if(review)return dnsAdminReview(pool,review[1] as 'apply'|'keep'|'cancel',review[2]);
  const confirm=/^dnsadmin:yes-(apply|keep|cancel):([1-9][0-9]{0,14})$/.exec(action);
  if(confirm){
    const kind=confirm[1],id=confirm[2];
    if(kind==='apply')return dnsAdminApply(pool,actorId,id);
    if(kind==='keep')return dnsAdminKeep(pool,actorId,id);
    return dnsAdminCancel(pool,actorId,id);
  }
  return dnsAdminError('Неизвестное действие.');
}
