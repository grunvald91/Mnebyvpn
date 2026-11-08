/* Accessible, optional project information dialog; no personal data is read. */
(() => {
  'use strict';
  const dialog = document.getElementById('about-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const tabs = Array.from(dialog.querySelectorAll('[data-about-tab]'));
  const panels = Array.from(dialog.querySelectorAll('[data-about-panel]'));
  const names = new Set(['about', 'security', 'bonus', 'roadmap']);
  function selectTab(name, focus = false) {
    if (!names.has(name)) return;
    tabs.forEach(tab => {
      const selected = tab.dataset.aboutTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.aboutPanel !== name; });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.aboutTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 :
        event.key === 'End' ? tabs.length - 1 :
          (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[target].dataset.aboutTab, true);
    });
  });
  document.querySelectorAll('[data-about-open]').forEach(button => {
    button.addEventListener('click', () => {
      selectTab(button.dataset.aboutOpen || 'about');
      if (!dialog.open) dialog.showModal();
    });
  });
  dialog.querySelector('[data-about-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-about-close-link]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  // Personal invite: server binds token to the authenticated account.
  // Attribution exists; no reward days or cash are credited by this button.
  const inviteButton=dialog.querySelector('#about-personal-invite');
  const inviteStatus=dialog.querySelector('#about-invite-status');
  const inviteReady=dialog.querySelector('#about-invite-ready');
  const inviteField=dialog.querySelector('#about-invite-url');
  const inviteShare=dialog.querySelector('#about-invite-share');
  inviteButton?.addEventListener('click',async()=>{
    if(typeof state==='undefined'||!state.loggedIn){
      dialog.close();
      window.MnebyvpnJourney?.show?.('account',true);
      return;
    }
    inviteButton.disabled=true;
    inviteStatus.textContent='Получаем персональную ссылку…';
    try{
      const result=await api('/api/referral-link',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},
        body:'{}',
      });
      const url=new URL(result.botUrl);
      if(url.protocol!=='https:'||url.hostname!=='t.me'||
         url.pathname!=='/MNEBYVPN_bot'||
         !/^r[A-Za-z0-9_-]{16,24}$/.test(url.searchParams.get('start')||''))
        throw Error('INVALID_REFERRAL_LINK');
      inviteField.value=url.toString();
      inviteShare.href='https://t.me/share/url?url='+encodeURIComponent(url.toString());
      inviteReady.hidden=false;
      inviteStatus.textContent='Приглашение на '+Number(result.days)+' дней VPN. Бонусы пока не начисляются.';
    }catch{
      inviteStatus.textContent='Не удалось получить ссылку. Попробуйте ещё раз после входа в кабинет.';
    }finally{inviteButton.disabled=false;}
  });
  dialog.querySelector('#about-invite-copy')?.addEventListener('click',async()=>{
    if(!inviteField.value)return;
    try{
      await navigator.clipboard.writeText(inviteField.value);
      inviteStatus.textContent='Персональная ссылка скопирована.';
    }catch{
      inviteField.focus();inviteField.select();
      inviteStatus.textContent='Скопируйте выделенную ссылку.';
    }
  });

})();
