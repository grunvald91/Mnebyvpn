/* Public catalog + authenticated account client. No client-side entitlement decisions. */
const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = String(value); };
const state = {
  product: 'bundle', days: 30, plans: [], checkoutEnabled: false, loginEnabled:false,
  loggedIn: false, csrf: '', busy: false, requestId: null, trialOffers: [],
  inviteToken: null, refreshing: false, renewalTargetId: null,
  telegramLoginEnabled:false,emailLoginEnabled:false,emailLinkMode:false,
  trialStatus:'NONE',trialRequestStatus:'NONE',activeTrialProducts:[],trialProduct:'vpn',hasPendingProvisioning:false,lastOrders:[],guestSubscriptionUrl:null,setupLoading:false,
  purchaseIntent:null,telegramProxyBonusEnabled:false,wsProxyEnabled:false,
  appleDnsProfileEnabled:false,personalDnsEnabled:false,paymentProvider:'yookassa',
};
const productNames = { vpn:'VPN Лайт', smart_dns:'Smart Доступ', bundle:'Экосистема «3 в 1»' };
const stateNames = {
  ACTIVE:'Активен', PAID_PENDING_PROVISIONING:'Подключается',
  PENDING_PAYMENT:'Ожидает оплаты', PROVISIONING_FAILED:'Ошибка подключения',
  SUSPENDED:'Приостановлен', EXPIRED:'Истёк', CANCELLED:'Отменён', REFUNDED:'Возврат',
  PENDING:'Ожидает оплаты', PAID:'Оплачен', TRIAL:'Пробный доступ',
};
const formatMoney = n => (Number(n)/100).toLocaleString('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
const formatDate = raw => raw ? new Date(raw).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'}) : 'После активации';
const safeBigInt = value => {
  try { return BigInt(value); } catch { return null; }
};
const fmtBytes = raw => {
  const bytes = safeBigInt(raw);
  if (bytes === null) return '—';
  const mb = Number(bytes) / 1048576;
  if (mb >= 1024) return (mb / 1024).toLocaleString('ru-RU',{maximumFractionDigits:1}) + ' ГБ';
  return mb.toLocaleString('ru-RU',{maximumFractionDigits:1}) + ' МБ';
};
function remaining(seconds) {
  if (seconds === null) return 'После активации';
  if (seconds <= 0) return 'Срок истёк';
  if (seconds < 86400) return Math.max(1,Math.ceil(seconds/3600)) + ' ч';
  return Math.ceil(seconds/86400) + ' дн';
}
function toast(message) {
  const el = byId('toast');
  el.textContent = String(message);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(()=>el.classList.add('hidden'),6500);
}
function checkoutError(message) {
  const el=byId('checkout-error');
  el.textContent=message||'';
  el.classList.toggle('hidden',!message);
}
function showPaymentLink(url) {
  const el=byId('payment-link');
  if(!url){el.removeAttribute('href');el.classList.add('hidden');return;}
  el.href=url;
  el.classList.remove('hidden');
}
function newRequestId() {
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  // Secure, cryptographically random RFC 4122 v4 fallback for older webviews.
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),
    hex.slice(16,20),hex.slice(20)].join('-');
}
async function api(url, options) {
  const response = await fetch(url,{cache:'no-store',credentials:'same-origin',...options});
  const data = await response.json();
  if(!response.ok) {
    const error = new Error(data.code || 'SERVICE_UNAVAILABLE');
    error.status = response.status;
    throw error;
  }
  return data;
}
function validOfferDays(product,days){
  return ['vpn','smart_dns','bundle'].includes(product)&&[15,30,60,90].includes(days);
}
function setSelection(product, days) {
  if (!Object.hasOwn(productNames,product))return;
  if(!validOfferDays(product,days))days=30;
  if (product !== state.product || days !== state.days) {
    state.requestId = null;showPaymentLink(null);checkoutError('');
  }
  if(product!==state.product)state.renewalTargetId=null;
  state.product = product; state.days = days;
  document.querySelectorAll('[data-product]').forEach(btn => {
    const active=btn.dataset.product===product;
    btn.classList.toggle('selected',active);btn.setAttribute('aria-pressed',String(active));
  });
  document.querySelectorAll('[data-days]').forEach(btn => {
    const active=Number(btn.dataset.days)===days;
    btn.classList.toggle('selected',active);btn.setAttribute('aria-pressed',String(active));
  });
  renderPlan();
}
function formatDnsQuota(plan) {
  const raw=plan?.dnsQuotaQueriesPer30d;
  const queries=typeof raw==='string'&&raw.trim()?Number(raw):raw;
  if(!Number.isSafeInteger(queries)||queries<=0)return 'квота не указана';
  return 'до '+queries.toLocaleString('ru-RU')+' DNS-запросов / 30 д';
}
function renderPlan() {
  const plan=state.plans.find(p=>p.product===state.product&&p.durationDays===state.days);
  const webCheckout=Boolean(plan&&state.checkoutEnabled);
  text('selected-plan-name',plan?.title||productNames[state.product]+' · '+state.days+' дней');
  text('selected-duration',state.days+' дней');
  const devices=Number.isSafeInteger(plan?.deviceLimit)&&plan.deviceLimit>0?plan.deviceLimit:null;
  const deviceLimitLabel=devices
    ?(devices===1?'1 устройство':'до '+devices+' устройств')
    :'лимит устройств уточняется';
  text('selected-quota',state.product==='vpn'
    ?'VPN ('+deviceLimitLabel+')'
    :state.product==='smart_dns'
      ?'Smart DNS ('+formatDnsQuota(plan)+') + Telegram-прокси'
      :'Smart DNS + Telegram-прокси + VPN ('+deviceLimitLabel+')');
  text('selected-price',plan?.rubMinor?formatMoney(plan.rubMinor):'—');
  text('price-unit',plan?.rubMinor?'₽ за период':'Цена не опубликована');
  document.querySelectorAll('[data-days]').forEach(button=>{
    button.hidden=!validOfferDays(state.product,Number(button.dataset.days));
  });
  byId('cancel-renewal-button').classList.toggle('hidden',!state.renewalTargetId);
  text('price-description',plan?(state.renewalTargetId?
    'Срок прибавится к выбранному доступу после подтверждения оплаты.':
    state.product==='bundle'
      ? 'Smart DNS и Telegram-прокси дополняют VPN. Доступность и совместная работа зависят от сети, устройства и настроек клиента.'
      : state.product==='smart_dns'
        ? 'Умная маршрутизация сайтов + автоматическая выдача Telegram-прокси и профиля Apple/Android.'
        : 'Базовый защищённый VPN-туннель на 1 устройство.'):
    'Цена пока не опубликована.');
  const buy=byId('buy-button');
  buy.disabled=state.busy||!webCheckout;
  buy.textContent=state.busy?'Создаём заказ…':
    !plan?'Тариф недоступен':
    !state.checkoutEnabled?'Оплата подключается':
    !state.loggedIn?'Войти для оплаты':state.renewalTargetId?'К оплате продления':'Перейти к оплате';
  const trial=byId('trial-button');
  const trialAvailable=(state.trialOffers.includes('bundle')||state.trialOffers.includes('vpn')||state.trialOffers.includes('smart_dns'))&&state.loginEnabled;
  trial.disabled=!trialAvailable||state.busy;
  syncCabinetTrialButton();
  trial.textContent=state.busy?'Проверяем заявку…':
    !state.loginEnabled?'Бесплатный доступ временно недоступен':
    trialAvailable?(state.trialOffers.includes('bundle')?'🎁 Попробовать «3 в 1» бесплатно':(state.loggedIn?'🎁 Получить 24 часа VPN бесплатно':'Войти и получить 24 часа VPN бесплатно')):
    'Бесплатный доступ временно недоступен';
  text('checkout-hint',
    !plan?'Неопубликованные тарифы не продаются.':
    !state.checkoutEnabled?'Онлайн-оплата (ЮKassa) подключается. Платёжные ключи ещё не добавлены.':
    'Разовая оплата через ЮKassa (карта, СБП) без автосписаний. Доступ выдаётся после подтверждения сервером.');
}
function node(tag, cls, content) {
  const el=document.createElement(tag);
  if(cls)el.className=cls;
  if(content!==undefined)el.textContent=String(content);
  return el;
}
function statusLabel(access) {
  if(access.state==='ACTIVE' && access.secondsRemaining===0) return 'Истёк';
  return stateNames[access.state] || access.state;
}

