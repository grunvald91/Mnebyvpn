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
  let frontNaturalHeight=540;
  // Extend the visual frame to the *host* viewport, not the child's height:
  // this leaves the full background visible on tall Android devices.
  const sizeFront=()=>{
    if(!frontFrame)return;
    const vh=Math.ceil(document.documentElement?.clientHeight||window.innerHeight);
    const target=Math.max(frontNaturalHeight,vh);
    const value=target+'px';
    if(frontFrame.style.height!==value)frontFrame.style.height=value;
  };
  window.addEventListener('resize',sizeFront);
  window.addEventListener('load',sizeFront);
  sizeFront();
  // The hidden storefront must not keep decoding video while the user
  // navigates the native, much faster personal cabinet.
  function syncVisual(){
    if(!frontFrame?.contentWindow)return;
    frontFrame.contentWindow.postMessage({
      channel:frontChannel,type:'visual',active:view==='plans',
    },location.origin);
  }
  function syncFront(){
    if(!frontReady||!frontFrame?.contentWindow)return;
    const offers=[];
    for(const product of ['vpn','smart_dns','bundle']){
      for(const days of [15,30,60,90]){
        const plan=state.plans.find(p=>p.product===product&&p.durationDays===days);
        offers.push({
          product,days,
          available:Boolean(plan),
          price:plan?.rubMinor?formatMoney(plan.rubMinor):'—',
          title:plan?.title||'',
          deviceLimit:plan?.deviceLimit||(product==='bundle'?3:1),
        });
      }
    }
    frontFrame.contentWindow.postMessage({
      channel:frontChannel,type:'sync',product:state.product,days:state.days,
      offers,
      buyDisabled:Boolean(el('journey-buy').disabled),
      buyText:el('journey-buy').textContent||'Оплата подключается',
      trialAvailable:state.trialOffers.includes('vpn')||state.trialOffers.includes('smart_dns'),
      trialOffers:state.trialOffers,
      trialDisabled:Boolean(el('journey-trial').disabled),
      error:el('journey-error').textContent||'',
    },location.origin);
  }
  window.addEventListener('message',event=>{
    if(!frontFrame||event.source!==frontFrame.contentWindow||event.origin!==location.origin||
       event.data?.channel!==frontChannel)return;
    const msg=event.data;
    if(msg.type==='ready'){frontReady=true;syncFront();syncVisual();return;}
    if(msg.type==='height'){
      const h=Number(msg.height);
      if(Number.isFinite(h)&&h>=380&&h<=2400){
        frontNaturalHeight=Math.ceil(h);
        sizeFront();
      }
      return;
    }
    if(!frontReady)return;
    if(msg.type==='refresh'){void loadCatalog();return;}
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
      const nextProduct=['vpn','smart_dns','bundle'].includes(msg.product)?msg.product:state.product;
      const days=Number(msg.days);
      if([15,30,60,90].includes(days)){
        setSelection(nextProduct,days);
      }
      syncFront();return;
    }
    if(msg.type==='buy'){
      if(!el('journey-buy').disabled)el('journey-buy').click();
      return;
    }
    if(msg.type==='trial'&&!el('journey-trial').disabled){
      state.trialProduct=msg.product==='smart_dns'?'smart_dns':'vpn';
      el('journey-trial').click();
    }
  });
  // The iframe can finish loading BEFORE deferred journey.js installs the
  // postMessage listener (notably on fast/cached Android connections).
  // Recover from that race by checking its already-loaded document and by
  // resyncing on every subsequent iframe load. The child also retries ready.
  if(frontFrame){
    frontFrame.addEventListener('load',()=>{
      frontReady=true;
      syncFront();
      syncVisual();
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
  function updatePaymentAction(){
    if(!paymentIntro)return;
    const button=el('journey-payment-to-account');
    if(button)button.textContent=state.loggedIn?'Открыть мой VPN':'Войти и проверить заказ';
    if(!state.loggedIn){
      el('journey-payment-heading').textContent='Проверка заказа';
      el('journey-payment-info').textContent=
        'Чтобы проверить оплату, войдите в аккаунт, которым оформляли заказ. Возврат на сайт сам по себе не подтверждает платёж.';
    }
  }
  // Keep exactly one primary heading in each interactive view. The source
  // HTML has one H1 on the no-JavaScript fallback; only the active view is
  // promoted after progressive enhancement. IDs, links and text stay intact.
  const headingIds=[
    'legacy-hero-title','journey-front-heading','journey-title','journey-trial-title','journey-setup-title',
    'journey-order-title','journey-payment-heading','journey-account-title',
    'account-name','contact-support-title',
  ];
  const headingByView={
    plans:'journey-front-heading','trial-auth':'journey-trial-title',
    setup:'journey-setup-title',checkout:'journey-order-title',
    payment:'journey-payment-heading',account:'account-name',
    support:'contact-support-title',
  };
  function syncPrimaryHeading(next){
    const primary=headingByView[next];
    if(!primary)return;
    for(const id of headingIds){
      const node=el(id);
      if(!node)continue;
      const desired=id===primary?'h1':id==='account-name'?'strong':'h2';
      if(node.localName===desired)continue;
      const replacement=document.createElement(desired);
      for(const attr of node.attributes)replacement.setAttribute(attr.name,attr.value);
      replacement.replaceChildren(...node.childNodes);
      node.replaceWith(replacement);
    }
  }
  function setView(next,writeHash=false){
    if(!allViews.has(next))return;
    if(view==='trial-auth'&&next!=='trial-auth'){
      restoreEmailPanel();
      // Explicitly leaving the sign-in screen cancels the unsubmitted trial.
      // An external Telegram OIDC redirect does not call setView, and keeps
      // the intent across the redirect so existing linked users can continue.
      if(!state.loggedIn){
        try{
          sessionStorage.removeItem('mnebyvpn-pending-trial');
          sessionStorage.removeItem('mnebyvpn-pending-trial-product');
        }catch{}
      }
    }
    view=next;
    root.dataset.journeyView=next;
    landing.hidden=next!=='plans';
    setup.hidden=next!=='setup';
    if(orderView)orderView.hidden=next!=='checkout';
    if(paymentIntro)paymentIntro.hidden=next!=='payment';
    if(trialAuth)trialAuth.hidden=next!=='trial-auth';
    syncPrimaryHeading(next);
    if(next==='trial-auth')mountTrialEmail();
    if(next==='checkout')updateOrder();
    if(next==='payment')updatePaymentAction();
    if(writeHash){
      if(next!=='payment')paymentLanding=false;
      const hash=next==='payment'?'#account':next==='checkout'?'#checkout':next==='trial-auth'?'#try':next==='setup'?'#connect':
        next==='support'?'#contact-support':next==='account'?'#account':'#plans';
      if(location.hash!==hash)history.replaceState(null,'',location.pathname+location.search+hash);
    }
    const heading=el('journey-payment-heading');
    if(heading)heading.hidden=next!=='payment';
    if(next==='setup'){
      updateSetup();
      const activeDns=(lastAccount?.access||[]).filter(a=>a.product==='smart_dns'&&a.state==='ACTIVE'&&a.secondsRemaining>0);
      if(activeDns.length){
        const dnsTarget=activeDns[0];
        const isTrial=isTrialAccess(dnsTarget);
        const dnsSlot=el('journey-dns-setup-slot'),proxySlot=el('journey-proxy-setup-slot');
        const needsDns=!dnsSlot?.children?.length&&(state.personalDnsEnabled||state.appleDnsProfileEnabled);
        const needsProxy=!isTrial&&!proxySlot?.children?.length&&state.telegramProxyBonusEnabled;
        const lastDns=lastSetupAttempt.get('dns:'+dnsTarget.id)||0;
        if((needsDns||needsProxy)&&Date.now()-lastDns>30000){
          lastSetupAttempt.set('dns:'+dnsTarget.id,Date.now());
          const tasks=[];
          if(needsDns&&typeof ensurePersonalDnsCredentials==='function'){
            tasks.push(ensurePersonalDnsCredentials(dnsTarget.id,{autoIssue:true,targets:[dnsSlot]}).catch(()=>{}));
          }
          if(needsProxy&&typeof ensureProxyCredentials==='function'){
            tasks.push(ensureProxyCredentials(dnsTarget.id,[proxySlot]).catch(()=>{}));
          }
          void Promise.all(tasks).then(()=>updateSetup());
        }
      }
    }
    if(next==='plans')syncFront();
    syncVisual();
    window.scrollTo?.({top:0,behavior:'instant'});
  }
  // The same existing email OTP forms are used in both the cabinet and trial
  // entry screen: never create duplicate inputs/IDs or a second auth service.
  function updateTrialAuth(){
    if(!trialAuth)return;
    const isDns=state.trialProduct==='smart_dns';
    const title=el('journey-trial-title');
    if(title)title.textContent=isDns?'Ваши 24 часа Smart DNS':'Ваши 24 часа VPN';
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
      // An unavailable secondary login must not consume an entire mobile
      // screen. Only show the Telegram method when its login is enabled.
      const method=telegram.closest?.('.journey-telegram-method');
      if(method)method.hidden=!enabled;
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
  function validDays(product,day){
    return ['vpn','smart_dns','bundle'].includes(product)&&[15,30,60,90].includes(day);
  }
  function priceFor(days){
    const p=state.plans.find(p=>p.product===state.product&&p.durationDays===days);
    return p?.rubMinor?formatMoney(p.rubMinor):'—';
  }
  function updatePlan(){
    el('journey-front-stage').hidden=false;
    const labels={vpn:'VPN Лайт',smart_dns:'Smart Доступ',bundle:'Экосистема «3 в 1»'};
    el('journey-title').textContent=labels[state.product]||'Экосистема «3 в 1»';
    landing.querySelectorAll('[data-journey-product]').forEach(button=>{
      button.setAttribute('aria-pressed',String(button.dataset.journeyProduct===state.product));
    });
    for(const button of landing.querySelectorAll('[data-journey-days]')){
      const day=Number(button.dataset.journeyDays),valid=validDays(state.product,day);
      button.hidden=!valid;
      button.setAttribute('aria-pressed',String(day===state.days));
      const price=landing.querySelector('[data-journey-price="'+day+'"]');
      if(price)price.textContent=priceFor(day);
      button.disabled=!valid||!state.plans.some(p=>p.product===state.product&&p.durationDays===day);
    }
    const original=el('buy-button'),buy=el('journey-buy');
    const plan=state.plans.find(p=>p.product===state.product&&p.durationDays===state.days);
    buy.disabled=original.disabled;
    buy.textContent=original.textContent;
    const trialAvailable=state.trialOffers.includes('vpn')||state.trialOffers.includes('smart_dns');
    el('journey-trial').disabled=el('trial-button').disabled;
    el('journey-trial-offer').hidden=!trialAvailable;
    updateTrialAuth();
    const title=labels[state.product]||'Экосистема «3 в 1»';
    el('journey-summary').textContent=plan?
      title+' · '+state.days+' дней · '+priceFor(state.days):
      'Тариф временно недоступен.';
    el('journey-error').textContent=el('checkout-error').textContent||'';
    syncFront();
  }
  function updateOrder(){
    const plan=state.plans.find(p=>p.product===state.product&&p.durationDays===state.days);
    const verified=state.loggedIn&&lastAccount?.identity?.email;
    const labels={vpn:'VPN Лайт',smart_dns:'Smart Доступ',bundle:'Экосистема «3 в 1»'};
    if(orderView){
      for(const btn of orderView.querySelectorAll?.('[data-order-product]')||[]){
        const active=btn.dataset.orderProduct===state.product;
        btn.setAttribute('aria-pressed',String(active));
      }
      for(const btn of orderView.querySelectorAll?.('[data-order-days]')||[]){
        const day=Number(btn.dataset.orderDays),valid=validDays(state.product,day);
        btn.hidden=!valid;
        btn.setAttribute('aria-pressed',String(day===state.days));
        const priceEl=orderView.querySelector?.('[data-order-price="'+day+'"]');
        if(priceEl)priceEl.textContent=priceFor(day);
        btn.disabled=!valid||!state.plans.some(p=>p.product===state.product&&p.durationDays===day);
      }
    }
    el('journey-order-period').textContent=(labels[state.product]||'Экосистема «3 в 1»')+' · '+state.days+' дней';
    el('journey-order-price').textContent=plan?priceFor(state.days):'—';
    el('journey-order-email').textContent=verified?lastAccount.identity.email:'Требуется вход по email';
    const pay=el('journey-order-pay');
    pay.disabled=!plan||!state.checkoutEnabled||!verified||state.busy;
    pay.textContent=state.busy?'Оформляем заказ…':
      !state.checkoutEnabled?'Оплата подключается (ЮKassa)':
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
      return v&&validDays(v.product,v.days)&&
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
    const current=state.plans.find(p=>p.product===state.product&&p.durationDays===state.days);
    if(!current||!state.checkoutEnabled)return;
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
    if(!pending||!state.loggedIn||!state.plans.some(p=>p.product===pending.product&&p.durationDays===pending.days))return;
    if(!lastAccount?.identity?.email){
      beginEmailLink();return;
    }
    // Clear before setSelection, which synchronously triggers renderPlan.
    // Otherwise its wrapper would recursively resume the same checkout.
    clearIntent();
    state.product=pending.product;
    setSelection(pending.product,pending.days);
    setView('checkout',true);
  }
  const downloads={
    android:{
      name:'INCY',url:'https://play.google.com/store/apps/details?id=llc.itdev.incy',client:'incy',
      altUrl:'https://github.com/INCY-DEV/incy-platforms/releases/download/latest/Incy.apk',
      altText:'📦 Скачать INCY APK напрямую (GitHub)',
      note:'Для Android нужен клиент INCY (Google Play или прямой APK).'
    },
    ios:{
      name:'Karing',url:'https://apps.apple.com/ru/app/karing/id6472431552',client:'karing',
      note:'Для iPhone и iPad нужен бесплатный клиент Karing из App Store.'
    },
    windows:{
      name:'INCY',url:'https://github.com/INCY-DEV/incy-platforms/releases/download/latest/incy-windows-setup.exe',client:'incy',
      altUrl:'https://github.com/INCY-DEV/incy-platforms/releases',
      altText:'📦 Все сборки INCY на GitHub',
      note:'Для Windows скачайте установщик INCY Setup (.exe).'
    },
    macos:{
      name:'INCY',url:'https://github.com/INCY-DEV/incy-platforms/releases',client:'incy',
      altUrl:'https://apps.apple.com/ru/app/karing/id6472431552',
      altText:'🍏 Альтернатива: Karing в App Store',
      note:'Для macOS скачайте INCY под ваш процессор (Apple Silicon или Intel) либо Karing.'
    },
    linux:{
      name:'INCY',url:'https://github.com/INCY-DEV/incy-platforms/releases',client:'incy',
      note:'Для Linux скачайте подходящий пакет INCY с официального GitHub.'
    },
  };
  const platformNames={android:'Android',ios:'iPhone',windows:'Windows',macos:'macOS',linux:'Linux'};
  function setPlatform(platform){
    if(!Object.hasOwn(downloads,platform))return;
    chosenPlatform=platform;installed=false;
    el('journey-import-step').hidden=true;
    el('journey-platform-name').textContent=platformNames[platform];
    el('journey-platform-grid').hidden=true;
    el('journey-platform-change').setAttribute('aria-expanded','false');
    for(const button of setup.querySelectorAll('[data-journey-platform]')){
      button.setAttribute('aria-pressed',String(button.dataset.journeyPlatform===platform));
    }
    const info=downloads[platform];
    const link=el('journey-download');
    link.href=info.url;
    link.textContent='Скачать '+info.name;
    const alt=el('journey-download-alt');
    if(alt){
      if(info.altUrl){
        alt.href=info.altUrl;alt.textContent=info.altText||info.altUrl;
        alt.classList.remove('hidden');
      }else{
        alt.removeAttribute('href');alt.classList.add('hidden');
      }
    }
    const note=el('journey-app-note');
    if(note&&info.note)note.textContent=info.note;
    updateSetup();
  }
  function isTrialAccess(access){
    return Boolean(access&&(lastAccount?.orders||[]).some(o=>o.id===access.sourceOrderId&&o.state==='TRIAL'));
  }
  function safeSubscriptionUrl(value){
    try{
      const url=new URL(value);
      return url.protocol==='https:'&&['cdn.servgo.ru','mnebyvpn.site'].includes(url.hostname)&&
        /^\/sub\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
    }catch{return false;}
  }
  function updateSetup(){
    // Keep explicit user confirmation: device detection alone never enables
    // automatic import, even after returning from the app store.
    const installButton=el('journey-installed');
    installButton.setAttribute('aria-pressed',String(installed));
    installButton.textContent=installed?'✓ Приложение установлено':'Я установил приложение';
    // After explicit install confirmation, show the import step instead of
    // repeating the three-step installation guide on a compact phone screen.
    const installGuide=el('journey-vpn-guide');
    if(installGuide)installGuide.hidden=installed;
    const value=state.loggedIn?state.guestSubscriptionUrl:null;
    const valid=typeof value==='string'&&safeSubscriptionUrl(value);
    const activeDnsItem=(lastAccount?.access||[]).find(a=>a.product==='smart_dns'&&a.state==='ACTIVE'&&a.secondsRemaining>0);
    const activeDns=Boolean(activeDnsItem);
    const activeDnsTrial=isTrialAccess(activeDnsItem);
    const dnsSlot=el('journey-dns-setup-slot'),proxySlot=el('journey-proxy-setup-slot');
    const hasDnsContent=Boolean((dnsSlot?.children?.length||0)>0||(proxySlot?.children?.length||0)>0);
    const dnsWrap=el('journey-dns-proxy-setup');
    if(dnsWrap)dnsWrap.hidden=!(activeDns&&hasDnsContent);
    el('journey-setup-controls').hidden=!valid;
    const title=el('journey-setup-title');
    if(title){
      title.textContent=valid&&activeDns?'Подключите «3 в 1»':
        activeDns&&!valid?(activeDnsTrial?'Подключите Smart DNS (24 часа)':'Подключите Smart DNS и Прокси'):'Подключите VPN';
    }
    el('journey-setup-status').textContent=valid?
      (activeDns?'Экосистема «3 в 1» готова: настройте VPN, Smart DNS и Telegram-прокси ниже.':
        'Ваш VPN готов. Установите приложение, добавьте подписку и включите защиту.'):
      activeDns?(activeDnsTrial
        ?'Ваши 24 часа Smart DNS готовы! Персональный профиль Apple (.mobileconfig) и DoT-адрес выданы ниже.'
        :'Ваш Smart Доступ готов! Профиль и WebSocket-прокси для Telegram выданы ниже.'):
      'Проверяем активацию на сервере. Если оплата прошла недавно, подключение подготавливается.';
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
    const activeDns=(payload.access||[]).filter(a=>a.product==='smart_dns'&&a.state==='ACTIVE'&&a.secondsRemaining>0);
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
      if(!data||data.state!=='ACTIVE'||data.secondsRemaining<=0)return;
      if(data.product==='smart_dns'){
        if(typeof ensurePersonalDnsCredentials==='function'&&(state.personalDnsEnabled||state.appleDnsProfileEnabled)){
          void ensurePersonalDnsCredentials(data.id,{autoIssue:true,targets:[card]}).catch(()=>{});
        }
        if(!isTrialAccess(data)&&typeof ensureProxyCredentials==='function'&&state.telegramProxyBonusEnabled){
          void ensureProxyCredentials(data.id,[card]).catch(()=>{});
        }
        return;
      }
      if(data.product!=='vpn')return;
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
    }else if(view==='plans'&&!location.hash&&(active.length>0||activeDns.length>0)){
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
        const matching=(payload.access||[]).filter(a=>a.state==='ACTIVE'&&a.secondsRemaining>0&&
          (a.sourceOrderId===order.id || a.id===intent.renewalTargetId));
        const hasVpn=matching.some(a=>a.product==='vpn');
        const hasDns=matching.some(a=>a.product==='smart_dns');
        const ready=order.product==='bundle'?(hasVpn||hasDns):
          order.product==='smart_dns'?hasDns:hasVpn;
        heading.textContent=ready?(order.product==='smart_dns'?'Smart Доступ готов!':
          order.product==='bundle'?'Экосистема «3 в 1» готова!':'VPN готов к подключению'):'Оплата подтверждена';
        description.textContent=ready?(order.product==='smart_dns'?
          'Готовим профиль Apple (.mobileconfig), DoT-адрес и WebSocket-прокси…':
          order.product==='bundle'?
            'Готовим ваш VPN, профиль Smart DNS и WebSocket-прокси…':
            'Подготавливаем инструкцию для вашего устройства…'):
          'Платёж получен. Ожидаем подтверждения активации на сервере.';
      }else if(order.state==='REFUNDED'||order.state==='CANCELLED'){
        heading.textContent='Оплаченного доступа нет';
        description.textContent='Статус заказа: '+(stateNames[order.state]||order.state)+'. Проверьте историю или напишите в поддержку.';
      }else{
        heading.textContent='Проверяем оплату';
        description.textContent='Подтверждения оплаты пока нет. Если деньги списаны, не создавайте повторный платёж.';
      }
    }
    async function deliverDnsAndProxyForSetup(dnsId,openSetup,isTrial=false){
      const dnsSlot=el('journey-dns-setup-slot'),proxySlot=el('journey-proxy-setup-slot');
      const tasks=[];
      if(typeof ensurePersonalDnsCredentials==='function'&&(state.personalDnsEnabled||state.appleDnsProfileEnabled)){
        tasks.push(ensurePersonalDnsCredentials(dnsId,{autoIssue:true,targets:[dnsSlot]}).catch(()=>{}));
      }
      if(!isTrial&&typeof ensureProxyCredentials==='function'&&state.telegramProxyBonusEnabled){
        tasks.push(ensureProxyCredentials(dnsId,[proxySlot]).catch(()=>{}));
      }
      await Promise.all(tasks);
      updateSetup();
      if(openSetup)setView('setup',true);
    }
    // Open the installer only after the verified PAID order has an ACTIVE
    // entitlement. A redirect alone can never trigger provisioning.
    if(paymentLanding){
      const intent=state.purchaseIntent||readPurchaseIntent();
      const order=intent&&(payload.orders||[]).find(o=>o.id===intent.orderId);
      const entitlement=order?.state==='PAID'&&(payload.access||[]).find(a=>
        a.product==='vpn'&&a.state==='ACTIVE'&&a.secondsRemaining>0&&
        (a.sourceOrderId===order.id || a.id===intent.renewalTargetId));
      const dnsEntitlement=order?.state==='PAID'&&(payload.access||[]).find(a=>
        a.product==='smart_dns'&&a.state==='ACTIVE'&&a.secondsRemaining>0&&
        (a.sourceOrderId===order.id || a.id===intent.renewalTargetId));
      if(entitlement&&!autoSetupOrders.has(order.id)){
        autoSetupOrders.add(order.id);
        void loadSubscription(entitlement.id);
      }
      if(dnsEntitlement&&!autoSetupOrders.has(order.id+':dns')){
        autoSetupOrders.add(order.id+':dns');
        lastSetupAttempt.set('dns:'+dnsEntitlement.id,Date.now());
        void deliverDnsAndProxyForSetup(dnsEntitlement.id,!entitlement);
      }
    }
    if(view==='setup'&&activeDns.length){
      const dnsTarget=activeDns[0];
      const isTrial=isTrialAccess(dnsTarget);
      const dnsSlot=el('journey-dns-setup-slot'),proxySlot=el('journey-proxy-setup-slot');
      const needsDns=!dnsSlot?.children?.length&&(state.personalDnsEnabled||state.appleDnsProfileEnabled);
      const needsProxy=!isTrial&&!proxySlot?.children?.length&&state.telegramProxyBonusEnabled;
      const lastDns=lastSetupAttempt.get('dns:'+dnsTarget.id)||0;
      if((needsDns||needsProxy)&&Date.now()-lastDns>30000){
        lastSetupAttempt.set('dns:'+dnsTarget.id,Date.now());
        void deliverDnsAndProxyForSetup(dnsTarget.id,false,isTrial);
      }else{
        updateSetup();
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
    if(view==='payment')updatePaymentAction();
    if(pendingIntent())resumeCheckout();
  }
  function loggedOut(){
    lastAccount=null;
    state.guestSubscriptionUrl=null;
    el('journey-setup-controls').hidden=true;
    el('journey-url').value='';
    if(view==='setup')setView('account',true);
    else if(paymentLanding)setView('payment');
    if(view==='payment')updatePaymentAction();
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
  landing.querySelectorAll('[data-journey-product]').forEach(btn=>btn.addEventListener('click',()=>{
    setSelection(btn.dataset.journeyProduct,state.days);updatePlan();
  }));
  landing.querySelectorAll('[data-journey-days]').forEach(btn=>btn.addEventListener('click',()=>{
    setSelection(state.product,Number(btn.dataset.journeyDays));updatePlan();
  }));
  el('journey-buy').addEventListener('click',beginCheckout);
  if(orderView){
    for(const btn of orderView.querySelectorAll?.('[data-order-product]')||[]){
      btn.addEventListener('click',()=>{
        setSelection(btn.dataset.orderProduct,state.days);updatePlan();updateOrder();
      });
    }
    for(const btn of orderView.querySelectorAll?.('[data-order-days]')||[]){
      btn.addEventListener('click',()=>{
        if(btn.disabled)return;
        setSelection(state.product,Number(btn.dataset.orderDays));updatePlan();updateOrder();
      });
    }
  }
  el('journey-order-pay').addEventListener('click',()=>{
    updateOrder();
    if(el('journey-order-pay').disabled)return;
    void purchase();
  });
  el('journey-order-back').addEventListener('click',event=>{
    event.preventDefault();setView('plans',true);
  });
  el('journey-trial').addEventListener('click',async()=>{
    const trialProduct=state.trialProduct==='smart_dns'?'smart_dns':'vpn';
    if(!state.trialOffers.includes(trialProduct))return;
    if(!state.loggedIn){
      saveSelection();
      try{
        sessionStorage.setItem('mnebyvpn-pending-trial','1');
        sessionStorage.setItem('mnebyvpn-pending-trial-product',trialProduct);
      }catch{}
      setView('trial-auth',true);
      // Do not summon the mobile keyboard before the visitor requests it:
      // the reduced visual viewport would immediately force scrolling.
      if(state.emailLoginEnabled&&!window.matchMedia?.('(pointer:coarse)').matches)
        el('email-input')?.focus();
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
  el('journey-platform-change').addEventListener('click',()=>{
    const grid=el('journey-platform-grid'),button=el('journey-platform-change');
    grid.hidden=!grid.hidden;
    button.setAttribute('aria-expanded',String(!grid.hidden));
  });
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
  // Deep links to DNS must not silently reset selection to VPN.
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
