/* Progressive mobile-first purchase flow backed by existing authenticated APIs.
 * This layer never decides payment status, subscription validity or customer identity.
 */
(() => {
  'use strict';
  const el=id=>document.getElementById(id);
  const root=document.body;
  const landing=el('journey-landing'),setup=el('journey-setup'),paymentIntro=el('journey-payment-intro'),trialAuth=el('journey-trial-auth'),orderView=el('journey-order');
  const emailPanel=el('email-auth-panel'),emailHome=emailPanel?.parentNode;
  if(!landing||!setup||typeof state==='undefined')return;
  const allViews=new Set(['plans','account','checkout','payment','setup','support','trial-auth']);
  let view='plans', lastAccount=null, chosenPlatform='android', installed=false;
  const frontFrame=el('journey-front-frame');
  const frontChannel='mnebyvpn-front-v1';
  let frontReady=false;
  function syncFront(){
    if(!frontReady||!frontFrame?.contentWindow)return;
    frontFrame.contentWindow.postMessage({
      channel:frontChannel,type:'sync',days:state.days,
      offers:[15,30,60,90].map(days=>{
        const plan=state.plans.find(p=>p.product==='vpn'&&p.durationDays===days);
        return {days,available:Boolean(plan),price:plan?.rubMinor?formatMoney(plan.rubMinor):'—'};
      }),
      buyDisabled:Boolean(el('journey-buy').disabled),
      buyText:el('journey-buy').textContent||'Оплата пока недоступна',
      trialAvailable:state.trialOffers.includes('vpn'),
      trialDisabled:Boolean(el('journey-trial').disabled),
      error:el('journey-error').textContent||'',
    },location.origin);
  }
  window.addEventListener('message',event=>{
    if(!frontFrame||event.source!==frontFrame.contentWindow||event.origin!==location.origin||
       event.data?.channel!==frontChannel)return;
    const msg=event.data;
    if(msg.type==='ready'){frontReady=true;syncFront();return;}
    if(msg.type==='height'){
      const h=Number(msg.height);
      if(Number.isFinite(h)&&h>=540&&h<=1600)frontFrame.style.height=Math.ceil(h)+'px';
      return;
    }
    if(!frontReady)return;
    if(msg.type==='plans'){paymentLanding=false;setView('plans',true);return;}
    if(msg.type==='about'){
      document.querySelector('[data-about-open="about"]')?.click();return;
    }
    if(msg.type==='roadmap'){
      document.querySelector('[data-about-open="roadmap"]')?.click();return;
    }
    if(msg.type==='account'){paymentLanding=false;setView('account',true);return;}
    if(msg.type==='support'){paymentLanding=false;setView('support',true);return;}
    if(view!=='plans')return;
    if(msg.type==='select'){
      const days=Number(msg.days);
      if([15,30,60,90].includes(days)&&state.plans.some(p=>p.product==='vpn'&&p.durationDays===days))
        setSelection('vpn',days);
      syncFront();return;
    }
    if(msg.type==='buy'){
      if(!el('journey-buy').disabled)el('journey-buy').click();
      return;
    }
    if(msg.type==='trial'&&!el('journey-trial').disabled)
      el('journey-trial').click();
  });
  // The iframe can finish loading BEFORE deferred journey.js installs the
  // postMessage listener (notably on fast/cached Android connections).
  // Recover from that race by checking its already-loaded document and by
  // resyncing on every subsequent iframe load. The child also retries ready.
  if(frontFrame){
    frontFrame.addEventListener('load',()=>{
      frontReady=true;
      syncFront();
    });
    try {
      if(frontFrame.contentDocument?.readyState==='complete'){
        frontReady=true;
        syncFront();
      }
    } catch { /* Child retries ready once its origin is available. */ }
  }
  const autoSetupOrders=new Set();
  const lastSetupAttempt=new Map();
  const request=new URL(location.href);
  const paymentReturn=['returned','return'].includes(request.searchParams.get('payment')) ||
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
    if(paymentLanding)return 'payment';
    if(hash==='#try')return 'trial-auth';
    if(hash==='#checkout')return 'checkout';
    if(hash==='#account')return 'account';
    if(hash==='#connect')return 'setup';
    if(hash==='#contact-support')return 'support';
    return 'plans';
  }
  function setView(next,writeHash=false){
    if(!allViews.has(next))return;
    if(view==='trial-auth'&&next!=='trial-auth'){
      restoreEmailPanel();
      // Explicitly leaving the sign-in screen cancels the unsubmitted trial.
      // An external Telegram OIDC redirect does not call setView, and keeps
      // the intent across the redirect so existing linked users can continue.
      if(!state.loggedIn){
        try{sessionStorage.removeItem('mnebyvpn-pending-trial');}catch{}
      }
    }
    view=next;
    root.dataset.journeyView=next;
    landing.hidden=next!=='plans';
    setup.hidden=next!=='setup';
    if(orderView)orderView.hidden=next!=='checkout';
    if(paymentIntro)paymentIntro.hidden=next!=='payment';
    if(trialAuth)trialAuth.hidden=next!=='trial-auth';
    if(next==='trial-auth')mountTrialEmail();
    if(next==='checkout')updateOrder();
    if(writeHash){
      if(next!=='payment')paymentLanding=false;
      const hash=next==='payment'?'#account':next==='checkout'?'#checkout':next==='trial-auth'?'#try':next==='setup'?'#connect':
        next==='support'?'#contact-support':next==='account'?'#account':'#plans';
      if(location.hash!==hash)history.replaceState(null,'',location.pathname+location.search+hash);
    }
    const heading=el('journey-payment-heading');
    if(heading)heading.hidden=next!=='payment';
    if(next==='setup')updateSetup();
    if(next==='plans')syncFront();
    window.scrollTo?.({top:0,behavior:'instant'});
  }
  // The same existing email OTP forms are used in both the cabinet and trial
  // entry screen: never create duplicate inputs/IDs or a second auth service.
  function updateTrialAuth(){
    if(!trialAuth)return;
    const emailOn=state.emailLoginEnabled===true;
    el('journey-email-unavailable').hidden=emailOn;
    if(view==='trial-auth'&&emailPanel){
      emailPanel.classList.toggle('hidden',!emailOn);
    }
    const telegram=el('journey-trial-telegram');
    if(telegram){
      const enabled=state.telegramLoginEnabled===true;
      if(enabled)telegram.href='/auth/login';
      else telegram.removeAttribute('href');
      telegram.setAttribute('aria-disabled',String(!enabled));
      telegram.classList.toggle('journey-option-disabled',!enabled);
    }
  }
  function mountTrialEmail(){
    const mount=el('journey-email-mount');
    if(mount&&emailPanel&&emailPanel.parentNode!==mount)mount.append(emailPanel);
    updateTrialAuth();
  }
  function restoreEmailPanel(){
    if(emailPanel&&emailHome&&emailPanel.parentNode!==emailHome){
      emailHome.insertBefore(emailPanel,el('account-content'));
      emailPanel.classList.toggle('hidden',!state.emailLoginEnabled||state.loggedIn&&!state.emailLinkMode);
    }
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
    const trialAvailable=state.trialOffers.includes('vpn');
    el('journey-trial').disabled=el('trial-button').disabled;
    el('journey-trial-offer').hidden=!trialAvailable;
    updateTrialAuth();
    el('journey-summary').textContent=plan?'VPN · '+state.days+' дней · '+priceFor(state.days):
      'Выбранный тариф пока не опубликован';
    el('journey-error').textContent=el('checkout-error').textContent||'';
    syncFront();
  }
  function updateOrder(){
    const plan=state.plans.find(p=>p.product==='vpn'&&p.durationDays===state.days);
    const verified=state.loggedIn&&lastAccount?.identity?.email;
    el('journey-order-period').textContent='VPN · '+state.days+' дней';
    el('journey-order-price').textContent=plan?priceFor(state.days):'—';
    el('journey-order-email').textContent=verified?lastAccount.identity.email:'Требуется вход по email';
    const pay=el('journey-order-pay');
    pay.disabled=!plan||!state.checkoutEnabled||!verified||state.busy;
    pay.textContent=state.busy?'Оформляем заказ…':
      !state.checkoutEnabled?'Оплата временно недоступна':
      !verified?'Войдите для оплаты':'Перейти к защищённой оплате';
    el('journey-order-error').textContent=el('checkout-error')?.textContent||'';
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
    setView('checkout',true);
  }
  function resumeCheckout(){
    const pending=pendingIntent();
    if(!pending||!state.loggedIn||!state.plans.some(p=>p.product==='vpn'&&p.durationDays===pending.days))return;
    if(!lastAccount?.identity?.email){
      beginEmailLink();return;
    }
    // Clear before setSelection, which synchronously triggers renderPlan.
    // Otherwise its wrapper would recursively resume the same checkout.
    clearIntent();
    state.product='vpn';
    setSelection('vpn',pending.days);
    setView('checkout',true);
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
      const intent=state.purchaseIntent||readPurchaseIntent();
      const order=intent&&(payload.orders||[]).find(item=>item.id===intent.orderId);
      const heading=el('journey-payment-heading'),description=el('journey-payment-info');
      if(!order){
        heading.textContent='Проверяем ваш заказ';
        description.textContent='Войдите в аккаунт, с которого оформляли заказ. Оплата и подключение проверяются сервером.';
      }else if(order.state==='PAID'){
        const ready=(payload.access||[]).some(a=>a.product==='vpn'&&a.state==='ACTIVE'&&a.secondsRemaining>0&&
          (a.sourceOrderId===order.id || a.id===intent.renewalTargetId));
        heading.textContent=ready?'VPN готов к подключению':'Оплата подтверждена';
        description.textContent=ready?'Подготавливаем инструкцию для вашего устройства…':
          'Платёж получен. Ожидаем подтверждения активации VPN на сервере.';
      }else if(order.state==='REFUNDED'||order.state==='CANCELLED'){
        heading.textContent='Оплаченного доступа нет';
        description.textContent='Статус заказа: '+(stateNames[order.state]||order.state)+'. Проверьте историю или напишите в поддержку.';
      }else{
        heading.textContent='Проверяем оплату';
        description.textContent='Подтверждения оплаты пока нет. Если деньги списаны, не создавайте повторный платёж.';
      }
    }
    // Open the installer only after the verified PAID order has an ACTIVE
    // entitlement. A redirect alone can never trigger provisioning.
    if(paymentLanding){
      const intent=state.purchaseIntent||readPurchaseIntent();
      const order=intent&&(payload.orders||[]).find(o=>o.id===intent.orderId);
      const entitlement=order?.state==='PAID'&&(payload.access||[]).find(a=>
        a.product==='vpn'&&a.state==='ACTIVE'&&a.secondsRemaining>0&&
        (a.sourceOrderId===order.id || a.id===intent.renewalTargetId));
      if(entitlement&&!autoSetupOrders.has(order.id)){
        autoSetupOrders.add(order.id);
        void loadSubscription(entitlement.id);
      }
    }
    // Trial activation can finish asynchronously after the initial request.
    // Automatically fetch its verified subscription when a polling refresh
    // reports ACTIVE, without asking the buyer to press a check button.
    if(view==='setup'&&!state.guestSubscriptionUrl&&!state.setupLoading&&active.length){
      const target=active[0];
      const last=lastSetupAttempt.get(target.id)||0;
      if(Date.now()-last>30000){
        lastSetupAttempt.set(target.id,Date.now());
        void loadSubscription(target.id);
      }
    }
    if(pendingIntent())resumeCheckout();
  }
  function loggedOut(){
    lastAccount=null;
    state.guestSubscriptionUrl=null;
    el('journey-setup-controls').hidden=true;
    el('journey-url').value='';
    if(view==='setup')setView('account',true);
    else if(paymentLanding)setView('payment');
  }
  const originalShowPaymentLink=window.showPaymentLink;
  window.showPaymentLink=function(url){
    const result=originalShowPaymentLink(url);
    const link=el('journey-payment-link');
    const orderLink=el('journey-order-link');
    if(url){
      link.href=url;link.classList.remove('hidden');
      orderLink.href=url;orderLink.classList.remove('hidden');
    }else{
      link.removeAttribute('href');link.classList.add('hidden');
      orderLink.removeAttribute('href');orderLink.classList.add('hidden');
    }
    return result;
  };
  const originalRenderPlan=window.renderPlan;
  const originalRenderAccount=window.renderAccount;
  const originalLoggedOut=window.renderLoggedOut;
  const originalVpnSetup=window.renderVpnSetup;
  window.renderPlan=function(...args){
    const result=originalRenderPlan(...args);updatePlan();updateOrder();
    if(pendingIntent()&&state.loggedIn&&lastAccount?.identity?.email)resumeCheckout();
    return result;
  };
  window.renderAccount=function(...args){
    const result=originalRenderAccount(...args);
    enhanceAccount(args[0]);updatePlan();updateOrder();return result;
  };
  window.renderLoggedOut=function(...args){
    const result=originalLoggedOut(...args);loggedOut();updatePlan();updateOrder();return result;
  };
  window.renderVpnSetup=function(...args){
    const result=originalVpnSetup(...args);
    installed=false;updateSetup();setView('setup',true);return result;
  };
  landing.querySelectorAll('[data-journey-days]').forEach(btn=>btn.addEventListener('click',()=>{
    setSelection('vpn',Number(btn.dataset.journeyDays));updatePlan();
  }));
  el('journey-buy').addEventListener('click',beginCheckout);
  el('journey-order-pay').addEventListener('click',()=>{
    updateOrder();
    if(el('journey-order-pay').disabled)return;
    void purchase();
  });
  el('journey-order-back').addEventListener('click',event=>{
    event.preventDefault();setView('plans',true);
  });
  el('journey-trial').addEventListener('click',async()=>{
    if(!state.trialOffers.includes('vpn'))return;
    if(!state.loggedIn){
      saveSelection();
      try{sessionStorage.setItem('mnebyvpn-pending-trial','1');}catch{}
      setView('trial-auth',true);
      if(state.emailLoginEnabled)el('email-input')?.focus();
      return;
    }
    const result=await claimTrial();
    setView(['GRANTED','PENDING'].includes(result)?'setup':'account',true);
  });
  el('journey-trial-back')?.addEventListener('click',event=>{
    event.preventDefault();
    setView('plans',true);
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
  document.querySelector('#journey-payment-to-account')?.addEventListener('click',event=>{
    event.preventDefault();paymentLanding=false;setView('account',true);
  });
  // Only the install wizard's back link belongs here. The new trial sign-in
  // page has its own Back action; a global .journey-back selector would bind
  // both handlers to the trial link and incorrectly send users to the cabinet.
  setup.querySelector('.journey-back')?.addEventListener('click',event=>{
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
  else if(/iPhone|iPad|iPod/i.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))chosenPlatform='ios';
  else if(/Windows/i.test(ua))chosenPlatform='windows';
  else if(/Mac OS X|Macintosh/i.test(ua))chosenPlatform='macos';
  else if(/Linux/i.test(ua))chosenPlatform='linux';
  setPlatform(chosenPlatform);
  if(state.product!=='vpn')setSelection('vpn',state.days);
  root.classList.add('journey-active');
  setView(getRoute());
  updatePlan();
  updateOrder();
  window.MnebyvpnJourney={show:setView,beginCheckout,updatePlan,
    afterEmailAuthenticated(){
      if(view==='setup')return true; // successful trial already opened installer
      if(view==='trial-auth'){
        setView('account',true);return true; // denied/unavailable trial: show real cabinet
      }
      return false;
    },
  };
})();