function isAppleDevice(){
  const ua=navigator.userAgent||'';
  return /iPhone|iPad|iPod/i.test(ua)||
    (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)||
    /Mac OS X|Macintosh/i.test(ua);
}
function dnsStorageKey(id,country='DE'){return 'mnebyvpn-dns-cred:'+id+(country==='FI'?':FI':'');}
function readCachedPersonalDns(id,country='DE'){
  try{
    const raw=sessionStorage.getItem(dnsStorageKey(id,country));
    if(!raw)return null;
    const p=JSON.parse(raw);
    if(p&&typeof p.hostname==='string'&&typeof p.mobileconfig==='string')return p;
  }catch{}
  return null;
}
function saveCachedPersonalDns(id,creds,country='DE'){
  try{
    if(creds?.hostname&&creds?.mobileconfig)
      sessionStorage.setItem(dnsStorageKey(id,country),JSON.stringify({
        hostname:creds.hostname,mobileconfig:creds.mobileconfig,revision:creds.revision,savedAt:Date.now(),
      }));
  }catch{}
}
function clearCachedCredentials(){
  try{
    for(let i=sessionStorage.length-1;i>=0;i--){
      const k=sessionStorage.key(i);
      if(k&&(k.startsWith('mnebyvpn-dns-cred:')||k.startsWith('mnebyvpn-proxy-cred:')))
        sessionStorage.removeItem(k);
    }
  }catch{}
}
function triggerMobileconfigDownload(xml){
  const blob=new Blob([xml],{type:'application/x-apple-aspen-config'});
  if(blob.size<200||blob.size>32768)throw Error('DNS_PROFILE_UNAVAILABLE');
  const url=URL.createObjectURL(blob);
  const link=node('a');
  link.href=url;
  link.download='MNEBYDNS-Apple.mobileconfig';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return url;
}
function renderPersonalDnsBox(item,hostname,xml,opts={}){
  if(!item)return;
  const previous=Array.from(item.children).find(child=>child.classList.contains('dns-personal-credentials'));
  if(previous)previous.remove();
  const box=node('section','dns-personal-credentials');
  const apple=opts.isApple??isAppleDevice();
  const hasCreds=Boolean(hostname||xml);
  const country=opts.country==='FI'?'FI':'DE';
  box.append(node('h4','',(hasCreds?'✅ Smart DNS · ':'🧭 Smart DNS · ')+(country==='FI'?'Финляндия':'Германия')));
  if(xml){
    const dl=node('button','button button-primary setup-button',
      apple?'⬇️ Скачать профиль Apple (.mobileconfig)':'Скачать профиль для iPhone / Mac (.mobileconfig)');
    dl.type='button';
    dl.addEventListener('click',()=>triggerMobileconfigDownload(xml));
    box.append(dl);
    box.append(node('p','',
      'Установка на Apple (iPhone, iPad, Mac): откройте страницу в Safari и нажмите кнопку выше → разрешите загрузку профиля → откройте «Настройки» → «Профиль загружен» → «Установить» (или «Основные» → «VPN и управление устройством»). На Mac — «Системные настройки» → «Основные» → «Управление устройством». Неустановленный профиль удаляется системой через 8 минут.'));
  }
  if(hostname){
    const row=node('div','journey-copy-field');
    const input=node('input');
    input.type='text';
    input.readOnly=true;
    input.value=hostname;
    input.setAttribute('aria-label','Личный адрес Private DNS (DoT)');
    const copyBtn=node('button','','Копировать DoT');
    copyBtn.type='button';
    copyBtn.addEventListener('click',async()=>{
      try{
        await navigator.clipboard.writeText(hostname);
        toast('Персональный DoT-адрес скопирован.');
      }catch{
        input.focus();input.select();
        toast('Скопируйте выделенный DoT-адрес.');
      }
    });
    row.append(input,copyBtn);
    box.append(node('h4','',apple?'Также работает на Android и роутере (DoT)':'Android и роутер (Private DNS / DoT)'));
    box.append(row);
    box.append(node('p','',
      'Android 9+: Настройки → Сеть и интернет (или Подключения) → Персональный DNS-сервер → Имя хоста провайдера → вставьте адрес целиком → Сохранить. Включать VPN постоянно не нужно.'));
    box.append(node('p','',
      'Роутер / Smart TV: укажите этот hostname в разделе DNS-over-TLS (DoT). Обычные поля IP DNS1/DNS2 не поддерживают персональное имя.'));
  }
  if(!hasCreds&&opts.issued&&opts.entitlementId){
    box.append(node('p','',
      'Персональный DoT-адрес и профиль Apple уже выпускались ранее в другой сессии (в базе хранится только хеш). Нажмите ниже, чтобы перевыпустить новый адрес и скачать новый файл .mobileconfig — старый адрес при этом отключится.'));
    const rotateBtn=node('button','button button-secondary setup-button','🔄 Перевыпустить адрес и профиль (.mobileconfig)');
    rotateBtn.type='button';
    rotateBtn.addEventListener('click',()=>void downloadAppleDnsProfile(opts.entitlementId,rotateBtn,item,country,opts.singleCountry===true));
    box.append(rotateBtn);
  }
  item.append(box);
  if(country==='DE'&&opts.entitlementId&&!opts.singleCountry){
    box.append(node('p','','Если Smart DNS и VPN включены одновременно, выбирайте одну страну для обеих услуг: Германия с Германией, Финляндия с Финляндией. Иначе возможны проблемы с подключением и загрузкой сервисов.'));
    const fiBox=node('section','dns-country-fi');
    const fiButton=node('button','button button-secondary setup-button','Получить профиль · Финляндия');
    fiButton.type='button';
    fiButton.hidden=true;
    fiButton.addEventListener('click',()=>downloadAppleDnsProfile(opts.entitlementId,fiButton,fiBox,'FI'));
    fiBox.append(fiButton);
    box.append(fiBox);
    api('/api/dns/apple/status?entitlementId='+encodeURIComponent(opts.entitlementId)+'&country=FI').then(status=>{
      if(status.revoked||!fiBox.isConnected)return;
      fiButton.hidden=status.issued;
      fiButton.textContent='Получить профиль · Финляндия';
      const fi=readCachedPersonalDns(opts.entitlementId,'FI');
      if(status.issued&&fi?.revision===status.revision)
        renderPersonalDnsBox(fiBox,fi.hostname,fi.mobileconfig,{entitlementId:opts.entitlementId,issued:true,country:'FI'});
      else if(status.issued)renderPersonalDnsBox(fiBox,'','',{entitlementId:opts.entitlementId,issued:true,country:'FI'});
      fiBox.append(node('p','','Германия и Финляндия используют общий лимит DNS-запросов.'));
    }).catch(()=>{});
  }
}
const dnsCredInFlight=new Map();
async function ensurePersonalDnsCredentials(entitlementId,opts={}){
  if(!state.loggedIn||!(state.personalDnsEnabled||state.appleDnsProfileEnabled))return null;
  const cached=readCachedPersonalDns(entitlementId);
  const targets=(opts.targets||[]).filter(Boolean);
  if(dnsCredInFlight.has(entitlementId))return dnsCredInFlight.get(entitlementId).then(result=>{
    if(result?.hostname)for(const t of targets)renderPersonalDnsBox(t,result.hostname,result.mobileconfig,{entitlementId,issued:true});
    else if(result?.issued)for(const t of targets)renderPersonalDnsBox(t,'','',{entitlementId,issued:true});
    return result;
  });
  const job=(async()=>{
    const status=await api('/api/dns/apple/status?entitlementId='+encodeURIComponent(entitlementId));
    if(status.revoked)return null;
    if(status.issued&&cached?.revision===status.revision){
      for(const t of targets)renderPersonalDnsBox(t,cached.hostname,cached.mobileconfig,{entitlementId,issued:true});
      return cached;
    }
    if(!status.issued&&opts.autoIssue){
      const payload=JSON.stringify({action:'issue',entitlementId});
      const res=await fetch('/api/dns/personal/credentials',{
        method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
        headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
        body:payload,
      });
      if(res.ok){
        const creds=await res.json();
        creds.revision=1;
        saveCachedPersonalDns(entitlementId,creds);
        for(const t of targets)renderPersonalDnsBox(t,creds.hostname||'',creds.mobileconfig||'',{entitlementId,issued:true});
        return creds;
      }
    }
    if(status.issued){
      for(const t of targets)renderPersonalDnsBox(t,'','',{entitlementId,issued:true});
    }
    return {issued:status.issued,revision:status.revision};
  })().finally(()=>dnsCredInFlight.delete(entitlementId));
  dnsCredInFlight.set(entitlementId,job);
  return job;
}
async function downloadAppleDnsProfile(entitlementId, button, item,country='DE',singleCountry=false){
  if(!state.loggedIn||button.disabled)return;
  button.disabled=true;
  try{
    const status=await api('/api/dns/apple/status?entitlementId='+encodeURIComponent(entitlementId)+(country==='FI'?'&country=FI':''));
    if(status.revoked)throw Error('DNS_ACCESS_REVOKED');
    const cached=readCachedPersonalDns(entitlementId,country);
    if(cached?.mobileconfig&&status.issued&&cached.revision===status.revision){
      triggerMobileconfigDownload(cached.mobileconfig);
      if(item)renderPersonalDnsBox(item,cached.hostname,cached.mobileconfig,{entitlementId,issued:true,country,singleCountry});
      toast('Профиль Apple (.mobileconfig) загружен.');
      return;
    }
    let action='issue';
    if(status.issued){
      if(!Number.isSafeInteger(status.revision)||status.revision<1)
        throw Error('DNS_PROFILE_UNAVAILABLE');
      const confirmed=window.confirm(
        'Персональный DNS-профиль уже выдавался. В целях безопасности прежний адрес не хранится. '+
        'Для выпуска нового профиля и DoT-адреса придётся заменить прежний: старая конфигурация этой страны перестанет работать '+
        'на всех устройствах. Продолжить?');
      if(!confirmed)return;
      action='rotate';
    }
    const payload=JSON.stringify({action,entitlementId,...(country==='FI'?{country}:{}),
      ...(action==='rotate'?{expectedRevision:status.revision}:{})});
    const reqInit={
      method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:payload,
    };
    const combined=await fetch('/api/dns/personal/credentials',reqInit);
    if(combined.ok){
      const creds=await combined.json();
      creds.revision=action==='rotate'?status.revision+1:1;
      saveCachedPersonalDns(entitlementId,creds,country);
      if(creds?.mobileconfig)triggerMobileconfigDownload(creds.mobileconfig);
      if(item&&(creds?.hostname||creds?.mobileconfig))
        renderPersonalDnsBox(item,creds.hostname||'',creds.mobileconfig||'',{entitlementId,issued:true,country,singleCountry});
      if(country==='FI')button.hidden=true;
      toast('Smart DNS создан: профиль .mobileconfig загружен, адрес DoT показан в карточке.');
      return;
    }
    if(combined.status!==404||country==='FI'){
      const problem=await combined.json().catch(()=>({code:'DNS_PROFILE_UNAVAILABLE'}));
      throw Error(problem.code||'DNS_PROFILE_UNAVAILABLE');
    }
    const response=await fetch('/api/dns/apple/profile',reqInit);
    if(!response.ok){
      const problem=await response.json().catch(()=>({code:'DNS_PROFILE_UNAVAILABLE'}));
      throw Error(problem.code||'DNS_PROFILE_UNAVAILABLE');
    }
    if(!(response.headers.get('content-type')||'').includes('application/x-apple-aspen-config'))
      throw Error('DNS_PROFILE_UNAVAILABLE');
    const xml=await response.text();
    triggerMobileconfigDownload(xml);
    if(item)renderPersonalDnsBox(item,'',xml,{entitlementId,issued:true,country,singleCountry});
    toast('Профиль создан. Сохраните файл. На iPhone/iPad откройте Настройки → Профиль загружен; на Mac — Системные настройки → Основные → Управление устройством.');
  }catch(error){
    const messages={
      DNS_PROFILE_ALREADY_ISSUED:'Профиль уже выпускался. Обновите кабинет и подтвердите замену адреса.',
      DNS_PROFILE_REVISION_CHANGED:'DNS-адрес уже изменён на другом устройстве. Обновите страницу.',
      DNS_ACCESS_NOT_ACTIVE:'DNS-подписка неактивна или оплата не подтверждена.',
      DNS_ACCESS_REVOKED:'Этот DNS-доступ отозван.',
      APPLE_DNS_PROFILE_NOT_READY:'Выдача профилей Smart DNS пока не включена.',
    };
    toast(messages[error.message]||'Не удалось получить профиль Smart DNS. Повторите попытку или обратитесь в поддержку.');
  }finally{button.disabled=false;}
}

