/* Public catalog + authenticated account client. No client-side entitlement decisions. */
const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = String(value); };
const state = {
  product: 'vpn', days: 15, plans: [], checkoutEnabled: false, loginEnabled:false,
  loggedIn: false, csrf: '', busy: false, requestId: null, trialOffers: [],
  inviteToken: null, refreshing: false, renewalTargetId: null,
  telegramLoginEnabled:false,emailLoginEnabled:false,emailLinkMode:false,
  trialStatus:'NONE',guestSubscriptionUrl:null,setupLoading:false,
  purchaseIntent:null,
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
function setSelection(product, days) {
  if (!Object.hasOwn(productNames,product) || ![15,30,60,90].includes(days)) return;
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
function renderPlan() {
  const plan = state.plans.find(p=>p.product===state.product && p.durationDays===state.days);
  text('selected-plan-name', plan?.title || productNames[state.product] + ' · ' + state.days + ' дней');
  text('selected-duration',state.days+' дней');
  text('selected-quota',state.product==='vpn'?'1 устройство':plan?.dnsQuotaBytes?fmtBytes(plan.dnsQuotaBytes):'Не опубликована');
  text('selected-price',plan?.rubMinor?formatMoney(plan.rubMinor):'—');
  byId('cancel-renewal-button').classList.toggle('hidden',!state.renewalTargetId);
  text('price-description',plan?(state.renewalTargetId?
    'Срок прибавится к выбранному доступу после подтверждения оплаты.':
    'Новая покупка создаёт отдельный доступ. Для продления используйте кнопку в кабинете.'):
    'Тариф ещё не опубликован. Стоимость появится после утверждения.');
  const buy=byId('buy-button');
  buy.disabled=!plan||!state.checkoutEnabled||state.busy;
  buy.textContent=state.busy?'Создаём заказ…':!plan?'Тариф пока недоступен':
    !state.checkoutEnabled?'Оплата пока недоступна':
    !state.loggedIn?'Войти для оплаты':state.renewalTargetId?'К оплате продления':'Перейти к оплате';
  const trial=byId('trial-button');
  const trialAvailable=state.trialOffers.includes(state.product) && state.loginEnabled;
  trial.disabled=!trialAvailable||state.busy;
  trial.textContent=state.busy?'Проверяем заявку…':
    !state.loginEnabled?'Бесплатный доступ временно недоступен':
    trialAvailable?(state.loggedIn?'🎁 Получить 24 часа бесплатно':'Войти и получить 24 часа бесплатно'):
    'Бесплатный доступ временно недоступен';
  text('checkout-hint',!plan?'Этот тариф пока не опубликован.':
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
      setup.addEventListener('click',()=>loadSubscription(a.id));
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
  const access=(payload.access||[]).find(a=>
    a.product==='vpn' &&
    (a.sourceOrderId===order.id ||
      (intent.renewalTargetId && a.id===intent.renewalTargetId)));
  const verified=order.state==='PAID';
  const ready=verified&&access?.state==='ACTIVE'&&access.secondsRemaining>0;
  notice.classList.remove('hidden');
  text('purchase-result-title',!verified?
    (order.state==='PENDING'?'⏳ Проверяем оплату':
      'Состояние заказа: '+(stateNames[order.state]||order.state)):
    ready?'✅ Ваш VPN готов!':'✅ Оплата подтверждена');
  text('purchase-result-text',!verified?
    'Пока нет подтверждения оплаты. Если деньги списаны, не оплачивайте повторно — проверьте статус или напишите в поддержку.':
    ready?'Подключите VPN в несколько нажатий. Выберите приложение для своего устройства.':
    'Деньги получены. VPN-сервер готовит подключение. Инструкция появится после подтверждения активации.');
  text('purchase-result-details',
    (order.title||productNames[order.product]||'VPN')+
    ' · '+(order.currency==='RUB'?formatMoney(order.amountMinor):String(order.amountMinor)+' ⭐'));
  const connect=byId('purchase-connect');
  connect.classList.toggle('hidden',!ready);
  connect.dataset.entitlementId=ready?access.id:'';
  byId('purchase-refresh').classList.toggle('hidden',ready);
}
function renderAccount(payload) {
  state.loggedIn=true;state.csrf=payload.csrf;
  byId('login-prompt').classList.add('hidden');
  byId('account-content').classList.remove('hidden');
  byId('logout-button').classList.remove('hidden');
  byId('auth-link').textContent='Мой доступ';
  byId('auth-link').href='#account';
  text('account-name','Мой аккаунт');
  text('account-subtitle','Защищённый вход · '+(payload.identity?.email||'Telegram'));
  const accesses=payload.access||[];
  const active=accesses.filter(a=>a.state==='ACTIVE' && a.secondsRemaining>0);
  text('active-count',active.length);
  const timed=active.filter(a=>a.secondsRemaining!==null).sort((a,b)=>a.secondsRemaining-b.secondsRemaining);
  text('days-left',timed.length?remaining(timed[0].secondsRemaining):'—');
  text('days-hint',timed.length?'До ближайшего окончания':'Нет активных подписок');
  renderAccess(accesses);renderOrders(payload.orders||[]);
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
    a.state==='PAID_PENDING_PROVISIONING');
  if(pendingVpn.length){
    const isPaid=pendingVpn.some(a=>(payload.orders||[]).some(o=>
      o.id===a.sourceOrderId && o.state==='PAID'));
    const card=byId('guest-trial-card');
    card.classList.remove('hidden');
    byId('guest-trial-title').textContent=isPaid?
      'Подключаем оплаченный VPN':'Подключаем пробный VPN';
    byId('guest-trial-status').textContent=isPaid?
      'Оплата подтверждена. VPN-сервер готовит подключение. Проверьте статус в личном кабинете.':
      'Пробные 24 часа начнутся только после подтверждения активации сервером.';
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
    state.emailLoginEnabled=data.emailLoginEnabled===true;
    state.trialOffers=Array.isArray(data.trialOffers)?data.trialOffers:[];
    // DNS and bundle tab availability follows the published server catalogue;
    // no second hardcoded "under development" switch in the browser.
    document.querySelectorAll('[data-product]').forEach(button=>{
      const offered=state.plans.some(p=>p.product===button.dataset.product);
      button.disabled=!offered;
      button.setAttribute('aria-disabled',String(!offered));
      button.classList.toggle('tab-soon',!offered);
    });
    if(!state.plans.some(p=>p.product===state.product && p.durationDays===state.days)){
      const preferred=state.plans.find(p=>p.product===state.product)||
        state.plans.find(p=>p.product==='vpn')||state.plans[0];
      if(preferred)setSelection(preferred.product,preferred.durationDays);
    }
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
    toast('Вход не завершён. Попробуйте вход по email или повторите Telegram.');
  state.purchaseIntent=readPurchaseIntent();
  if(url.searchParams.get('payment')==='returned')
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
    if(target.protocol!=='https:' || !(target.hostname==='payform.ru' ||
      target.hostname.endsWith('.payform.ru')))throw new Error('UNSAFE_PAYMENT_LINK');
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
      DNS_PAID_NOT_READY:'Оплата DNS пока не включена.',
    };
    const message=messages[error?.message] || 'Не удалось создать заказ или открыть оплату. Повторите попытку.';
    checkoutError(message);toast(message);
  }finally{state.busy=false;renderPlan();}
}
async function claimTrial(){
  if(state.busy)return;
  if(!state.trialOffers.includes(state.product)){
    toast('Бесплатный доступ сейчас недоступен.');return;
  }
  if(!state.loggedIn){
    if(!state.loginEnabled){toast('Вход пока недоступен.');return;}
    saveSelection();
    try{sessionStorage.setItem('mnebyvpn-pending-trial','1');}catch{}
    byId('account').scrollIntoView({behavior:'smooth'});
    toast('Для получения бесплатных суток сначала войдите по email или через привязанный Telegram.');
    return;
  }
  state.busy=true;renderPlan();
  const payload={product:state.product};
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
    toast(messages[response.status]||'Статус обновлён.');
    if(['GRANTED','PENDING','ALREADY_USED'].includes(response.status))consumeReferral();
    await refresh();
    if(response.status==='ALREADY_USED')
      byId('account').scrollIntoView({behavior:'smooth'});
    else if(['GRANTED','PENDING'].includes(response.status)) {
      if(typeof window!=='undefined'&&window.MnebyvpnJourney)
        window.MnebyvpnJourney.show('setup',true);
      else byId('guest-trial-card').scrollIntoView({behavior:'smooth',block:'center'});
    }
    return response.status;
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
async function beginEmail(event){
  event.preventDefault();
  if(!state.emailLoginEnabled)return;
  const email=byId('email-input').value.trim().toLowerCase();
  if(!email)return;
  const button=byId('email-send-button');
  button.disabled=true;
  text('email-status','Отправляем код с mnebyvpn@servgo.ru…');
  try{
    const payload={email};
    if(state.loggedIn&&state.emailLinkMode)payload.link=true;
    await api('/api/auth/email/start',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    pendingEmail=email;
    byId('email-verify-form').classList.remove('hidden');
    text('email-status','Письмо отправлено. Код действителен 10 минут. Проверьте также папку «Спам».');
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
  if(!/^[0-9]{6}$/.test(code)){text('email-status','Введите шесть цифр из письма.');return;}
  const button=byId('email-verify-button');
  button.disabled=true;
  try{
    await api('/api/auth/email/verify',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({email:pendingEmail,code})});
    pendingEmail=null;state.emailLinkMode=false;
    byId('email-verify-form').classList.add('hidden');
    await refresh();
    await consumePendingTrial();
    // The trial sign-in screen shares this exact OTP flow with the cabinet.
    // Do not scroll to a hidden account after the trial wizard has opened.
    if(!window.MnebyvpnJourney?.afterEmailAuthenticated?.())
      byId('account').scrollIntoView({behavior:'smooth'});
  }catch(error){
    text('email-status',error.message==='EMAIL_ALREADY_LINKED'?
      'Этот email уже привязан к другой учётной записи. Слияние не выполнено.':
      'Код неверен или истёк. Проверьте письмо или запросите новый.');
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
byId('purchase-refresh').addEventListener('click',refresh);
byId('purchase-connect').addEventListener('click',()=>{
  const id=byId('purchase-connect').dataset.entitlementId;
  if(id)loadSubscription(id);
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
applyLinkOptions();
async function consumePendingTrial(){
  if(state.loggedIn && state.trialOffers.includes('vpn')){
    let pending=false;
    try{pending=sessionStorage.getItem('mnebyvpn-pending-trial')==='1';
      sessionStorage.removeItem('mnebyvpn-pending-trial');
    }catch{}
    if(pending)await claimTrial();
  }
}
Promise.all([loadCatalog(),refresh()]).then(consumePendingTrial);
// Payment verification and provisioning can complete after the user returns.
setInterval(()=>{if(document.visibilityState==='visible' && state.loggedIn)refresh();},15000);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    refresh();
  }
});
