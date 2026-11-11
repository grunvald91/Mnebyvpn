/** Owner-only DNS domain requests; NEVER a direct CoreDNS mutation.
 * Verified Telegram private chat identity is checked by the caller AND here.
 * No public Bot API credentials, shell commands or raw DNS config are accepted.
 */
import {isIP} from 'node:net';
import type {Pool} from 'pg';

export type AdminButton={text:string;callback_data:string};
export type AdminPage={text:string;reply_markup:{inline_keyboard:AdminButton[][]}};
type DomainRow={id:string|number;domain:string;product:string;status:string;canary_expires_at?:Date|null;last_error_code?:string|null};
// Exact names explicitly contained in the owner's 523-host study. These are
// queue inventory entries, NOT an authorization to proxy shared Microsoft apexes.
export const MICROSOFT_DOMAINS=[
  'bing.com','copilot.microsoft.com','microsoft.com',
  'software-static.download.prss.microsoft.com',
  'xbox.com','xboxdesignlab.xbox.com',
] as const;
export const DNS_ADMIN_SEARCH_PROMPT='🔎 MNEBYDNS • поиск домена';
type DomainView='all'|'pending'|'active'|'microsoft';
const back:AdminButton={text:'↩️ DNS-меню',callback_data:'dnsadmin:menu'};
const home:AdminButton={text:'🏠 Главное',callback_data:'nav:home'};
const page=(text:string,buttons:AdminButton[][]):AdminPage=>({
  text,reply_markup:{inline_keyboard:buttons},
});
const labels:Record<string,string>={
  PENDING:'🟡 Ожидает проверки',
  APPLY_REQUESTED:'⏳ Запрошен запуск',
  PROBING:'🔎 Проверяется сервер',
  CANARY:'🧪 Тест 60 минут',
  CONFIRM_REQUESTED:'⏳ Ожидает закрепления',
  CONFIRMING:'⏳ Закрепляется на сервере',
  ROLLBACK_REQUESTED:'⏳ Запрошен откат',
  ACTIVE:'🟢 Активен',
  COVERED:'🟢 Уже работает через общий маршрут',
  FAILED:'🔴 Не прошёл проверку',
  CANCELLED:'⚪ Заявка отменена',
  REMOVAL_PENDING:'🟠 Отключение ожидает применения',
  REMOVING:'⏳ Отключается на сервере',
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
  return page('🛠 MNEBYDNS · управление доменами Smart DNS\n\n'+
    '1. Найди домен в ожидающих или через поиск. 2. Открой карточку. '+
    '3. Запусти проверку и 60-минутный тест. 4. Проверь на телефоне '+
    'и подтверди либо откати. Пока статус PENDING, реальный DNS не изменён.',[
      [{text:'🪟 Microsoft · 6 доменов',callback_data:'dnsadmin:microsoft'}],
      [{text:'🟡 Ожидающие',callback_data:'dnsadmin:list:pending:0'},
       {text:'🟢 Работающие',callback_data:'dnsadmin:list:active:0'}],
      [{text:'🔎 Найти по имени / продукту',callback_data:'dnsadmin:search'}],
      [{text:'📋 Все домены',callback_data:'dnsadmin:list:0'}],
      [{text:'📊 Очередь и ошибки',callback_data:'dnsadmin:queue'}],
      [{text:'➕ Добавить один домен',callback_data:'dnsadmin:add'}],
      [{text:'☁️ Oracle',callback_data:'dnsadmin:oracle'}],
      [home],
    ]);
}
export const DNS_ADMIN_PROMPT='🛠 MNEBYDNS • новый домен';
export function dnsAdminPrompt(){
  return {text:DNS_ADMIN_PROMPT+'\n\nОтправьте только адрес, например example.org. Без https://, пути или *.\n\nСохранение создаст ЗАЯВКУ, а не включит маршрутизацию.',
    reply_markup:{force_reply:true,input_field_placeholder:'domain.com'}};
}
export function dnsAdminSearchPrompt(){
  return {text:DNS_ADMIN_SEARCH_PROMPT+'\n\nНапиши часть домена или название продукта: Microsoft, Xbox, Copilot.\nНичего не будет добавлено или переключено.',
    reply_markup:{force_reply:true,input_field_placeholder:'Microsoft'}};
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
  const state=row.status==='ACTIVE'&&row.last_error_code==='ACTIVE_ROUTE_CHECK_FAILED'
    ?'🟠 Работает с предупреждением: проверка недоступна'
    :labels[row.status]??'Неизвестный статус';
  return row.domain+' — '+state+(row.product==='custom'?'':' · '+row.product);
}
function viewTitle(view:DomainView):string{
  return view==='pending'?'🟡 Ожидающие и проверки':
    view==='active'?'🟢 Работающие маршруты':
    view==='microsoft'?'🪟 Microsoft': '📋 Все домены';
}
export async function dnsAdminList(pool:Pool|null,pageNo=0,view:DomainView='all'):Promise<AdminPage>{
  if(!Number.isSafeInteger(pageNo)||pageNo<0||pageNo>99||
     !(['all','pending','active','microsoft'] as string[]).includes(view))
    return dnsAdminError('Некорректная страница.');
  if(!pool)return dnsAdminError('База доменов недоступна. DNS не менялся.');
  try{
    const base='SELECT id,domain,product,status,last_error_code FROM dns_admin_domains';
    const order=' ORDER BY updated_at DESC,id DESC LIMIT 9 OFFSET ';
    const where=view==='pending'?
      " WHERE status IN ('PENDING','FAILED','APPLY_REQUESTED','PROBING','CANARY','CONFIRM_REQUESTED','CONFIRMING','ROLLBACK_REQUESTED','REMOVAL_PENDING','REMOVING')":
      view==='active'?" WHERE status IN ('ACTIVE','COVERED')":'';
    const microsoft=view==='microsoft';
    const sql=microsoft?base+" WHERE domain=ANY($1::text[]) OR product='Microsoft'"+order+'$2':
      base+where+order+'$1';
    const {rows}=await pool.query<DomainRow>(sql,
      microsoft?[MICROSOFT_DOMAINS,pageNo*8]:[pageNo*8]);
    const visible=rows.slice(0,8);
    const callback=(n:number)=>view==='all'?'dnsadmin:list:'+n:
      'dnsadmin:list:'+view+':'+n;
    const buttons:AdminButton[][]=visible.map(row=>[{
      text:(labels[row.status]?.slice(0,2)??'•')+' '+row.domain.slice(0,42),
      callback_data:'dnsadmin:domain:'+row.id,
    }]);
    const nav:AdminButton[]=[];
    if(pageNo>0)nav.push({text:'⬅️ Назад',callback_data:callback(pageNo-1)});
    if(rows.length>8)nav.push({text:'Далее ➡️',callback_data:callback(pageNo+1)});
    if(nav.length)buttons.push(nav);
    buttons.push([{text:'🔄 Обновить',callback_data:callback(pageNo)}]);
    if(microsoft)buttons.push([{text:'➕ Поставить все 6 в очередь',callback_data:'dnsadmin:microsoft:confirm'}]);
    else buttons.push([{text:'🔎 Поиск',callback_data:'dnsadmin:search'}]);
    buttons.push([back],[home]);
    const text=visible.map((row,i)=>(pageNo*8+i+1)+'. '+
      (row.domain.length>65?row.domain.slice(0,62)+'…':row.domain)+' — '+
      (row.status==='ACTIVE'&&row.last_error_code==='ACTIVE_ROUTE_CHECK_FAILED'
        ?'🟠 Требуется проверка маршрута':labels[row.status]??'Неизвестный статус')).join('\n');
    return page(viewTitle(view)+' · страница '+(pageNo+1)+'\n\n'+
      (text||'Нет записей по этому фильтру.')+'\n\n'+
      (microsoft?'Microsoft — группа отдельных имён из исследования. Общие microsoft.com и bing.com требуют особой проверки. ': '')+
      'Нажми на адрес, чтобы открыть кнопки проверки, подтверждения и отключения.',buttons);
  }catch{return dnsAdminError('Не удалось загрузить домены. DNS не менялся.');}
}
export async function dnsAdminSearch(pool:Pool|null,input:string):Promise<AdminPage>{
  if(!pool)return dnsAdminError('База доменов недоступна.');
  const phrase=input.trim();
  if(phrase.length<2||phrase.length>64||!/^[a-zA-Zа-яА-ЯёЁ0-9. -]+$/.test(phrase))
    return dnsAdminError('Для поиска введи 2–64 символа: имя домена или продукта.');
  try{
    // SQL LIKE special characters are escaped; search is read-only and bounded.
    const pattern='%'+phrase+'%';
    const {rows}=await pool.query<DomainRow>(
      'SELECT id,domain,product,status,last_error_code FROM dns_admin_domains '+
      'WHERE domain ILIKE $1 OR product ILIKE $1 '+
      'ORDER BY updated_at DESC,id DESC LIMIT 9',[pattern]);
    const visible=rows.slice(0,8);
    const buttons:AdminButton[][]=visible.map(row=>[{
      text:(labels[row.status]?.slice(0,2)??'•')+' '+row.domain.slice(0,42),
      callback_data:'dnsadmin:domain:'+row.id,
    }]);
    buttons.push([{text:'🔎 Искать ещё',callback_data:'dnsadmin:search'}],
      [{text:'🪟 Microsoft',callback_data:'dnsadmin:microsoft'}],[back]);
    return page('🔎 Поиск: '+phrase+'\n\n'+
      (visible.map(x=>x.domain+' — '+(labels[x.status]??x.status)).join('\n')||'Ничего не найдено.')+
      (rows.length>8?'\n\nПоказаны первые 8. Уточни запрос.':''),buttons);
  }catch{return dnsAdminError('Ошибка поиска в базе доменов.');}
}
export async function dnsAdminQueue(pool:Pool|null):Promise<AdminPage>{
  if(!pool)return dnsAdminError('База доменов недоступна.');
  try{
    const {rows}=await pool.query<{status:string;total:string}>(
      'SELECT status,count(*)::text AS total FROM dns_admin_domains GROUP BY status ORDER BY status');
    const active=new Set(['ACTIVE','COVERED']);
    const waiting=new Set(['PENDING','APPLY_REQUESTED','PROBING','CANARY',
      'CONFIRM_REQUESTED','CONFIRMING','ROLLBACK_REQUESTED','REMOVAL_PENDING','REMOVING','FAILED']);
    const count=(states:Set<string>)=>rows.reduce((n,r)=>n+(states.has(r.status)?Number(r.total):0),0);
    return page('📊 MNEBYDNS · очередь\n\n'+
      'Ожидают / проверяются / ошибки: '+count(waiting)+'\n'+
      'Работают / покрыты общим маршрутом: '+count(active)+'\n\n'+
      'PENDING означает только запись в базе. Для начала проверки открой карточку '+
      'и нажми «Проверить и включить на 60 минут». Серверный контроллер выполняет задачи по очереди.',[
        [{text:'🟡 Ожидающие',callback_data:'dnsadmin:list:pending:0'}],
        [{text:'🟢 Работающие',callback_data:'dnsadmin:list:active:0'}],
        [{text:'🪟 Microsoft',callback_data:'dnsadmin:microsoft'}],[back]]);
  }catch{return dnsAdminError('Не удалось прочитать состояние очереди.');}
}
export async function dnsAdminMicrosoft(pool:Pool|null,actorId:number,commit=false):Promise<AdminPage>{
  if(!pool)return dnsAdminError('База доменов недоступна. Microsoft не изменён.');
  if(!commit)return page('🪟 Microsoft · все домены из исследования\n\n'+
    MICROSOFT_DOMAINS.join('\n')+'\n\n'+
    'Добавление создаёт заявки PENDING — НЕ включает DNS. '+
    'Microsoft.com и Bing.com — общие адреса; их нельзя переключать без отдельной проверки. '+
    'Уже работающие ACTIVE/COVERED и другие текущие статусы не меняются.',[
      [{text:'➕ Добавить недостающие 6',callback_data:'dnsadmin:microsoft:confirm'}],
      [{text:'📋 Открыть Microsoft и статусы',callback_data:'dnsadmin:list:microsoft:0'}],
      [back]]);
  try{
    // Single idempotent statement. Existing ACTIVE/COVERED/CANARY statuses and
    // ALL route/proxy settings remain untouched. Retag only queued research rows.
    await pool.query(
      `INSERT INTO dns_admin_domains(domain,product,status,requested_by,updated_by)
       SELECT domain,'Microsoft','PENDING',$2,$2 FROM unnest($1::text[]) AS domain
       ON CONFLICT (domain) DO UPDATE SET
         product='Microsoft', updated_at=now(),updated_by=EXCLUDED.updated_by
       WHERE dns_admin_domains.status='PENDING' AND
         dns_admin_domains.product IN ('Research 2026-11','custom','Microsoft')`,
      [MICROSOFT_DOMAINS,actorId]);
    const {rows}=await pool.query<{domain:string;status:string}>(
      'SELECT domain,status FROM dns_admin_domains WHERE domain=ANY($1::text[]) ORDER BY domain',
      [MICROSOFT_DOMAINS]);
    if(rows.length!==MICROSOFT_DOMAINS.length)
      return dnsAdminError('Не удалось подтвердить все шесть записей. Проверь список.');
    return page('✅ Microsoft: записи сверены\n\n'+
      rows.map(r=>r.domain+' — '+(labels[r.status]??r.status)).join('\n')+
      '\n\nPENDING означает, что DNS ещё не переключён. '+
      'Открой нужный домен и запусти контролируемую проверку.',[
       [{text:'🪟 Все 6 и управление',callback_data:'dnsadmin:list:microsoft:0'}],[back]]);
  }catch{return dnsAdminError('Не удалось сохранить Microsoft. Действующий DNS не изменён.');}
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
        [[{text:'🌍 Открыть домен',callback_data:'dnsadmin:domain:'+rows[0].id}],
         [{text:'📋 Все заявки',callback_data:'dnsadmin:list:0'}],[back]]);
    }
    const existing=await pool.query<DomainRow>(
      'SELECT id,domain,product,status FROM dns_admin_domains WHERE domain=$1',[domain]);
    const found=existing.rows[0];
    return page('ℹ️ '+domain+' уже в списке — '+
      (found?(labels[found.status]??found.status):'статус недоступен')+'\n\n'+
      'Новая заявка не создавалась.',
      [[{text:'🌍 Открыть карточку',callback_data:found?'dnsadmin:domain:'+found.id:'dnsadmin:list:0'}],
       [{text:'📋 Все домены',callback_data:'dnsadmin:list:0'}],[back]]);
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
    buttons.push([{text:'🔄 Обновить статус',callback_data:'dnsadmin:domain:'+row.id}]);
    if(row.product==='Microsoft'||(MICROSOFT_DOMAINS as readonly string[]).includes(row.domain))
      buttons.push([{text:'🪟 Все Microsoft',callback_data:'dnsadmin:list:microsoft:0'}]);
    buttons.push([{text:'📋 Все домены',callback_data:'dnsadmin:list:0'}],[back]);
    const expires=row.canary_expires_at instanceof Date
      ?'\nАвтооткат: '+row.canary_expires_at.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК':'';
    const error=row.last_error_code?'\nПоследняя проверка: '+row.last_error_code.slice(0,96):'';
    return page('🌍 '+textRow(row)+expires+error+'\n\n'+
      (row.status==='COVERED'
        ?'Сервер подтвердил работу этого домена через существующее общее правило CoreDNS/Nginx. Отдельный маршрут не создавался, поэтому отключение здесь недоступно, чтобы не затронуть другие сервисы.'
        :row.status==='ACTIVE'
        ?row.last_error_code==='ACTIVE_ROUTE_CHECK_FAILED'
          ?'⚠️ Сервер обнаружил ошибку проверки DNS, закреплённого IP или TLS. Действующий маршрут не менялся. Требуется диагностика; не подтверждай его работоспособность без проверки.'
          :'Маршрут подтверждён. Для отключения нажми кнопку и подтверди действие.'
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
       WHERE id=$1 AND status='CANARY' AND canary_expires_at>now()+interval '10 minutes'
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
  if(action==='dnsadmin:microsoft')return dnsAdminMicrosoft(pool,actorId);
  if(action==='dnsadmin:microsoft:confirm')return page(
    '🪟 Добавить 6 Microsoft в очередь?\n\n'+
    MICROSOFT_DOMAINS.join('\n')+'\n\nНи один из них автоматически не включается. '+
    'Действующие маршруты и статусы сохраняются.',[
      [{text:'✅ Внести в очередь',callback_data:'dnsadmin:yes-microsoft'}],
      [{text:'Отмена',callback_data:'dnsadmin:microsoft'}],[back]]);
  if(action==='dnsadmin:yes-microsoft')return dnsAdminMicrosoft(pool,actorId,true);
  if(action==='dnsadmin:queue')return dnsAdminQueue(pool);
  const view=/^dnsadmin:list:(pending|active|microsoft):(0|[1-9][0-9]{0,1})$/.exec(action);
  if(view)return dnsAdminList(pool,Number(view[2]),view[1] as DomainView);
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
