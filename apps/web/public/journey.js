/* Progressive mobile-first purchase flow backed by existing authenticated APIs.
 * This layer never decides payment status, subscription validity or customer identity.
 */
(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  const root=document.body;
  const landing=el('journey-landing'),setup=el('journey-setup');
  if(!landing||!setup||typeof state==='undefined')return;
  const allViews=new Set(['plans','account','payment','setup','support']);
  let view='plans', lastAccount=null, chosenPlatform='android', installed=false;
  const request=new URL(location.href);
  const paymentReturn=request.searchParams.get('payment')==='returned' ||
    request.pathname==='/payment/success' || request.pathname==='/payment/return';
  let paymentLanding=paymentReturn;
  const urlOrder=request.searchParams.get('order');
  if(paymentReturn&&urlOrder&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(urlOrder)){
    // Untrusted navigation is only a lookup hint; /api/me owns the actual order.
    state.purchaseIntent={orderId:urlOrder,renewalTargetId:null};
    try{sessionStorage.setItem('mnebyvpn-purchase-intent',JSON.stringify(state.purchaseIntent));}catch{}
  }
  function getRoute() {
    const hash=location.hash;
    if(paymentLanding && hash!=='#plans' && hash!=='#connect' && hash!=='#contact-support')return 'payment';
    if(hash==='#account')return 'account';
    if(hash==='#connect')return 'setup';
    if(hash==='#contact-support')return 'support';
    return 'plans';
  }
  function setView(next,writeHash=false){
    if(!allViews.has(next))return;
    view=next;
    root.dataset.journeyView=next;
    landing.hidden=next!=='plans';
    setup.hidden=next!=='setup';
    if(writeHash){
      const hash=next==='payment'?'#account':next==='setup'?'#connect':
        next==='support'?'#contact-support':next==='account'?'#account':'#plans';
      if(location.hash!==hash)history.replaceState(null,'',location.pathname+location.search+hash);
    }
    const heading=el('journey-payment-heading');
    if(heading)heading.hidden=next!=='payment';
    if(next==='setup')updateSetup();
    window.scrollTo?.({top:0,behavior:'instant'});
  }
  function priceFor(days) {
    const p=state.plans.find(p=>p.product==='vpn'&&p.durationDays===days);
    return p?.rubMinor?formatMoney(p.rubMinor):'—';
  }
  function updatePlan(){
    for(const button of landing.querySelectorAll('[data-journey-days]')){
      const day=Number(button.dataset.journeyDays);
      const selected=day===state.days;
      button.setAttribute('aria-pressed',String(selected));
      const price=landing.querySelector('[data-journey-price="'+day+'"]');
      if(price)price.textContent=priceFor(day);
      button.disabled=!state.plans.some(p=>p.product==='vpn'&&p.durationDays===day);
    }
    const original=el('buy-button'),buy=el('journey-buy');
    const plan=state.plans.find(p=>p.product==='vpn'&&p.durationDays===state.days);
    buy.disabled=original.disabled;
    buy.textContent=original.textContent;
    el('journey-trial').disabled=el('trial-button').disabled;
    el('journey-trial').hidden=!state.trialOffers.includes('vpn');
    el('journey-summary').textContent=plan?'VPN · '+state.days+' дней · '+priceFor(state.days):
      'Выбранный тариф пока не опубликован';
    el('journey-error').textContent=el('checkout-error').textContent||'';
  }
  function storeIntent(){
    const d={product:state.product,days:state.days,createdAt:Date.now()};
    try{sessionStorage.setItem('mnebyvpn-pending-checkout',JSON.stringify(d));}catch{}
  }
  function pendingIntent(){
    try{
      const v=JSON.parse(sessionStorage.getItem('mnebyvpn-pending-checkout')||'null');
      return v&&v.product==='vpn'&&[15,30,60,90].includes(v.days)&&
        Number.isSafeInteger(v.createdAt)&&Date.now()-v.createdAt<30*60*1000?v:null;
    }catch{return null;}
  }
  function clearIntent(){try{sessionStorage.removeItem('mnebyvpn-pending-checkout');}catch{}}
  function beginEmailLink(){
    setView('account',true);
    if(state.loggedIn){
      state.emailLinkMode=true;
      const pane=el('email-auth-panel');
      pane.classList.remove('hidden');
      el('email-input').focus();
      el('journey-error').textContent='Для оплаты нужно подтвердить email в своём аккаунте.';
    }
  }
  function beginCheckout(){
    if(!state.loggedIn){
      storeIntent();saveSelection();setView('account',true);
      el('email-input')?.focus();return;
    }
    if(!lastAccount?.identity?.email){
      storeIntent();beginEmailLink();return;
    }
    clearIntent();
    void purchase();
  }
  function resumeCheckout(){
    const pending=pendingIntent();
    if(!pending||!state.loggedIn||!state.plans.some(p=>p.product==='vpn'&&p.durationDays===pending.days))return;
    if(!lastAccount?.identity?.email){
      beginEmailLink();return;
    }
    state.product='vpn';
    setSelection('vpn',pending.days);
    clearIntent();
    void purchase();
  }
  const downloads={
    android:{name:'INCY',url:'https://play.google.com/store/apps/details?id=llc.itdev.incy',client:'incy'},
    ios:{name:'Karing',url:'https://apps.apple.com/ru/app/karing/id6472431552',client:'karing'},
    windows:{name:'INCY',url:'https://github.com/INCY-DEV/incy-platforms/releases',client:'incy'},
    macos:{name:'INCY',url:'https://github.com/INCY-DEV/incy-platforms/releases',client:'incy'},
    linux:{name:'INCY',url:'https://github.com/INCY-DEV/incy-platforms/releases',client:'incy'},
  };
  function setPlatform(platform){
    if(!Object.hasOwn(downloads,platform))return;
    chosenPlatform=platform;installed=false;
    el('journey-import-step').hidden=true;
    for(const button of setup.querySelectorAll('[data-journey-platform]')){
      button.setAttribute('aria-pressed',String(button.dataset.journeyPlatform===platform));
    }
    const info=downloads[platform];
    const link=el('journey-download');
    link.href=info.url;
    link.textContent='Скачать '+info.name;
    updateSetup();
  }
  function safeSubscriptionUrl(value){
    try{
      const url=new URL(value);
      return url.protocol==='https:'&&['cdn.servgo.ru','mnebyvpn.site'].includes(url.hostname)&&
        /^\/sub\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
    }catch{return false;}
  }
  function updateSetup(){
    const value=state.loggedIn?state.guestSubscriptionUrl:null;
    const valid=typeof value==='string'&&safeSubscriptionUrl(value);
    el('journey-setup-controls').hidden=!valid;
    el('journey-setup-status').textContent=valid?
      'Ваш VPN готов. Установите приложение и добавьте подписку.':
      'Проверяем активацию VPN на сервере. Если оплата прошла недавно, подключение может ещё подготавливаться.';
    if(!valid){
      el('journey-url').value='';
      el('journey-auto').removeAttribute('href');
      el('journey-import-step').hidden=true;
      return;
    }
    const source=downloads[chosenPlatform].client==='karing'?'guest-auto-karing':'guest-auto-incy';
    const auto=el('journey-auto'),href=el(source).getAttribute('href');
    if(href&&href.startsWith('https://')&&new URL(href).origin===new URL(value).origin)
      auto.href=href;
    else auto.removeAttribute('href');
    el('journey-url').value=value;
    el('journey-import-step').hidden=!installed;
  }
  async function copyLink(value,visibleField=el('journey-url')) {
    if(!safeSubscriptionUrl(value))return;
    try{await navigator.clipboard.writeText(value);toast('Ссылка скопирована.');}
    catch{visibleField.focus();visibleField.select();toast('Скопируйте выделенную ссылку.');}
  }
  async function copyEntitlement(id,field) {
    if(!state.loggedIn||!state.csrf)return;
    try{
      const res=await api('/api/vpn/subscription',{method:'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
        body:JSON.stringify({entitlementId:id})});
      if(!safeSubscriptionUrl(res.subscriptionUrl))throw Error('INVALID_LINK');
      // Show the actual field for fallback copy in browsers that disallow clipboard.
      state.guestSubscriptionUrl=res.subscriptionUrl;
      el('journey-url').value=res.subscriptionUrl;
      if(field)field.value=res.subscriptionUrl;
      await copyLink(res.subscriptionUrl,field||el('journey-url'));
    }catch{toast('Не удалось получить ссылку. Откройте «Как подключить».');}
  }
  function enhanceAccount(payload){
    lastAccount=payload;
    const active=(payload.access||[]).filter(a=>a.product==='vpn'&&a.state==='ACTIVE'&&a.secondsRemaining>0);
    const history=el('orders-list');
    if(history&&!el('journey-history')){
      const parent=history.parentElement;
      const oldHeading=parent.querySelector('h3');
      oldHeading?.remove();
      const details=document.createElement('details');
      details.className='journey-history';details.id='journey-history';
      const summary=document.createElement('summary');summary.textContent='История покупок';
      details.append(summary,history);
      parent.append(details);
    }
    el('access-list').querySelectorAll('.access-item').forEach((card,index)=>{
      const data=(payload.access||[])[index];
      if(!data||data.product!=='vpn'||data.state!=='ACTIVE'||data.secondsRemaining<=0)return;
      const existing=card.querySelector('.setup-button');
      if(existing)existing.textContent='Как подключить';
      if(!card.querySelector('.journey-copy-access')){
        const wrapper=document.createElement('div');
        wrapper.className='journey-account-link';
        const field=document.createElement('input');
        field.type='text';field.readOnly=true;
        field.setAttribute('aria-label','Ссылка для ручного добавления VPN');
        field.placeholder='Персональная ссылка — показать и копировать';
        const b=document.createElement('button');
        b.type='button';b.className='button button-secondary journey-copy-access';
        b.textContent='Показать и копировать';
        b.addEventListener('click',()=>void copyEntitlement(data.id,field));
        wrapper.append(field,b);
        card.append(wrapper);
      }
    });
    if(paymentLanding){
      setView('payment');
    }else if(view==='plans'&&!location.hash&&active.length>0){
      setView('account');
    }
    if(view==='payment'){
      const notice=el('purchase-result');
      const heading=el('journey-payment-heading');
      heading.textContent=notice.classList.contains('hidden')?
        'Ожидаем подтверждения заказа':'Результат покупки';
    }
    if(pendingIntent())resumeCheckout();
  }
  function loggedOut(){
    lastAccount=null;
    state.guestSubscriptionUrl=null;
    el('journey-setup-controls').hidden=true;
    el('journey-url').value='';
    if(paymentLanding)setView('payment');
  }
  const originalRenderPlan=window.renderPlan;
  const originalRenderAccount=window.renderAccount;
  const originalLoggedOut=window.renderLoggedOut;
  const originalVpnSetup=window.renderVpnSetup;
  window.renderPlan=function(...args){
    const result=originalRenderPlan(...args);updatePlan();
    if(pendingIntent()&&state.loggedIn&&lastAccount?.identity?.email)resumeCheckout();
    return result;
  };
  window.renderAccount=function(...args){
    const result=originalRenderAccount(...args);
    enhanceAccount(args[0]);updatePlan();return result;
  };
  window.renderLoggedOut=function(...args){
    const result=originalLoggedOut(...args);loggedOut();updatePlan();return result;
  };
  window.renderVpnSetup=function(...args){
    const result=originalVpnSetup(...args);
    installed=false;updateSetup();setView('setup',true);return result;
  };
  landing.querySelectorAll('[data-journey-days]').forEach(btn=>btn.addEventListener('click',()=>{
    setSelection('vpn',Number(btn.dataset.journeyDays));updatePlan();
  }));
  el('journey-buy').addEventListener('click',beginCheckout);
  el('journey-trial').addEventListener('click',async()=>{
    if(!state.loggedIn){setView('account',true);}
    await claimTrial();
    setView('setup',true);
  });
  setup.querySelectorAll('[data-journey-platform]').forEach(btn=>btn.addEventListener('click',()=>setPlatform(btn.dataset.journeyPlatform)));
  el('journey-installed').addEventListener('click',()=>{
    installed=true;updateSetup();el('journey-auto').focus();
  });
  el('journey-copy').addEventListener('click',()=>void copyLink(el('journey-url').value));
  // Following My VPN from the payment wizard deliberately exits result-only mode.
  document.querySelector('.journey-header-account')?.addEventListener('click',event=>{
    event.preventDefault();paymentLanding=false;setView('account',true);
  });
  document.querySelector('.journey-back')?.addEventListener('click',event=>{
    event.preventDefault();paymentLanding=false;setView('account',true);
  });
  window.addEventListener('hashchange',()=>{
    if(location.hash==='#account' && view==='setup')paymentLanding=false;
    setView(getRoute());
  });
  const card=el('guest-trial-card');
  el('journey-setup-slot').append(card);
  const ua=navigator.userAgent||'';
  if(/Android/i.test(ua))chosenPlatform='android';
  else if(/iPhone|iPad|iPod/i.test(ua))chosenPlatform='ios';
  else if(/Windows/i.test(ua))chosenPlatform='windows';
  else if(/Mac OS X|Macintosh/i.test(ua))chosenPlatform='macos';
  else if(/Linux/i.test(ua))chosenPlatform='linux';
  setPlatform(chosenPlatform);
  root.classList.add('journey-active');
  setView(getRoute());
  updatePlan();
  window.MnebyvpnJourney={show:setView,beginCheckout,updatePlan};
})();
