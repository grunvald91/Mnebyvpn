/** Personal Smart DNS storefront and setup guidance for the authenticated bot.
 * Paid options are supplied ONLY from the published billing_plans table.
 */
import type {Pool} from 'pg';
import {issueTelegramFinnishDns,issueTelegramPersonalDns,rotateTelegramPersonalDns,
  telegramFinnishDnsRevision,telegramPersonalDnsSummary} from '../../../packages/dns-policy/src/personal-dot-telegram.ts';
import {approvedPersonalDnsOffer,PERSONAL_DNS_STARS_OFFERS,
  type DnsPublishedPlan} from '../../../packages/dns-policy/src/smart-dns-offers.ts';

type Button={text:string;callback_data?:string;url?:string;copy_text?:{text:string}};
export type DnsRubPlan={days:number;rubMinor:number};
export type PersonalDnsBotMessage={
  text:string;
  reply_markup:{inline_keyboard:Button[][]};
};
const home:Button={text:'🏠 Главное',callback_data:'nav:home'};
const menu:Button={text:'🧭 Мой Smart DNS',callback_data:'nav:dns'};
const message=(text:string,actions:Button[][]):PersonalDnsBotMessage=>({
  text,reply_markup:{inline_keyboard:[...actions,[home]]},
});
const fmt=(s:string)=>BigInt(s).toLocaleString('ru-RU');
const tariffs=PERSONAL_DNS_STARS_OFFERS
  .map(o=>o.days+' дней — '+o.stars+' ⭐').join('\n');
const quotaText='1 000 000 DNS-запросов на каждые 30 дней; для тарифа на 14 дней — 1 000 000 на его срок.';
const renewText='Если запросы закончились раньше срока, можно купить тариф заново. После активации нового доступа получите новый персональный адрес и файл.';
const guideButtons:Button[][]=[
  [{text:'📱 iPhone / iPad',callback_data:'dns:guide:ios'},
    {text:'🤖 Android',callback_data:'dns:guide:android'}],
  [{text:'📡 Роутер / телевизор',callback_data:'dns:guide:router'},
    {text:'🌐 Сервисы',callback_data:'dns:guide:services'}],
];

