/* Public catalog + authenticated account client. No client-side entitlement decisions. */
const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = String(value); };
const state = {
  product: 'vpn', days: 15, plans: [], checkoutEnabled: false, loginEnabled:false,
  loggedIn: false, csrf: '', busy: false, requestId: null, trialOffers: [],
  inviteToken: null, refreshing: false, renewalTargetId: null,
  telegramLoginEnabled:false,yandexLoginEnabled:false,
  trialStatus:'NONE',guestSubscriptionUrl:null,setupLoading:false,
};
const productNames = { vpn:'VPN', smart_dns:'Smart DNS', bundle:'VPN + Smart DNS' };
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
function setSelection(product, days) {
  if (!Object.hasOwn(productNames,product) || ![15,30,60,90].includes(days)) return;
  if (product !== state.product || days !== state.days) state.requestId = null;
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
function renderPlan() {
  const plan = state.plans.find(p=>p.product===state.product && p.durationDays===state.days);
  text('selected-plan-name', plan?.title || productNames[state.product] + ' · ' + state.days + ' дней');
  text('selected-duration',state.days+' дней');
  text('selected-quota',state.product==='vpn'?'Входит':plan?.dnsQuotaBytes?fmtBytes(plan.dnsQuotaBytes):'Не опубликована');
  text('selected-price',plan?.rubMinor?formatMoney(plan.rubMinor):'—');
  byId('cancel-renewal-button').classList.toggle('hidden',!state.renewalTargetId);
  text('price-description',plan?(state.renewalTargetId?
    'Срок прибавится к выбранному доступу после подтверждения оплаты.':
    'Новая покупка создаёт отдельный доступ. Для продления используйте кнопку в кабинете.'):
    'Тариф ещё не опубликован. Стоимость появится после утверждения.');
  const buy=byId('buy-button');
  const inDevelopment=state.product!=='vpn';
  buy.disabled=inDevelopment||!plan||!state.checkoutEnabled||state.busy;
  buy.textContent=inDevelopment?'В разработке':state.busy?'Создаём заказ…':!plan?'Тариф пока недоступен':
    !state.checkoutEnabled?'Оплата пока недоступна':
    !state.loggedIn?'Войти для оплаты':state.renewalTargetId?'К оплате продления':'Перейти к оплате';
  const trial=byId('trial-button');
  const trialAvailable=state.product==='vpn' &&
    state.trialOffers.includes(state.product) && state.loginEnabled;
  trial.disabled=!trialAvailable||state.busy;
  trial.textContent=state.busy?'Проверяем заявку…':
    !state.loginEnabled?'Бесплатный доступ временно недоступен':
    trialAvailable?(state.loggedIn?'🎁 Получить 24 часа бесплатно':'Войти и получить 24 часа бесплатно'):
    'Бесплатный доступ временно недоступен';
  text('checkout-hint',inDevelopment?'Smart DNS и совместный тариф находятся в разработке и пока не продаются.':
    !plan?'Неопубликованные тарифы не продаются.':
    !state.checkoutEnabled?'Онлайн-оплата включится после проверки платёжного подключения.':
    'Способ оплаты выбирается на защищённой странице платёжного провайдера.');
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
function renderAccess(accesses) {
  const list=byId('access-list');
  list.replaceChildren();
  if(!accesses.length) {
    list.append(node('div','empty','Пока нет подписок. Выберите тариф выше, когда он станет доступен.'));
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
      item.append(node('p','',a.quotaLimitBytes?
        'Пакет DNS: '+fmtBytes(a.quotaLimitBytes):'DNS-квота пока не установлена'));
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
      } else {
        item.append(node('div','usage-unavailable',
          'Учёт расхода DNS пока не подтверждён. Использовано / осталось: нет достоверных данных.'));
      }
    }
    if(a.product==='vpn' &&
       a.state==='ACTIVE' && a.secondsRemaining!==null && a.secondsRemaining>0){
      const setup=node('button','button button-secondary setup-button','Подключить VPN');
      setup.type='button';
      setup.addEventListener('click',loadSubscription);
      item.append(setup);
    }
    const durations=state.plans.filter(p=>p.product===a.product);
    if (durations.length && a.startsAt && a.expiresAt &&
      !['REFUNDED','CANCELLED','PENDING_PAYMENT'].includes(a.state)) {
      const renew=node('button','button button-secondary renew-button','Продлить доступ ↗');
      renew.type='button';
      renew.addEventListener('click',()=>{
        const preferred=durations.find(p=>p.durationDays===30)||durations[0];
        setSelection(a.product,preferred.durationDays);
        state.renewalTargetId=a.id;
        state.requestId=null;
        renderPlan();
        byId('plans').scrollIntoView({behavior:'smooth'});
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
function renderAccount(payload) {
  state.loggedIn=true;state.csrf=payload.csrf;
  byId('login-prompt').classList.add('hidden');
  byId('account-content').classList.remove('hidden');
  byId('logout-button').classList.remove('hidden');
  byId('auth-link').textContent='Мой доступ';
  byId('auth-link').href='#account';
  text('account-name','Мой аккаунт');
  text('account-subtitle','Защищённый вход · '+(payload.identity?.provider==='yandex'?'Яндекс ID':'Telegram'));
  const accesses=payload.access||[];
  const active=accesses.filter(a=>a.state==='ACTIVE' && a.secondsRemaining>0);
  text('active-count',active.length);
  const timed=active.filter(a=>a.secondsRemaining!==null).sort((a,b)=>a.secondsRemaining-b.secondsRemaining);
  text('days-left',timed.length?remaining(timed[0].secondsRemaining):'—');
  text('days-hint',timed.length?'До ближайшего окончания':'Нет активных подписок');
  renderAccess(accesses);renderOrders(payload.orders||[]);
  byId('link-yandex').classList.toggle('hidden',!state.yandexLoginEnabled||payload.identity?.yandexLinked);
  byId('link-telegram').classList.toggle('hidden',!state.telegramLoginEnabled||payload.identity?.telegramLinked);
  // Never show a stale bearer subscription on a different account.
  if(!accesses.some(a=>a.product==='vpn' && a.state==='ACTIVE' && a.secondsRemaining>0)){
    state.guestSubscriptionUrl=null;
    byId('guest-trial-card').classList.add('hidden');
  }
  if(accesses.some(a=>a.product==='vpn' && a.state==='PAID_PENDING_PROVISIONING')){
    const card=byId('guest-trial-card');
    card.classList.remove('hidden');
    byId('guest-trial-title').textContent='Подключаем VPN';
    byId('guest-trial-status').textContent=
      'Заявка принята. Пробные 24 часа начнутся только после подтверждения активации сервером.';
    if(!state.guestSubscriptionUrl)byId('guest-trial-ready').classList.add('hidden');
  }
  renderPlan();
}
function syncLoginLinks() {
  const top=byId('auth-link');
  top.textContent=state.loginEnabled?'Войти':'Telegram-бот';
  top.href=state.loginEnabled?'#account':'https://t.me/MnebyVPN_bot';
  const cabinet=byId('cabinet-login-link');
  const yandex=byId('yandex-login-link');
  cabinet.textContent='Войти через Telegram';
  cabinet.href=state.telegramLoginEnabled?'/auth/login':'#account';
  cabinet.setAttribute('aria-disabled',String(!state.telegramLoginEnabled));
  yandex.href=state.yandexLoginEnabled?'/auth/yandex':'#account';
  yandex.setAttribute('aria-disabled',String(!state.yandexLoginEnabled));
  text('login-prompt-copy',state.loginEnabled?
    'Войдите, чтобы получить пробные 24 часа, подключить VPN и управлять сроком действия.':
    'Авторизация ещё настраивается. Бесплатный доступ без входа не выдаётся.');
  text('login-help',!state.loginEnabled?
    'Вход пока недоступен. Попробуйте позже.':
    state.yandexLoginEnabled&&state.telegramLoginEnabled?
      'Если Telegram не открывается без VPN, выберите Яндекс ID.':
      'Доступен только настроенный способ авторизации.');
  text('account-subtitle',state.loginEnabled?
    'Войдите, чтобы увидеть данные':'Вход в кабинет пока подключается');
}

function renderLoggedOut() {
  // A session that expires or is revoked must not leave stale private data on
  // a shared browser screen. Keep the public catalog and selected product.
  state.loggedIn=false;state.csrf='';state.guestSubscriptionUrl=null;
  byId('guest-trial-card').classList.add('hidden');
  byId('link-yandex').classList.add('hidden');
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
async function refresh() {
  if(state.refreshing)return;
  state.refreshing=true;
  try {
    const data=await api('/api/me');
    renderAccount(data);
  } catch(error) {
    if(error.status===401) {
      renderLoggedOut();return;
    }
    toast('Не удалось загрузить кабинет. Попробуйте обновить страницу.');
  } finally {state.refreshing=false;}
}
async function loadCatalog() {
  try {
    const data=await api('/api/plans');
    state.plans=Array.isArray(data.plans)?data.plans:[];
    state.checkoutEnabled=data.checkoutEnabled===true;
    state.loginEnabled=data.loginEnabled===true;
    state.telegramLoginEnabled=data.telegramLoginEnabled===true;
    state.yandexLoginEnabled=data.yandexLoginEnabled===true;
    state.trialOffers=Array.isArray(data.trialOffers)?data.trialOffers:[];
    if(!state.loggedIn)syncLoginLinks();
  } catch {
    toast('Не удалось загрузить тарифы. Попробуйте позже.');
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
  if(Object.hasOwn(productNames,product)&&[15,30,60,90].includes(days)){
    state.product=product;state.days=days;
  } else if(saved && Object.hasOwn(productNames,saved.product) &&
    [15,30,60,90].includes(saved.days)) {
    state.product=saved.product;state.days=saved.days;
  }
  setSelection(state.product,state.days);
  // Persist on page entry too: header and cabinet Login links bypass the
  // purchase/trial handlers and would otherwise drop the referral in OIDC.
  saveSelection();
  if(url.searchParams.get('login')==='failed')
    toast('Вход не завершён. Проверьте разрешения Яндекс ID или Telegram и повторите попытку.');
  if(url.searchParams.get('payment')==='returned')
    toast('Возврат из оплаты — не подтверждение платежа. Статус появится после проверки уведомления.');
}
async function purchase() {
  const plan=state.plans.find(p=>p.product===state.product&&p.durationDays===state.days);
  if(state.product!=='vpn'||!plan||!state.checkoutEnabled||state.busy)return;
  if(!state.loggedIn) {
    saveSelection();
    byId('account').scrollIntoView({behavior:'smooth'});
    return;
  }
  state.busy=true;state.requestId ||= crypto.randomUUID();renderPlan();
  const payload={planId:plan.id,requestId:state.requestId};
  if(state.inviteToken)payload.inviteToken=state.inviteToken;
  if(state.renewalTargetId)payload.renewalTargetId=state.renewalTargetId;
  try {
    const result=await api(state.renewalTargetId?'/api/renew':'/api/checkout',{
      method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:JSON.stringify(payload),
    });
    const target=new URL(result.paymentUrl);
    if(target.protocol!=='https:' || !(target.hostname==='payform.ru' ||
      target.hostname.endsWith('.payform.ru')))throw new Error('UNSAFE_PAYMENT_LINK');
    // The signed order already retains the referral. Never apply it again to
    // unrelated later purchases in the same session.
    consumeReferral();
    state.requestId=null;
    location.assign(target.toString());
  }catch(error){
    const messages={
      PAYMENT_NOT_AVAILABLE:'Оплата сейчас недоступна.',
      INVALID_CHECKOUT:'Не удалось проверить параметры заказа.',
      LOGIN_REQUIRED:'Сессия истекла. Войдите повторно.',
    };
    toast(messages[error.message] || 'Не удалось открыть оплату. Повторите попытку позднее.');
  } finally {state.busy=false;renderPlan();}
}
async function claimTrial(){
  if(state.busy)return;
  if(state.product!=='vpn'||!state.trialOffers.includes('vpn')){
    toast('Бесплатный доступ сейчас недоступен.');return;
  }
  if(!state.loggedIn){
    if(!state.loginEnabled){toast('Вход пока недоступен.');return;}
    saveSelection();
    try{sessionStorage.setItem('mnebyvpn-pending-trial','1');}catch{}
    byId('account').scrollIntoView({behavior:'smooth'});
    toast('Для получения бесплатных суток сначала войдите через Яндекс или Telegram.');
    return;
  }
  state.busy=true;renderPlan();
  const payload={product:'vpn'};
  if(state.inviteToken)payload.inviteToken=state.inviteToken;
  try{
    const response=await api('/api/trial',{method:'POST',headers:{
      'Content-Type':'application/json','X-CSRF-Token':state.csrf,
    },body:JSON.stringify(payload)});
    const messages={
      GRANTED:'Пробный доступ оформлен. Ожидаем подтверждения подключения узлом.',
      PENDING:'Заявка уже есть. Время начнётся после активации.',
      ALREADY_USED:'Пробные сутки для этого аккаунта уже использованы.',
      UNAVAILABLE:'Пробный доступ сейчас недоступен.',
    };
    toast(messages[response.status]||'Статус обновлён.');
    if(['GRANTED','PENDING','ALREADY_USED'].includes(response.status))consumeReferral();
    await refresh();
    if(response.status==='ALREADY_USED')
      byId('account').scrollIntoView({behavior:'smooth'});
    else if(['GRANTED','PENDING'].includes(response.status))
      byId('guest-trial-card').scrollIntoView({behavior:'smooth',block:'center'});
  }catch(error){
    toast(error.status===401?'Сессия истекла. Войдите повторно.':
      'Не удалось проверить бесплатный доступ. Попробуйте позднее.');
  }finally{state.busy=false;renderPlan();}
}
function renderVpnSetup(data){
  const url=String(data.subscriptionUrl||'');
  const parsed=(()=>{try{return new URL(url);}catch{return null;}})();
  if(!parsed||parsed.protocol!=='https:'||
      !(['cdn.servgo.ru','mnebyvpn.site'].includes(parsed.hostname))||
      !/^\\/sub\\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname)){
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
  card.scrollIntoView({behavior:'smooth',block:'center'});
}
async function loadSubscription(){
  if(state.setupLoading||!state.loggedIn)return;
  state.setupLoading=true;
  try{
    const data=await api('/api/vpn/subscription',{method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:'{}'});
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

async function logout() {
  if(!state.csrf)return;
  try {
    await api('/api/logout',{method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
      body:'{}'});
    location.assign('/');
  } catch {toast('Не удалось выйти. Попробуйте ещё раз.');}
}
document.querySelectorAll('[data-product]').forEach(button=>{
  button.addEventListener('click',()=>setSelection(button.dataset.product,state.days));
});
document.querySelectorAll('[data-days]').forEach(button=>{
  button.addEventListener('click',()=>setSelection(state.product,Number(button.dataset.days)));
});
byId('buy-button').addEventListener('click',purchase);
byId('trial-button').addEventListener('click',claimTrial);
byId('guest-copy-subscription').addEventListener('click',copyGuestSubscription);
byId('cancel-renewal-button').addEventListener('click',()=>{
  state.renewalTargetId=null;
  state.requestId=null;
  renderPlan();
});
byId('logout-button').addEventListener('click',logout);
applyLinkOptions();
Promise.all([loadCatalog(),refresh()]).then(async()=>{
  if(state.loggedIn && state.trialOffers.includes('vpn')){
    let pending=false;
    try{pending=sessionStorage.getItem('mnebyvpn-pending-trial')==='1';
      sessionStorage.removeItem('mnebyvpn-pending-trial');
    }catch{}
    if(pending)await claimTrial();
  }
});
// Payment verification and provisioning can complete after the user returns.
setInterval(()=>{if(document.visibilityState==='visible' && state.loggedIn)refresh();},15000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    refresh();
  }
});