const proxyCredCache=new Map();
function renderProxyBonusBox(item,data){
  if(!item)return;
  const wsLinks=Array.isArray(data?.wsLinks)?data.wsLinks:[];
  const mtLinks=Array.isArray(data?.links)?data.links:[];
  if(!wsLinks.length&&!mtLinks.length)return;
  const previous=item.querySelector('.dns-proxy-bonus-links');
  if(previous)previous.remove();
  const container=node('section','dns-proxy-bonus-links');
  if(wsLinks.length){
    container.append(node('h4','','✈️ Telegram-прокси через WebSocket (HTTPS :443)'));
    container.append(node('p','',
      'Работает поверх защищённого HTTPS/WebSocket параллельно со Smart DNS — отключать DNS не нужно.'));
    for(const link of wsLinks){
      let targetUrl=null;
      try{
        const u=new URL(String(link.url||''));
        if(u.protocol==='https:'&&u.hostname==='t.me'&&u.pathname==='/webproxy')targetUrl=u.href;
      }catch{}
      let tgTarget=null;
      try{
        const t=new URL(String(link.tgUrl||''));
        if(t.protocol==='tg:'&&t.hostname==='webproxy')tgTarget=t.href;
      }catch{}
      if(!targetUrl&&!tgTarget)continue;
      const row=node('div','dns-proxy-bonus-route');
      row.append(node('strong','',link.label||'WebSocket-прокси для Telegram'));
      row.append(node('div','',String(link.server||'')));
      const anchor=node('a','button button-primary','Подключить в Telegram');
      anchor.href=tgTarget||targetUrl;
      if(!tgTarget){anchor.target='_blank';anchor.rel='noopener noreferrer';}
      anchor.referrerPolicy='no-referrer';
      row.append(anchor);
      if(targetUrl&&tgTarget){
        const webAnchor=node('a','button button-secondary','Ссылка t.me');
        webAnchor.href=targetUrl;webAnchor.target='_blank';
        webAnchor.rel='noopener noreferrer';webAnchor.referrerPolicy='no-referrer';
        row.append(webAnchor);
      }
      const manual=node('button','button button-secondary','Скопировать сервер и секрет');
      manual.type='button';
      manual.addEventListener('click',async()=>{
        const txt='Сервер (WEB-прокси / WebSocket): '+String(link.server||'')+
          '\nСекрет: '+String(link.secret||'')+
          (tgTarget?'\nСсылка: '+tgTarget:'');
        try{
          await navigator.clipboard.writeText(txt);
          toast('Параметры WebSocket-прокси скопированы.');
        }catch{toast('Копирование недоступно. Используйте кнопку подключения.');}
      });
      row.append(manual);
      container.append(row);
    }
    container.append(node('h4','','Как включить WebSocket-прокси'));
    container.append(node('p','',
      '1. Нажмите «Подключить в Telegram» на нужном устройстве и подтвердите добавление прокси. '+
      '2. Если кнопка не открывает клиент автоматически, скопируйте параметры и в Telegram откройте Настройки → Данные и память → Прокси (в Telegram Desktop: Продвинутые → Тип соединения) → выберите WEB-прокси / WebSocket и вставьте сервер и секрет.'));
  }
  if(mtLinks.length){
    container.append(node('h4','',wsLinks.length?'Резервный MTProto-прокси':'Ваш Telegram-прокси · бесплатно с DNS'));
    for(const link of mtLinks){
      if(!['direct','ru'].includes(link.route))continue;
      const address=node('div','',link.host+':'+link.port);
      const header=node('strong','',link.route==='direct'?'Напрямую через зарубежный сервер':'Через российский сервер');
      const anchor=node('a','button button-secondary','Подключить MTProto');
      let target=null;
      try{target=new URL(link.url);}catch{}
      if(!target||target.protocol!=='https:'||target.hostname!=='t.me'||target.pathname!=='/proxy')continue;
      anchor.href=target.href;
      anchor.target='_blank';
      anchor.rel='noopener noreferrer';
      anchor.referrerPolicy='no-referrer';
      const manual=node('button','button button-secondary','Скопировать адрес, порт и секрет');
      manual.type='button';
      manual.addEventListener('click',async()=>{
        const secret=target.searchParams.get('secret')||'';
        if(!/^(ee)?[a-f0-9]{32,512}$/i.test(secret))return;
        try{
          await navigator.clipboard.writeText('Сервер: '+link.host+'\nПорт: '+link.port+
            '\nТип: MTProto\nСекрет: '+secret);
          toast('Данные Telegram-прокси скопированы.');
        }catch{toast('Копирование недоступно в этом браузере. Откройте ссылку подключения.');}
      });
      const row=node('div','dns-proxy-bonus-route');
      row.append(header,address,anchor,manual);
      container.append(row);
    }
  }
  item.append(container);
}
// The free shared proxy is not an entitlement and survives trial expiration.
// Render it outside VPN/DNS cards and clear it on logout/account changes.
let trialCountry='DE';
let trialCountryOrder=null;
function renderSharedTrialProxy(data,accesses=[]){
  const active=accesses.filter(a=>a.state==='ACTIVE'&&a.secondsRemaining>0);
  const order=state.lastOrders.find(o=>o.state==='TRIAL'&&o.product==='bundle'&&
    ['vpn','smart_dns'].every(p=>active.some(a=>a.sourceOrderId===o.id&&a.product===p)));
  if(order&&trialCountryOrder!==order.id){
    trialCountryOrder=order.id;
    trialCountry=new URLSearchParams(location.search).get('trialCountry')==='FI'?'FI':'DE';
  }
  if(!order){trialCountryOrder=null;trialCountry='DE';}
  for(const id of ['cabinet-shared-trial-proxy','journey-shared-trial-proxy']){
    const slot=byId(id);
    if(!slot)continue;
    slot.replaceChildren();
    const shared=Array.isArray(data?.wsLinks)?data.wsLinks:[];
    const regional=Array.isArray(data?.regionalLinks)?data.regionalLinks:[];
    slot.hidden=!order&&!shared.length&&!regional.length;
    if(slot.hidden)continue;
    if(order){
      const vpn=active.find(a=>a.sourceOrderId===order.id&&a.product==='vpn');
      const dns=active.find(a=>a.sourceOrderId===order.id&&a.product==='smart_dns');
      const name=trialCountry==='FI'?'Финляндия':'Германия';
      slot.append(node('h3','','Пробный доступ «3 в 1» · '+name),
        node('p','','Выберите одну страну для VPN, Smart DNS и Telegram-прокси. Переключение не продлевает 24 часа и не сбрасывает общий лимит 30 000 DNS-запросов. VPN — одно одновременное подключение.'));
      for(const country of ['DE','FI']){
        const b=node('button','button '+(country===trialCountry?'button-primary':'button-secondary'),country==='DE'?'🇩🇪 Германия':'🇫🇮 Финляндия');
        b.type='button';b.setAttribute('aria-pressed',String(country===trialCountry));
        b.addEventListener('click',()=>{trialCountry=country;renderSharedTrialProxy(data,accesses);});
        slot.append(b);
      }
      const selected=trialCountry;
      const v=node('button','button button-secondary setup-button','VPN · '+name);
      v.type='button';v.disabled=selected==='FI'&&!state.fiAwgRegistrationAvailable;
      v.addEventListener('click',()=>{if(selected==='FI')location.href='/awg/setup?entitlementId='+encodeURIComponent(vpn.id);else void loadSubscription(vpn.id);});
      slot.append(v);
      if(v.disabled)slot.append(node('p','','VPN выбранной страны пока недоступен.'));
      const dnsPanel=node('section','trial-country-dns');
      const d=node('button','button button-secondary setup-button','Smart DNS · '+name);
      d.type='button';d.disabled=true;
      const info=node('p','','Проверяем доступность профиля…');
      dnsPanel.append(d,info);slot.append(dnsPanel);
      if(state.personalDnsEnabled||state.appleDnsProfileEnabled){
        api('/api/dns/apple/status?entitlementId='+encodeURIComponent(dns.id)+(selected==='FI'?'&country=FI':'')).then(status=>{
          if(!dnsPanel.isConnected)return;
          if(status.revoked){info.textContent='Профиль отозван.';return;}
          const cached=readCachedPersonalDns(dns.id,selected);
          d.disabled=false;info.textContent='Получите адрес DoT и файл Apple. При смене страны старый профиль не заменяется автоматически.';
          d.addEventListener('click',()=>void downloadAppleDnsProfile(dns.id,d,dnsPanel,selected,true));
          if(status.issued&&cached?.revision===status.revision)renderPersonalDnsBox(dnsPanel,cached.hostname,cached.mobileconfig,{entitlementId:dns.id,issued:true,country:selected,singleCountry:true});
        }).catch(()=>{if(dnsPanel.isConnected)info.textContent='Профиль выбранной страны пока недоступен. Обновите кабинет.';});
      }else info.textContent='Выдача Smart DNS пока недоступна.';
      const matches=regional.filter(link=>link.country===selected);
      if(matches.length)renderProxyBonusBox(slot,{wsLinks:matches});
      else slot.append(node('p','','Подтверждённый Telegram-прокси для этой страны пока недоступен.'));
      slot.append(node('p','','Выбор здесь показывает настройки. Переключите VPN, DNS-профиль и прокси на устройстве вручную; сначала отключите предыдущий VPN.'));
    }else if(regional.length){
      renderProxyBonusBox(slot,{wsLinks:regional});
    }
    if(shared.length){
      const fallback=node('details','trial-shared-proxy-fallback');
      fallback.append(node('summary','','Общие Telegram-прокси · бесплатно без ограничения срока'),
        node('p','','Эти ссылки остаются доступны после пробных суток. Страна выхода не подтверждена для выбора выше.'));
      renderProxyBonusBox(fallback,{wsLinks:shared});
      slot.append(fallback);
    }
  }
}
async function ensureProxyCredentials(entitlementId,targets=[]){
  if(!state.loggedIn||!state.telegramProxyBonusEnabled)return null;
  const cached=proxyCredCache.get(entitlementId);
  const validTargets=targets.filter(Boolean);
  if(cached){
    for(const t of validTargets)renderProxyBonusBox(t,cached);
    return cached;
  }
  const data=await api('/api/telegram-proxy-bonus?entitlementId='+encodeURIComponent(entitlementId));
  const hasAny=(Array.isArray(data?.wsLinks)&&data.wsLinks.length>0)||(Array.isArray(data?.links)&&data.links.length>0);
  if(!hasAny)throw Error('PROXY_BONUS_NOT_READY');
  proxyCredCache.set(entitlementId,data);
  for(const t of validTargets)renderProxyBonusBox(t,data);
  return data;
}
async function loadTelegramProxyBonus(entitlementId, button, item) {
  if(!state.loggedIn||button?.disabled)return;
  if(button)button.disabled=true;
  try {
    await ensureProxyCredentials(entitlementId,[item]);
  }catch(error){
    toast(error.message==='PROXY_BONUS_NOT_ASSIGNED'?
      'Прокси ещё не выдан. Обратитесь в поддержку, если DNS уже активен.':
      'Не удалось получить Telegram-прокси. Попробуйте позже.');
  }finally{if(button)button.disabled=false;}
}