export function personalDnsPreview():PersonalDnsBotMessage{
  return message('🧭 Персональный Smart DNS\n\n'+tariffs+
    '\n\n'+quotaText+'\n'+renewText+
    '\n\nТарифы подготовлены. Оплата через бота откроется только после проверки публичного DNS и включения платных планов. VPN не требуется для настройки DNS, но совместимость приложений не гарантируется.',
    guideButtons);
}
export function personalDnsGuide(kind:string):PersonalDnsBotMessage{
  if(kind==='ios')return message(
    '📱 Smart DNS на iPhone и iPad\n\n'+
    '1. После оплаты дождитесь активации и откройте «Мой Smart DNS» → «Получить персональный адрес».\n'+
    '2. Бот пришлёт персональный файл MNEBYDNS-iPhone-iPad.mobileconfig. Сохраните его.\n'+
    '3. Для надёжной установки откройте вложение .mobileconfig из приложения «Почта» (Mail) или скачайте через Safari с доверенной страницы. Если Telegram не открывает профиль для установки, отправьте вложение только на собственную почту и откройте в Mail.\n'+
    '4. Перейдите в «Настройки» → «Профиль загружен» → «Установить» и подтвердите код устройства. Если пункта нет: «Основные» → «VPN и управление устройством».\n'+
    '5. Apple удаляет неустановленный загруженный профиль примерно через 8 минут — при необходимости загрузите его повторно из сохранённого вложения.\n\n'+
    'Профиль персональный: не публикуйте и не пересылайте посторонним. Удаление: «Основные» → «VPN и управление устройством».',
    [[menu],...guideButtons]);
  if(kind==='android')return message(
    '🤖 Smart DNS на Android\n\n'+
    '1. Откройте «Мой Smart DNS» и получите адрес.\n'+
    '2. Настройки → Сеть и интернет (или Подключения) → Частный DNS.\n'+
    '3. Выберите «Имя хоста провайдера частного DNS», вставьте свой адрес целиком и сохраните.\n'+
    '4. При конфликте с VPN или DNS в отдельном браузере используйте штатные настройки приложения.\n\n'+
    'Это DNS-over-TLS, а не VPN. Он не шифрует трафик приложений целиком.',
    [[menu],...guideButtons]);
  if(kind==='router')return message(
    '📡 Роутер, Smart TV и другие устройства\n\n'+
    'Роутер: в настройках DNS нужен именно DNS-over-TLS (DoT) с возможностью указать персональный hostname и проверкой TLS. Обычные поля DNS 1 / DNS 2 (IP-адреса) для персонального имени НЕ подходят.\n\n'+
    'Телевизор, приставка, консоль: если устройство поддерживает DoT, укажите персональный hostname. Иначе можно использовать совместимый роутер с DoT, подключив к нему телевизор. Отдельные приложения могут игнорировать DNS роутера.\n\n'+
    'Не обещаем поддержку любого роутера, телевизора или сервиса: всё зависит от модели, прошивки и сети. Пришлите модель в поддержку для проверки.',
    [[menu],...guideButtons]);
  return message(
    '🌍 Для чего предназначен Smart DNS\n\n'+
    'Подготовленные маршруты: YouTube, ChatGPT, Claude, Grok/X, TikTok, Gemini, Google AI Studio, Oracle Cloud. Фактическая доступность зависит от конкретной сети, устройства и приложения; список не является гарантией работы.\n\n'+
    'Instagram и Threads не заявлены как работающие через Smart DNS. Для ресурсов, требующих полноценный VPN, используйте VPN.\n\n'+
    'Smart DNS меняет разрешение доменов и маршрутизацию отдельных сервисов, но НЕ скрывает весь IP-трафик и не заменяет VPN.',
    [[menu],...guideButtons]);
}
export async function personalDnsTelegramMenu(
  db:Pool,telegramUserId:number,publishedPlans:ReadonlyArray<DnsPublishedPlan>=[],
  rubPlans:ReadonlyArray<DnsRubPlan>=[],regionalEnabled=false,
):Promise<PersonalDnsBotMessage>{
  const status=await telegramPersonalDnsSummary(db,telegramUserId);
  const buy:Button[][]=[];
  const seenDays=new Set<number>();
  for(const o of PERSONAL_DNS_STARS_OFFERS){
    const plan=publishedPlans.find(p=>approvedPersonalDnsOffer(p)?.planId===o.planId)
      ?? publishedPlans.find(p=>p.product==='smart_dns'&&p.stars!==null&&p.stars>0&&
        p.dnsQuotaBytes===null&&p.dnsQuotaQueriesPer30d===1_000_000n&&
        Math.round(p.durationSeconds/86400)===(o.days===14?15:o.days));
    const webDays=o.days===14?15:o.days;
    const rub=rubPlans.find(r=>r.days===webDays);
    const row:Button[]=[];
    if(plan&&plan.planId.length<=53&&plan.stars){
      seenDays.add(webDays);
      row.push({text:'⭐ '+Math.round(plan.durationSeconds/86400)+' дн · '+plan.stars+' Stars',
        callback_data:'buy:stars:'+plan.planId});
    }
    if(rub&&rub.rubMinor>0){
      seenDays.add(webDays);
      row.push({text:'💳 ЮKassa · '+Math.round(rub.rubMinor/100)+' ₽',
        url:'https://mnebyvpn.site/?product=smart_dns&days='+webDays});
    }
    if(row.length)buy.push(row);
  }
  const headline='🧭 Персональный Smart DNS\n\n'+tariffs+
    '\n\n'+quotaText+'\n'+renewText;
  if(!status)return message(headline+
    '\n\nПосле подтверждения оплаты и активации бот выдаст персональный адрес и файл для iPhone/iPad.'+
    (buy.length?'':'\n\nПлатная выдача пока не открыта.'),
    [...buy,...guideButtons]);
  const active=status.state==='ACTIVE'&&status.expiresAt!==null&&
    status.expiresAt.getTime()>Date.now();
  const exhausted=active&&status.accessStatus==='QUOTA_EXHAUSTED';
  const date=status.expiresAt
    ?status.expiresAt.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}):'—';
  const counters=status.queryUsed!==null&&status.queryRemaining!==null&&status.queryLimit!==null
    ?'\nИспользовано: '+fmt(status.queryUsed)+' DNS-запросов'+
      '\nОсталось: '+fmt(status.queryRemaining)+' из '+fmt(status.queryLimit)
    :'\nСчётчик появится после выдачи персонального адреса.';
  const actions:Button[][]=[];
  if(active&&!status.credentialIssued)
    actions.push([{text:regionalEnabled?'🔑 Получить профиль · Германия':'🔑 Получить персональный адрес и файл iOS',
      callback_data:'dns:issue'}]);
  if(active&&status.credentialIssued&&status.credentialRevision!==null)
    actions.push([{text:regionalEnabled?'🔄 Заменить профиль · Германия':'🔄 Заменить адрес и получить новый файл',
      callback_data:'dns:rotate:confirm:'+status.credentialRevision}]);
  const fiRevision=regionalEnabled&&active&&status.credentialIssued
    ?await telegramFinnishDnsRevision(db,telegramUserId):null;
  if(fiRevision!==null)
    actions.push([{text:fiRevision===0?'🔑 Получить профиль · Финляндия':'🔄 Заменить профиль · Финляндия',
      callback_data:'dns:fi:'+(fiRevision===0?'execute':'confirm')+':'+fiRevision}]);
  actions.push(...buy,[{text:'🔁 Обновить статус',callback_data:'nav:dns'}],...guideButtons);
  return message(headline+'\n\n'+
    (exhausted?'⚠️ Лимит запросов исчерпан. Для нового лимита купите ещё один тариф и после активации получите новый адрес.':
      active?'Подписка активна.':'Платные маршруты сейчас неактивны.')+
    '\nДействует до: '+date+counters+
    (fiRevision!==null?'\nГермания и Финляндия расходуют общий лимит этой подписки.':'')+
    (status.credentialIssued
      ?'\n\nАдрес уже выдавался. В базе хранится только его хэш. Сохраните файл; при потере замените персональный адрес.':''),
    actions);
}
type DeliverIosProfile=(hostname:string)=>Promise<boolean>;
async function issuedMessage(
  hostname:string,rotated:boolean,deliver?:DeliverIosProfile,region?:'Германия'|'Финляндия',
):Promise<PersonalDnsBotMessage>{
  let sent=false;
  if(deliver){try{sent=await deliver(hostname);}catch{sent=false;}}
  const delivery=sent
    ?'📎 Файл .mobileconfig отправлен отдельным документом в этот чат.'
    :'⚠️ Автоматическую отправку iOS-файла подтвердить не удалось. Сохраните DNS-адрес ниже. Для повторного выпуска файла потребуется замена адреса в «Мой Smart DNS».';
  return message(
    (region?'✅ Персональный Smart DNS · '+region:
      rotated?'✅ Персональный DNS заменён. Старый адрес отключён.':
      '✅ Ваш персональный Smart DNS:')+
    '\n\n'+hostname+'\n\n'+delivery+
    (region==='Финляндия'?'\nДождитесь обновления допуска на узле, затем подключите этот профиль.':'')+
    '\n\nAndroid: Настройки → Частный DNS → Имя хоста провайдера. Вставьте адрес целиком.\n'+
    'iPhone/iPad: откройте инструкцию ниже и установите файл .mobileconfig через системные настройки.\n\n'+
    'Адрес и профиль — персональные. Не пересылайте посторонним.',
    [[{text:'📋 Скопировать DNS-адрес',copy_text:{text:hostname}}],
     [{text:'📱 Как установить на iPhone',callback_data:'dns:guide:ios'}],
     [{text:'🤖 Android',callback_data:'dns:guide:android'}],[menu]]);
}
export async function personalDnsTelegramAction(
  db:Pool,telegramUserId:number,action:string,deliver?:DeliverIosProfile,regionalEnabled=false,
):Promise<PersonalDnsBotMessage>{
  if(action==='dns:issue'){
    const r=await issueTelegramPersonalDns(db,telegramUserId);
    if(r.kind==='issued')return issuedMessage(r.hostname,false,deliver,regionalEnabled?'Германия':undefined);
    if(r.kind==='already-issued')return message(
      'Адрес уже выдавался и не хранится в открытом виде. Если файл потерян, откройте «Мой Smart DNS» и замените адрес.',
      [[menu]]);
    if(r.kind==='not-active')return message(
      'Подписка ещё не активирована. Когда статус станет активным, здесь можно получить адрес и файл для iPhone.',
      [[menu]]);
    if(r.kind==='revoked')return message('Доступ отозван. Обратитесь в поддержку.',[[menu]]);
    return message('Не удалось выдать адрес. Попробуйте позже.',[[menu]]);
  }
  const regional=/^dns:fi:(confirm|execute):(0|[1-9][0-9]{0,8})$/.exec(action);
  if(regional&&regionalEnabled){
    const revision=Number(regional[2]);
    if(await telegramFinnishDnsRevision(db,telegramUserId)!==revision)
      return message('Финский профиль уже изменён или недоступен. Обновите статус.',[[menu]]);
    if(regional[1]==='confirm')
      return message('Заменить финский профиль? После синхронизации прежний финский адрес отключится. Счётчик запросов сохранится.',
        [[{text:'Подтвердить',callback_data:'dns:fi:execute:'+revision}],[menu]]);
    const result=await issueTelegramFinnishDns(db,telegramUserId,revision);
    if(result.kind==='issued'||result.kind==='rotated')
      return issuedMessage(result.hostname,result.kind==='rotated',deliver,'Финляндия');
    return message('Финский профиль сейчас недоступен. Обновите статус и попробуйте ещё раз.',[[menu]]);
  }
  const match=/^dns:rotate:(confirm|execute):([1-9][0-9]{0,12})$/.exec(action);
  if(!match)return message('Неподдерживаемое действие DNS.',[[menu]]);
  const expectedRevision=Number(match[2]);
  if(!Number.isSafeInteger(expectedRevision))
    return message('Некорректная версия DNS-ключа.',[[menu]]);
  const status=await telegramPersonalDnsSummary(db,telegramUserId);
  if(!status||status.credentialRevision!==expectedRevision||
     !status.credentialIssued||status.state!=='ACTIVE'||
     !status.expiresAt||status.expiresAt.getTime()<=Date.now())
    return message('DNS-адрес уже изменён или подписка недоступна.',[[menu]]);
  if(match[1]==='confirm')return message(
    '⚠️ Замена персонального DNS\n\nСтарый адрес сразу перестанет работать. Нужно установить новый DNS на всех устройствах. Срок подписки и счётчик запросов НЕ обнуляются.',
    [[{text:'🔄 Подтвердить замену',callback_data:'dns:rotate:execute:'+expectedRevision}],
     [{text:'Отмена',callback_data:'nav:dns'}]]);
  const r=await rotateTelegramPersonalDns(db,telegramUserId,expectedRevision);
  if(r.kind==='rotated')return issuedMessage(r.hostname,true,deliver,regionalEnabled?'Германия':undefined);
  return message('Замена не выполнена: адрес уже изменён, отозван или подписка неактивна.',[[menu]]);
}
