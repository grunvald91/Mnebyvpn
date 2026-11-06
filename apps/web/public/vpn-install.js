// Tiny install bridge for bot URL buttons: Telegram only accepts HTTPS/tg://.
// Opening a custom scheme is driven by a user click; the fallback is manual.
'use strict';
(() => {
  const root=document.querySelector('[data-client][data-sub]');
  if(!root)return;
  const subscription=root.getAttribute('data-sub');
  const client=root.getAttribute('data-client');
  if(!subscription||!subscription.startsWith('https://mnebyvpn.site/sub/'))return;
  let target;
  if(client==='incy'){
    target='incy://import/'+subscription;
  }else if(client==='karing'){
    target='karing://install-config?url='+encodeURIComponent(subscription)+
      '&name='+encodeURIComponent('Мне бы VPN');
  }else{return;}
  const action=document.getElementById('open-app');
  const copy=document.getElementById('copy-url');
  const field=document.getElementById('subscription-url');
  if(!action||!copy||!field)return;
  action.addEventListener('click',()=>{
    // Explicit user gesture is required by iOS/Android custom-URI handlers.
    window.location.href=target;
  });
  copy.addEventListener('click',async()=>{
    try{
      await navigator.clipboard.writeText(subscription);
      copy.textContent='Ссылка скопирована';
    }catch{
      field.focus();field.select();
      copy.textContent='Выделите и скопируйте ссылку';
    }
  });
})();