function syncCabinetTrialButton(){
  const retry=byId('cabinet-trial-retry');
  if(!retry)return;
  retry.hidden=!state.loggedIn||!(state.trialOffers.includes('bundle')||state.trialOffers.includes('vpn'))||
    ['PENDING','WAITING','SENT'].includes(state.trialRequestStatus);
  retry.disabled=state.busy||retry.hidden;
}
function renderAccess(accesses) {
  const list=byId('access-list');
  list.replaceChildren();
  if(!accesses.length) {
    const empty=node('div','empty');
    if(['PENDING','WAITING'].includes(state.trialRequestStatus)){
      empty.append(node('p','','Заявка на бесплатный доступ сохранена. Продолжаем подключение автоматически; когда доступ будет готов, отправим письмо на вашу почту.'));
      list.append(empty);return;
    }
    if(state.trialRequestStatus==='UNKNOWN'){
      empty.append(node('p','','Не удалось проверить статус бесплатного доступа. Повторим проверку.'));
    }else{
      empty.append(node('p','','Пока нет активных подписок.'));
    }
    const retry=node('button','button button-primary',state.trialOffers.includes('bundle')?'Попробовать «3 в 1» бесплатно':'Получить бесплатный VPN на 24 часа');
    retry.type='button';retry.id='cabinet-trial-retry';
    retry.addEventListener('click',()=>{state.trialProduct=state.trialOffers.includes('bundle')?'bundle':'vpn';void claimTrial();});
    empty.append(retry);
    const goPlans=node('a','button button-primary','Выбрать тариф');
    goPlans.href='/#plans';
    empty.append(goPlans);
    list.append(empty);
    syncCabinetTrialButton();
    return;
  }
  for(const a of accesses) {
    const item=node('article','access-item');
    const top=node('div','access-top');
    const h=node('h4','',productNames[a.product] || a.product);
    const effective=a.state==='ACTIVE' && a.secondsRemaining===0?'EXPIRED':a.state;
    const badge=node('span','status '+(effective==='ACTIVE'?'active':
      effective.includes('PENDING')?'pending':'expired'),statusLabel(a));
    top.append(h,badge);
    const accessDetail=['REFUNDED','CANCELLED'].includes(a.state)
      ? 'Доступ отозван. При возврате платежа оплаченные продления учитываются отдельно.'
      : a.state==='EXPIRED' || (a.expiresAt && a.secondsRemaining===0)
        ? 'Срок закончился'+(a.expiresAt?' '+formatDate(a.expiresAt):'')+'.'
        : a.expiresAt
          ? 'До '+formatDate(a.expiresAt)+' · Осталось: '+remaining(a.secondsRemaining)
          : 'Срок начнётся после подтверждённой активации.';
    item.append(top,node('p','',accessDetail));
    if (a.product==='smart_dns') {
      const dnsCap=a.dnsQueryQuotaPer30d
        ? 'Пакет Smart DNS: до ' + Number(a.dnsQueryQuotaPer30d).toLocaleString('ru-RU') + ' запросов / 30 дн'
        : a.quotaLimitBytes
          ? 'Пакет DNS: ' + fmtBytes(a.quotaLimitBytes)
          : 'DNS-квота пока не установлена';
      item.append(node('p','',dnsCap));
      if (a.meteringVerified && a.quotaUsedBytes!==null && a.quotaRemainingBytes!==null) {
        const used=safeBigInt(a.quotaUsedBytes),limit=safeBigInt(a.quotaLimitBytes);
        const pct=(used!==null && limit!==null && limit>0n)?
          Math.max(0,Math.min(100,Number(used*100n/limit))):0;
        const box=node('div','usage');
        const track=node('div','usage-track');
        const fill=node('div','usage-fill');
        fill.style.width=pct+'%';
        track.append(fill);
        const totals=node('div','usage-info');
        totals.append(node('span','','Израсходовано: '+fmtBytes(a.quotaUsedBytes)),
          node('span','','Осталось: '+fmtBytes(a.quotaRemainingBytes)));
        box.append(track,totals);item.append(box);
      }
    }
    if(a.product==='smart_dns'&&a.state==='ACTIVE'&&
       a.secondsRemaining!==null&&a.secondsRemaining>0&&
       (state.personalDnsEnabled||state.appleDnsProfileEnabled)){
      const apple=node('button','button button-secondary setup-button','Получить профиль · Германия');
      apple.type='button';
      apple.addEventListener('click',()=>downloadAppleDnsProfile(a.id,apple,item));
      item.append(apple,node('p','','Персональный конфиг для iPhone / iPad / macOS и DoT-адрес для Android и роутера. Повторный выпуск заменит прежний адрес выбранной страны на всех устройствах.'));
      void ensurePersonalDnsCredentials(a.id,{targets:[item]}).catch(()=>{});

    }
    const isTrialOrder=Boolean(state.lastOrders?.some(o=>o.id===a.sourceOrderId&&o.state==='TRIAL'));
    if(!isTrialOrder&&a.product==='smart_dns'&&a.state==='ACTIVE'&&
       a.secondsRemaining!==null&&a.secondsRemaining>0&&state.telegramProxyBonusEnabled){
      const open=node('button','button button-secondary setup-button','Telegram-прокси (WebSocket)');
      open.type='button';
      open.addEventListener('click',()=>loadTelegramProxyBonus(a.id,open,item));
      item.append(open);
      const cachedProxy=proxyCredCache.get(a.id);
      if(cachedProxy)renderProxyBonusBox(item,cachedProxy);
    }
    if(a.product==='vpn' &&
       a.state==='ACTIVE' && a.secondsRemaining!==null && a.secondsRemaining>0){
      const setup=node('button','button button-secondary setup-button','Подключить VPN');
      setup.type='button';
      setup.addEventListener('click',()=>loadSubscription(a.id));
      item.append(setup);
      if(state.fiAwgRegistrationAvailable===true){
        const fi=node('button','button button-secondary setup-button',
          '🇫🇮 Финляндия · AmneziaWG');
        fi.type='button';
        fi.addEventListener('click',()=>{
          window.location.href='/awg/setup?entitlementId='+encodeURIComponent(a.id);
        });
        item.append(fi);
      }
    }
    const bundleTrial=Boolean(state.lastOrders?.some(o=>o.id===a.sourceOrderId&&o.state==='TRIAL'&&o.product==='bundle'));
    const durations=state.plans.filter(p=>p.product===(bundleTrial?'bundle':a.product));
    if (durations.length && a.startsAt && a.expiresAt &&
      !['REFUNDED','CANCELLED','PENDING_PAYMENT'].includes(a.state)) {
      const renew=node('button','button button-secondary renew-button',bundleTrial?'Купить «3 в 1» ↗':'Продлить доступ ↗');
      renew.type='button';
      renew.addEventListener('click',()=>{
        const preferred=durations.find(p=>p.durationDays===30)||durations[0];
        setSelection(bundleTrial?'bundle':a.product,preferred.durationDays);
        state.renewalTargetId=bundleTrial?null:a.id;
        state.requestId=null;
        renderPlan();
        if(typeof window!=='undefined'&&window.MnebyvpnJourney)
          window.MnebyvpnJourney.show('plans',true);
        else byId('plans').scrollIntoView({behavior:'smooth'});
      });
      item.append(renew);
    }
    list.append(item);
  }
}
function renderOrders(orders) {
  const list=byId('orders-list');
  list.replaceChildren();
  if (!orders.length) {list.append(node('div','empty','Здесь появится история заказов.'));return;}
  for (const o of orders) {
    const row=node('article','order-item');
    const left=node('div');
    left.append(node('strong','',o.title||productNames[o.product]||'Пробный доступ'));
    left.append(node('p','',formatDate(o.createdAt)+' · '+(stateNames[o.state]||o.state)));
    const amount=o.state==='TRIAL'?'Бесплатно':
      o.currency==='RUB'?formatMoney(o.amountMinor):String(o.amountMinor)+' ⭐';
    row.append(left,node('div','order-price',amount));list.append(row);
  }
}

function readPurchaseIntent() {
  try {
    const raw=sessionStorage.getItem('mnebyvpn-purchase-intent');
    const parsed=raw?JSON.parse(raw):null;
    return parsed && typeof parsed.orderId==='string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.orderId)?parsed:null;
  } catch {return null;}
}
function renderPurchaseResult(payload) {
  const notice=byId('purchase-result');
  const intent=state.purchaseIntent||readPurchaseIntent();
  const order=intent && (payload.orders||[]).find(o=>o.id===intent.orderId);
  if(!order || order.provider==='internal_trial') {
    notice.classList.add('hidden');
    return;
  }
  const accesses=(payload.access||[]).filter(a=>
    (order.product==='bundle'?(a.product==='vpn'||a.product==='smart_dns'):a.product===order.product) &&
    (a.sourceOrderId===order.id ||
      (intent.renewalTargetId && a.id===intent.renewalTargetId)));
  const vpnAccess=accesses.find(a=>a.product==='vpn'&&a.state==='ACTIVE'&&a.secondsRemaining>0);
  const dnsAccess=accesses.find(a=>a.product==='smart_dns'&&a.state==='ACTIVE'&&a.secondsRemaining>0);
  const verified=order.state==='PAID';
  const dnsReady=Boolean(dnsAccess&&(state.personalDnsEnabled||state.appleDnsProfileEnabled));
  const ready=verified && (
    order.product==='vpn'?Boolean(vpnAccess):
    order.product==='smart_dns'?dnsReady:
    Boolean(vpnAccess||dnsReady)
  );
  notice.classList.remove('hidden');
  text('purchase-result-title',!verified?
    (order.state==='PENDING'?'⏳ Проверяем оплату':
      'Состояние заказа: '+(stateNames[order.state]||order.state)):
    ready?(order.product==='smart_dns'?'✅ Ваш Smart Доступ активен!':
      order.product==='bundle'?'✅ Экосистема «3 в 1» активна!':'✅ Ваш VPN готов!'):'✅ Оплата подтверждена');
  text('purchase-result-text',!verified?
    'Пока нет подтверждения оплаты. Если деньги списаны, не оплачивайте повторно — проверьте статус или напишите в поддержку.':
    ready?(order.product==='smart_dns'?'Скачайте профиль Apple (.mobileconfig), скопируйте DoT-адрес для Android/роутера и подключите Telegram-прокси в карточке подписки ниже.':
      order.product==='bundle'?'Подключите VPN (до 3 устройств) и откройте Smart DNS + Telegram-прокси в карточках доступа ниже.':
      'Подключите VPN в несколько нажатий. Выберите приложение для своего устройства.'):
    'Деньги получены. Доступ появится после подтверждения серверной активации.');
  text('purchase-result-details',
    (order.title||productNames[order.product]||'VPN')+
    ' · '+(order.currency==='RUB'?formatMoney(order.amountMinor):String(order.amountMinor)+' ⭐'));
  const connect=byId('purchase-connect');
  const primaryEntitlement=vpnAccess||dnsAccess;
  connect.classList.toggle('hidden',!ready||!primaryEntitlement);
  connect.dataset.entitlementId=ready&&primaryEntitlement?primaryEntitlement.id:'';
  connect.dataset.product=ready&&primaryEntitlement?primaryEntitlement.product:'';
  connect.textContent=ready&&primaryEntitlement?.product==='smart_dns'
    ? 'Скачать профиль Smart DNS'
    : '🔌 Подключить VPN';
  byId('purchase-refresh').classList.toggle('hidden',ready);
}
let lastVerifyAt=0;
let verifyInFlight=false;
async function verifyPendingOrderIfNeeded(payload){
  if(!state.loggedIn||!state.csrf||verifyInFlight)return;
  const intent=state.purchaseIntent||readPurchaseIntent();
  const url=new URL(location.href);
  const returned=['returned','return'].includes(url.searchParams.get('payment')||'') ||
    url.pathname==='/payment/success' || url.pathname==='/payment/return';
  const candidate=(payload.orders||[]).find(o=>
    o.state==='PENDING'&&o.provider==='yookassa'&&(!intent||o.id===intent.orderId)) ||
    (returned?(payload.orders||[]).find(o=>o.state==='PENDING'&&o.provider==='yookassa'):null);
  if(!candidate)return;
  const now=Date.now();
  if(now-lastVerifyAt<4500)return;
  lastVerifyAt=now;
  verifyInFlight=true;
  try{
    const res=await api('/api/orders/verify',{method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:JSON.stringify({orderId:candidate.id})});
    if(res?.state==='PAID'||res?.orderState==='PAID'||res?.status==='PAID'){
      void refresh();
    }
  }catch{ /* Webhook or polling refresh will continue normally. */ }
  finally{verifyInFlight=false;}
}
function renderAccount(payload) {
  state.loggedIn=true;state.csrf=payload.csrf;
  state.telegramProxyBonusEnabled=payload.telegramProxyBonusEnabled===true;
  state.wsProxyEnabled=payload.wsProxyEnabled===true;
  state.appleDnsProfileEnabled=payload.appleDnsProfileEnabled===true;
  state.fiAwgRegistrationAvailable=payload.fiAwgRegistrationAvailable===true;
  state.personalDnsEnabled=payload.personalDnsEnabled===true||payload.appleDnsProfileEnabled===true;
  byId('login-prompt').classList.add('hidden');
  byId('account-content').classList.remove('hidden');
  byId('logout-button').classList.remove('hidden');
  byId('auth-link').textContent='Мой доступ';
  byId('auth-link').href='#account';
  text('account-name','Мой аккаунт');
  text('account-subtitle','Защищённый вход · '+(payload.identity?.email||'Telegram'));
  state.trialRequestStatus=payload.trialRequestStatus||'NONE';
  const accesses=payload.access||[];
  state.lastOrders=payload.orders||[];
  state.hasPendingProvisioning=['PENDING','WAITING'].includes(state.trialRequestStatus)||accesses.some(a=>a.state==='PAID_PENDING_PROVISIONING');
  const active=accesses.filter(a=>a.state==='ACTIVE' && a.secondsRemaining>0);
  state.activeTrialProducts=active.filter(a=>state.lastOrders.some(o=>o.id===a.sourceOrderId&&o.state==='TRIAL')).map(a=>a.product);
  if(state.lastOrders.some(o=>o.state==='TRIAL'&&o.product==='bundle'&&
     ['vpn','smart_dns'].every(product=>active.some(a=>a.sourceOrderId===o.id&&a.product===product))))
    state.activeTrialProducts.push('bundle');
  text('active-count',active.length);
  const timed=active.filter(a=>a.secondsRemaining!==null).sort((a,b)=>a.secondsRemaining-b.secondsRemaining);
  text('days-left',timed.length?remaining(timed[0].secondsRemaining):'—');
  text('days-hint',timed.length?'До ближайшего окончания':'Нет активных подписок');
  renderAccess(accesses);renderOrders(payload.orders||[]);
  renderSharedTrialProxy(payload.sharedTrialProxy,accesses);
  renderPurchaseResult(payload);
  byId('link-email').classList.toggle('hidden',!state.emailLoginEnabled||payload.identity?.emailLinked);
  byId('link-telegram').classList.toggle('hidden',!state.telegramLoginEnabled||payload.identity?.telegramLinked);
  if(!state.emailLinkMode)byId('email-auth-panel').classList.add('hidden');
  // Never show a stale bearer subscription on a different account.
  if(!accesses.some(a=>a.product==='vpn' && a.state==='ACTIVE' && a.secondsRemaining>0)){
    state.guestSubscriptionUrl=null;
    byId('guest-trial-card').classList.add('hidden');
  }
  const pendingVpn=accesses.filter(a=>a.product==='vpn' &&
    ['PAID_PENDING_PROVISIONING','PROVISIONING_FAILED'].includes(a.state));
  if(pendingVpn.length){
    const isPaid=pendingVpn.some(a=>(payload.orders||[]).some(o=>
      o.id===a.sourceOrderId && o.state==='PAID'));
    const card=byId('guest-trial-card');
    card.classList.remove('hidden');
    byId('guest-trial-title').textContent=isPaid?
      'Подключаем оплаченный VPN':state.lastOrders.some(o=>o.state==='TRIAL'&&o.product==='bundle'&&pendingVpn.some(a=>a.sourceOrderId===o.id))?'Подключаем «3 в 1»':'Подключаем пробный VPN';
    byId('guest-trial-status').textContent=isPaid?
      'Оплата подтверждена. VPN-сервер готовит подключение. Проверьте статус в личном кабинете.':
      'Пробные 24 часа начнутся после подтверждения готовности доступа.';
    if(!state.guestSubscriptionUrl)byId('guest-trial-ready').classList.add('hidden');
  }
  renderPlan();
}
function syncLoginLinks(){
  const top=byId('auth-link');
  top.textContent=state.loginEnabled?'Войти':'Telegram-бот';
  top.href=state.loginEnabled?'#account':'https://t.me/MNEBYVPN_bot';
  const tg=byId('cabinet-login-link');
  tg.href=state.telegramLoginEnabled?'/auth/login':'#account';
  tg.setAttribute('aria-disabled',String(!state.telegramLoginEnabled));
  byId('email-auth-panel').classList.toggle('hidden',!state.emailLoginEnabled);
  text('login-prompt-copy',state.emailLoginEnabled?
    'Получите код на email и войдите без пароля.':'Вход по email пока настраивается.');
  text('login-help',state.telegramLoginEnabled?
    'Если Telegram уже привязан к аккаунту, можно войти и через него.':
    'После входа по email можно будет привязать Telegram.');
  text('account-subtitle',state.loginEnabled?
    'Войдите, чтобы увидеть данные':'Вход в кабинет пока подключается');
}

function renderLoggedOut() {
  // A session that expires or is revoked must not leave stale private data on
  // a shared browser screen. Keep the public catalog and selected product.
  state.loggedIn=false;state.csrf='';state.guestSubscriptionUrl=null;
  state.trialRequestStatus='NONE';state.activeTrialProducts=[];state.hasPendingProvisioning=false;state.lastOrders=[];state.trialProduct='vpn';
  state.telegramProxyBonusEnabled=false;
  state.wsProxyEnabled=false;
  state.appleDnsProfileEnabled=false;
  state.personalDnsEnabled=false;
  proxyCredCache.clear();
  renderSharedTrialProxy(null);
  clearCachedCredentials();
  byId('guest-trial-card').classList.add('hidden');
  byId('purchase-result').classList.add('hidden');
  byId('link-email').classList.add('hidden');
  byId('link-telegram').classList.add('hidden');
  state.renewalTargetId=null;state.requestId=null;
  byId('login-prompt').classList.remove('hidden');
  byId('account-content').classList.add('hidden');
  byId('logout-button').classList.add('hidden');
  syncLoginLinks();
  byId('access-list').replaceChildren();
  byId('orders-list').replaceChildren();
  renderPlan();
}
let refreshInFlight=null;
function refresh() {
  if(refreshInFlight)return refreshInFlight;
  refreshInFlight=refreshOnce().finally(()=>{refreshInFlight=null;});
  return refreshInFlight;
}
async function refreshOnce() {
  state.refreshing=true;
  try {
    const data=await api('/api/me');
    renderAccount(data);
    void verifyPendingOrderIfNeeded(data);
  } catch(error) {
    if(error.status===401) {
      renderLoggedOut();return;
    }
    toast('Не удалось загрузить кабинет. Попробуйте обновить страницу.');
  } finally {state.refreshing=false;}
}
async function loadLoginOptions(){
  // Public login options are independent of the database-backed tariff catalog.
  // An intermittent pricing API error must never hide the email login form.
  try{
    const data=await api('/api/auth/options');
    state.loginEnabled=data.loginEnabled===true;
    state.telegramLoginEnabled=data.telegramLoginEnabled===true;
    state.emailLoginEnabled=data.emailLoginEnabled===true;
    if(!state.loggedIn)syncLoginLinks();
  }catch{ /* The catalog may still provide login capabilities. */ }
}
function applyPublicCatalog(data){
  if(!data||!Array.isArray(data.plans))throw Error('INVALID_CATALOG');
  // Only server-supplied prices and flags; never create synthetic offers.
  state.plans=data.plans.filter(p=>p&&typeof p.id==='string'&&
    ['vpn','smart_dns','bundle'].includes(p.product)&&
    Number.isSafeInteger(p.durationDays)&&p.durationDays>0&&
    Number.isSafeInteger(p.rubMinor)&&p.rubMinor>0);
  state.checkoutEnabled=data.checkoutEnabled===true;
  state.loginEnabled=data.loginEnabled===true;
  state.telegramLoginEnabled=data.telegramLoginEnabled===true;
  state.emailLoginEnabled=data.emailLoginEnabled===true;
  state.trialOffers=Array.isArray(data.trialOffers)?data.trialOffers:[];
  state.paymentProvider=data.paymentProvider==='prodamus'?'prodamus':'yookassa';
  if(!state.loggedIn)syncLoginLinks();
  renderPlan();
}
function embeddedPublicCatalog(){
  const encoded=document.querySelector('meta[name="mnebyvpn-public-catalog"]')?.content;
  if(!encoded||encoded.length>32768)return null;
  try{
    const json=new TextDecoder().decode(Uint8Array.from(atob(encoded),
      c=>c.charCodeAt(0)));
    const data=JSON.parse(json);
    return Array.isArray(data?.plans)?data:null;
  }catch{return null;}
}
let catalogInFlight=null;
function loadCatalog(){
  if(catalogInFlight)return catalogInFlight;
  catalogInFlight=loadCatalogOnce().finally(()=>{catalogInFlight=null;});
  return catalogInFlight;
}
async function loadCatalogOnce(){
  // Homepage and API both read the very same server-authoritative billing catalog.
  // First paint needs no additional network request on unstable mobile networks.
  if(!state.plans.length){
    const embedded=embeddedPublicCatalog();
    if(embedded)applyPublicCatalog(embedded);
  }
  for(let attempt=0;attempt<3;attempt++){
    try{
      applyPublicCatalog(await api('/api/plans'));
      return;
    }catch{
      if(attempt<2)
        await new Promise(resolve=>setTimeout(resolve,attempt===0?400:1200));
      else if(!state.plans.length)
        toast('Не удалось загрузить тарифы. Проверьте соединение и повторите запрос.');
    }
  }
  renderPlan();
}
function savedSelection() {
  try {
    const raw=sessionStorage.getItem('mnebyvpn-selection');
    return raw?JSON.parse(raw):null;
  } catch {return null;}
}
function saveSelection() {
  try {
    sessionStorage.setItem('mnebyvpn-selection',JSON.stringify({
      product:state.product,days:state.days,inviteToken:state.inviteToken,
      savedAt:Date.now(),
    }));
  } catch { /* Privacy-mode session storage may be unavailable. */ }
}
function consumeReferral() {
  state.inviteToken=null;
  saveSelection();
}
function applyLinkOptions() {
  const url=new URL(location.href);
  const saved=savedSelection();
  const fresh=Number.isSafeInteger(saved?.savedAt) &&
    saved.savedAt<=Date.now() && Date.now()-saved.savedAt<=30*60*1000;
  const referral=url.searchParams.get('ref');
  // Persist the token across external Telegram OIDC redirects. Never trust it
  // as identity: server-side checkout still validates matching invitation.
  const token=/^[A-Za-z0-9_-]{16,24}$/.test(referral||'')?referral:
    fresh && /^[A-Za-z0-9_-]{16,24}$/.test(saved?.inviteToken||'')
      ?saved.inviteToken:null;
  state.inviteToken=token;
  const product=url.searchParams.get('product');
  const days=Number(url.searchParams.get('days'));
  if(Object.hasOwn(productNames,product)&&validOfferDays(product,days)){
    state.product=product;state.days=days;
  } else if(saved && Object.hasOwn(productNames,saved.product) &&
    validOfferDays(saved.product,saved.days)) {
    state.product=saved.product;state.days=saved.days;
  }
  setSelection(state.product,state.days);
  // Persist on page entry too: header and cabinet Login links bypass the
  // purchase/trial handlers and would otherwise drop the referral in OIDC.
  saveSelection();
  if(url.searchParams.get('login')==='failed')
    toast('Вход не завершён. Попробуйте вход по email или повторите Telegram.');
  state.purchaseIntent=readPurchaseIntent();
  // The dedicated payment screen already shows this message; do not
  // cover its primary action with a duplicate fixed toast.
  if(url.searchParams.get('payment')==='returned' &&
      !document.getElementById('journey-payment-intro'))
    toast('Проверяем подтверждение оплаты. Возврат на сайт ещё не означает, что платёж получен.');
}
async function purchase() {
  const plan=state.plans.find(p=>p.product===state.product&&p.durationDays===state.days);
  if(state.busy)return;
  if(!plan||!state.checkoutEnabled){
    checkoutError('Оплата этого тарифа пока недоступна.');return;
  }
  if(!state.loggedIn){
    saveSelection();
    byId('account').scrollIntoView({behavior:'smooth'});
    toast('Для оплаты войдите в личный кабинет.');
    return;
  }
  state.busy=true;checkoutError('');showPaymentLink(null);renderPlan();
  try {
    // Request identity must be created inside the guarded block: some in-app
    // browsers do not expose randomUUID even though crypto.getRandomValues works.
    state.requestId ||= newRequestId();
    const payload={planId:plan.id,requestId:state.requestId};
    if(state.inviteToken)payload.inviteToken=state.inviteToken;
    if(state.renewalTargetId)payload.renewalTargetId=state.renewalTargetId;
    const result=await api(state.renewalTargetId?'/api/renew':'/api/checkout',{
      method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:JSON.stringify(payload),
    });
    const target=new URL(result.paymentUrl);
    const host=target.hostname;
    const isYookassa=host==='yookassa.ru'||host.endsWith('.yookassa.ru')||
      host==='yoomoney.ru'||host.endsWith('.yoomoney.ru');
    const isFallbackPay=state.paymentProvider==='prodamus' &&
      (host==='payform.ru'||host.endsWith('.payform.ru'));
    const isLocalTest=location.hostname==='127.0.0.1'&&host==='127.0.0.1';
    const safeScheme=target.protocol==='https:'||(isLocalTest&&target.protocol==='http:');
    if(!safeScheme||!(isYookassa||isFallbackPay||isLocalTest))throw new Error('UNSAFE_PAYMENT_LINK');
    // A visible, user-clickable fallback matters for WebViews that refuse
    // programmatic navigation after an asynchronous request.
    showPaymentLink(target.toString());
    state.purchaseIntent={orderId:result.orderId,renewalTargetId:state.renewalTargetId||null};
    try{sessionStorage.setItem('mnebyvpn-purchase-intent',JSON.stringify(state.purchaseIntent));}catch{}
    consumeReferral();
    state.requestId=null;
    location.assign(target.toString());
  }catch(error){
    const messages={
      PAYMENT_NOT_AVAILABLE:'Оплата сейчас недоступна.',
      PAYMENT_PROVIDER_UNAVAILABLE:'Платёжный сервис не ответил. Заказ сохранён: можно повторить переход к оплате.',
      PAYMENT_PROVIDER_INVALID_LINK:'Не удалось получить ссылку оплаты. Повторите попытку.',
      CHECKOUT_RETRY_LIMIT:'Слишком много заказов за короткое время. Повторите позже.',
      INVALID_CHECKOUT:'Не удалось проверить параметры заказа.',
      LOGIN_REQUIRED:'Сессия истекла. Войдите повторно.',
      FORBIDDEN:'Сессия изменилась. Обновите страницу и войдите повторно.',
      UNSAFE_PAYMENT_LINK:'Не удалось проверить безопасный адрес оплаты.',
      VERIFIED_EMAIL_REQUIRED:'Перед оплатой подтвердите email в личном кабинете.',
    };
    const message=messages[error?.message] || 'Не удалось создать заказ или открыть оплату. Повторите попытку.';
    checkoutError(message);toast(message);
  }finally{state.busy=false;renderPlan();}
}
async function claimTrial(){
  if(state.busy)return;
  const trialProduct=state.trialOffers.includes('bundle')?'bundle':state.trialProduct==='smart_dns'?'smart_dns':'vpn';
  if(!state.trialOffers.includes(trialProduct)){
    toast('Бесплатный доступ сейчас недоступен.');return;
  }
  if(!state.loggedIn){
    if(!state.loginEnabled){toast('Вход пока недоступен.');return;}
    saveSelection();
    try{
      sessionStorage.setItem('mnebyvpn-pending-trial','1');
      sessionStorage.setItem('mnebyvpn-pending-trial-product',trialProduct);
    }catch{}
    byId('account').scrollIntoView({behavior:'smooth'});
    toast('Для получения бесплатных суток сначала войдите по email или через привязанный Telegram.');
    return;
  }
  state.busy=true;renderPlan();
  const payload={product:trialProduct};
  if(state.inviteToken)payload.inviteToken=state.inviteToken;
  try{
    const response=await api('/api/trial',{method:'POST',headers:{
      'Content-Type':'application/json','X-CSRF-Token':state.csrf,
    },body:JSON.stringify(payload)});
    const messages={
      GRANTED:'Пробный доступ оформлен. Ожидаем подтверждения подключения узлом.',
      PENDING:'Заявка уже есть. Время начнётся после активации.',
      ALREADY_USED:'Пробные сутки для этого аккаунта уже использованы.',
      DEVICE_ALREADY_USED:'В этом браузере уже оформляли пробные сутки.',
      UNAVAILABLE:'Пробный доступ сейчас недоступен.',
    };
    // Successful requests already have a persistent setup status. Avoid
    // covering "Я установил приложение" and the import action with a toast.
    if(response.status!=='ALREADY_USED'&&!(['GRANTED','PENDING'].includes(response.status) &&
      document.body?.classList?.contains('journey-active')))
      toast(messages[response.status]||'Статус обновлён.');
    if(['GRANTED','PENDING','ALREADY_USED'].includes(response.status))consumeReferral();
    if(['GRANTED','PENDING','ALREADY_USED','DEVICE_ALREADY_USED'].includes(response.status)){
      try{
        sessionStorage.removeItem('mnebyvpn-pending-trial');
        sessionStorage.removeItem('mnebyvpn-pending-trial-product');
      }catch{}
    }
    await refresh();
    const alreadyActive=response.status==='ALREADY_USED'&&(trialProduct==='bundle'?state.activeTrialProducts.includes('bundle'):state.activeTrialProducts.includes(trialProduct));
    if(response.status==='ALREADY_USED'&&!alreadyActive){
      toast(messages.ALREADY_USED);
      byId('account').scrollIntoView({behavior:'smooth'});
    }else if(alreadyActive||['GRANTED','PENDING'].includes(response.status)) {
      if(typeof window!=='undefined'&&window.MnebyvpnJourney)
        window.MnebyvpnJourney.show('setup',true);
      else byId('guest-trial-card').scrollIntoView({behavior:'smooth',block:'center'});
    }
    return alreadyActive?'GRANTED':response.status;
  }catch(error){
    if(['INVALID_TRIAL_REFERRAL','BROWSER_VERIFICATION_REQUIRED'].includes(error.message)){
      try{
        sessionStorage.removeItem('mnebyvpn-pending-trial');
        sessionStorage.removeItem('mnebyvpn-pending-trial-product');
      }catch{}
    }
    toast(error.status===401?'Сессия истекла. Войдите повторно.':
      error.message==='BROWSER_VERIFICATION_REQUIRED'?'Обновите страницу и повторите получение доступа.':
      error.message==='INVALID_TRIAL_REFERRAL'?'Ссылка приглашения недействительна.':
      'Не удалось оформить бесплатный доступ. Попробуйте ещё раз.');
  }finally{state.busy=false;renderPlan();}
}
function renderVpnSetup(data){
  const url=String(data.subscriptionUrl||'');
  const parsed=(()=>{try{return new URL(url);}catch{return null;}})();
  if(!parsed||parsed.protocol!=='https:'||
      !(['cdn.servgo.ru','mnebyvpn.site'].includes(parsed.hostname))||
      !/^\/sub\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname)){
    throw Error('UNSAFE_SUBSCRIPTION_URL');
  }
  const token=parsed.pathname.slice('/sub/'.length);
  const root=parsed.origin;
  state.guestSubscriptionUrl=url;
  const card=byId('guest-trial-card');
  card.classList.remove('hidden');
  byId('guest-trial-title').textContent='Ваш VPN готов к подключению';
  const exp=data.expiresAt?new Date(data.expiresAt):null;
  byId('guest-trial-status').textContent='Срок доступа'+
    (exp&&!Number.isNaN(exp.getTime())?
      ' до '+exp.toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'}):' активен')+
    '. Следуйте инструкции ниже.';
  byId('guest-trial-ready').classList.remove('hidden');
  byId('guest-auto-incy').href=root+'/install/'+token+'?client=incy';
  byId('guest-auto-karing').href=root+'/install/'+token+'?client=karing';
  byId('guest-subscription-url').value=url;
  // The compact journey wizard owns scroll position. Scrolling to the
  // hidden legacy card here pushed the import CTA away on mobile.
  if(!document.body?.classList?.contains('journey-active'))
    card.scrollIntoView({behavior:'smooth',block:'center'});
}
async function loadSubscription(entitlementId){
  if(state.setupLoading||!state.loggedIn)return;
  state.setupLoading=true;
  try{
    const data=await api('/api/vpn/subscription',{method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:JSON.stringify({entitlementId})});
    renderVpnSetup(data);
  }catch(error){
    toast(error.message==='VPN_NOT_ACTIVE'?
      'VPN ещё не подтверждён сервером. Проверьте статус позже.':
      'Не удалось получить ссылку. Попробуйте позже.');
  }finally{state.setupLoading=false;}
}
async function copyGuestSubscription(){
  const url=state.guestSubscriptionUrl;
  if(!url)return;
  try{
    await navigator.clipboard.writeText(url);
    toast('Ссылка подписки скопирована.');
  }catch{
    const field=byId('guest-subscription-url');
    field.focus();field.select();
    toast('Скопируйте выделенную ссылку.');
  }
}

let pendingEmail=null;
let pendingReviewCode=false;
async function beginEmail(event){
  event.preventDefault();
  if(!state.emailLoginEnabled)return;
  const email=byId('email-input').value.trim().toLowerCase();
  if(!email)return;
  const button=byId('email-send-button');
  button.disabled=true;
  text('email-status','Проверяем способ входа…');
  try{
    const payload={email};
    if(state.loggedIn&&state.emailLinkMode)payload.link=true;
    const response=await api('/api/auth/email/start',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    pendingEmail=email;
    pendingReviewCode=response.status==='REVIEW_CODE_REQUIRED';
    const codeInput=byId('email-code-input');
    const digits=pendingReviewCode?8:6;
    codeInput.value='';
    codeInput.setAttribute('pattern','[0-9]{'+digits+'}');
    codeInput.maxLength=digits;
    codeInput.placeholder=digits+' цифр';
    codeInput.setAttribute('autocomplete',pendingReviewCode?'off':'one-time-code');
    document.querySelector('label[for="email-code-input"]').textContent=
      pendingReviewCode?'Постоянный код':'Код из письма';
    byId('email-verify-form').classList.remove('hidden');
    text('email-status',pendingReviewCode?
      'Введите постоянный восьмизначный код тестовой учётной записи.':
      'Письмо отправлено. Код действителен 10 минут. Проверьте также папку «Спам».');
    byId('email-code-input').focus();
  }catch(error){
    text('email-status',error.message==='EMAIL_RATE_LIMIT'?
      'Слишком много запросов. Повторите позже.':
      'Отправить код не удалось. Проверьте адрес или попробуйте позже.');
  }finally{button.disabled=false;}
}
async function finishEmail(event){
  event.preventDefault();
  if(!pendingEmail)return;
  const code=byId('email-code-input').value.trim();
  if(!(pendingReviewCode?/^[0-9]{8}$/:/^[0-9]{6}$/).test(code)){
    text('email-status',pendingReviewCode?'Введите восемь цифр постоянного кода.':'Введите шесть цифр из письма.');return;
  }
  const button=byId('email-verify-button');
  button.disabled=true;
  try{
    const verifyPayload={email:pendingEmail,code};
    try{
      const raw=sessionStorage.getItem('mnebyvpn-pending-trial');
      const product=sessionStorage.getItem('mnebyvpn-pending-trial-product');
      if(['1','vpn','smart_dns','bundle'].includes(raw)&&(state.trialOffers.includes('bundle')||product==='bundle'||((raw==='1'||raw==='vpn')&&product!=='smart_dns'))){
        verifyPayload.trial=(state.trialOffers.includes('bundle')||product==='bundle')?'bundle':'vpn';
        if(state.inviteToken)verifyPayload.trialInviteToken=state.inviteToken;
      }
    }catch{}
    await api('/api/auth/email/verify',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(verifyPayload)});
    pendingEmail=null;pendingReviewCode=false;state.emailLinkMode=false;
    byId('email-verify-form').classList.add('hidden');
    // A poll started before the session cookie was issued may be stale.
    if(refreshInFlight)await refreshInFlight;
    await refresh();
    await consumePendingTrial();
    // The trial sign-in screen shares this exact OTP flow with the cabinet.
    // Do not scroll to a hidden account after the trial wizard has opened.
    if(!window.MnebyvpnJourney?.afterEmailAuthenticated?.())
      byId('account').scrollIntoView({behavior:'smooth'});
  }catch(error){
    text('email-status',error.message==='EMAIL_ALREADY_LINKED'?
      'Этот email уже привязан к другой учётной записи. Слияние не выполнено.':
      error.message==='EMAIL_RATE_LIMIT'?'Слишком много попыток. Повторите позже.':
      pendingReviewCode?'Неверный код или доступ временно заблокирован.':'Код неверен или истёк. Проверьте письмо или запросите новый.');
  }finally{button.disabled=false;}
}
function openEmailLink(){
  state.emailLinkMode=true;
  byId('email-auth-panel').classList.remove('hidden');
  text('email-status','Подтвердите email, который хотите привязать к этому аккаунту.');
  byId('email-input').focus();
}
async function logout() {
  if(!state.csrf)return;
  try {
    await api('/api/logout',{method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:'{}'});
    try{
      sessionStorage.removeItem('mnebyvpn-pending-trial');
      sessionStorage.removeItem('mnebyvpn-pending-trial-product');
    }catch{}
    location.assign('/');
  } catch {toast('Не удалось выйти. Попробуйте ещё раз.');}
}
document.querySelectorAll('[data-product]').forEach(button=>{
  button.addEventListener('click',()=>setSelection(button.dataset.product,state.days));
});
document.querySelectorAll('[data-days]').forEach(button=>{
  button.addEventListener('click',()=>setSelection(state.product,Number(button.dataset.days)));
});
async function supportStatus(){
  const send=byId('support-send');
  const result=byId('support-result');
  try{
    const data=await api('/api/support/status');
    send.disabled=!data.available;
    send.textContent=data.available?'Отправить обращение':'Поддержка пока настраивается';
    result.textContent=data.available?'':'Приём обращений с сайта ещё не подключён.';
  }catch{
    send.disabled=true;
    send.textContent='Поддержка временно недоступна';
    result.textContent='Не удалось проверить канал поддержки.';
  }
}
async function refreshSupportTicket(){
  try{
    const ticket=await api('/api/support/ticket');
    const thread=byId('support-thread');
    if(ticket.status==='NONE'){
      thread.classList.add('hidden');
      return;
    }
    thread.classList.remove('hidden');
    byId('support-reply').textContent=ticket.answer||
      'Обращение зарегистрировано. Ответ оператора появится здесь, в этом браузере.';
  }catch{
    // Keep any last known reply visible during a temporary outage.
  }
}
async function submitSupport(event){
  event.preventDefault();
  const form=byId('support-form'),send=byId('support-send'),result=byId('support-result');
  if(!form.reportValidity())return;
  send.disabled=true;
  send.textContent='Отправляем…';
  result.textContent='';
  try{
    const submitted=await api('/api/support',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      contact:byId('support-contact').value,
      message:byId('support-message').value,
      website:byId('support-website').value,
    })});
    byId('support-message').value='';
    result.textContent=submitted.queued
      ?'✅ Обращение сохранено. Оператор ответит здесь после просмотра заявки в боте.'
      :'✅ Обращение передано оператору MNEBYVPN.';
    await refreshSupportTicket();
  }catch(error){
    result.textContent=error.status===429
      ?'Слишком много обращений. Повторите попытку немного позже.'
      :error.status===400
      ?'Укажите корректный email или @username и сообщение от 10 символов.'
      :'Не удалось подтвердить отправку. Попробуйте позже.';
  }finally{
    send.disabled=false;
    send.textContent='Отправить обращение';
  }
}
byId('support-form').addEventListener('submit',submitSupport);
supportStatus();
refreshSupportTicket();
setInterval(()=>{if(document.visibilityState==='visible')refreshSupportTicket();},15000);
byId('buy-button').addEventListener('click',purchase);
byId('trial-button').addEventListener('click',claimTrial);
byId('purchase-refresh').addEventListener('click',()=>{
  lastVerifyAt=0;
  void refresh();
});
byId('purchase-connect').addEventListener('click',()=>{
  const id=byId('purchase-connect').dataset.entitlementId;
  if(id&&byId('purchase-connect').dataset.product==='smart_dns')
    downloadAppleDnsProfile(id,byId('purchase-connect'),byId('access-list'));
  else if(id)loadSubscription(id);
});
byId('guest-copy-subscription').addEventListener('click',copyGuestSubscription);
byId('cancel-renewal-button').addEventListener('click',()=>{
  state.renewalTargetId=null;
  state.requestId=null;
  renderPlan();
});
byId('logout-button').addEventListener('click',logout);
byId('email-start-form').addEventListener('submit',beginEmail);
byId('email-verify-form').addEventListener('submit',finishEmail);
byId('link-email').addEventListener('click',openEmailLink);
function applyInitialSelectionFromUrl(){
  try{
    const params=new URLSearchParams(location.search);
    const p=params.get('product');
    const d=Number(params.get('days'));
    const nextProduct=p&&Object.hasOwn(productNames,p)?p:state.product;
    const nextDays=validOfferDays(nextProduct,d)?d:state.days;
    if(nextProduct!==state.product||nextDays!==state.days)setSelection(nextProduct,nextDays);
  }catch{}
}
applyInitialSelectionFromUrl();
applyLinkOptions();
async function consumePendingTrial(){
  if(state.loggedIn && (state.trialOffers.includes('bundle')||state.trialOffers.includes('vpn')||state.trialOffers.includes('smart_dns'))){
    let pending=null;
    try{
      const raw=sessionStorage.getItem('mnebyvpn-pending-trial');
      const prod=sessionStorage.getItem('mnebyvpn-pending-trial-product');
      if(['1','vpn','smart_dns','bundle'].includes(raw))
        pending=state.trialOffers.includes('bundle')?'bundle':(prod==='bundle'||raw==='bundle')?'bundle':(prod==='smart_dns'||raw==='smart_dns')?'smart_dns':'vpn';
    }catch{}
    if(pending&&state.trialOffers.includes(pending)){
      state.trialProduct=pending;
      await claimTrial();
    }
  }
}
Promise.all([loadLoginOptions(),loadCatalog(),refresh()]).then(consumePendingTrial);
// Payment verification and provisioning can complete after the user returns.
let pollTick=0;
setInterval(()=>{
  if(document.visibilityState!=='visible'||!state.loggedIn)return;
  const view=document.body?.dataset?.journeyView;
  const fastWait=view==='payment'||(view==='setup'&&state.hasPendingProvisioning);
  pollTick=(pollTick+1)%4;
  if(fastWait||pollTick===0)void refresh();
},3800);
window.addEventListener('online',()=>{
  void Promise.all([loadCatalog(),refresh()]).then(consumePendingTrial);
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    void Promise.all([refresh(),state.plans.length?Promise.resolve():loadCatalog()]).then(consumePendingTrial);
  }
});
