import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const journey=readFileSync(new URL('../apps/web/public/journey.js',import.meta.url),'utf8');
const orderId='11111111-1111-4111-8111-111111111111';
const entitlementId='22222222-2222-4222-8222-222222222222';

function browser(url:string,loggedIn:boolean){
  const map=new Map<string,any>();
  const actions:{setup:string[];dns?:string[];proxy?:string[];trials:number;purchase:number}={setup:[],trials:0,purchase:0};
  const headingIds=new Set(['legacy-hero-title','journey-front-heading','journey-title','journey-trial-title',
    'journey-setup-title','journey-order-title','journey-payment-heading',
    'journey-account-title','account-name','contact-support-title']);
  const make=(id:string,tagName='DIV')=>{
    const handlers=new Map<string,()=>void>();
    let href='';
    const node:any={
      id,tagName,localName:tagName.toLowerCase(),handlers,
      attributes:id?[{name:'id',value:id}]:[],childNodes:[],
      style:{},dataset:{},hidden:false,disabled:false,textContent:'',value:'',href:'',
      classList:{add:()=>{},remove:()=>{},toggle:()=>{},contains:()=>false},
      addEventListener:(event:string,cb:()=>void)=>handlers.set(event,cb),
      removeAttribute:()=>{},getAttribute:()=>null,
      append:()=>{},querySelector:()=>null,querySelectorAll:()=>[],focus:()=>{},
      scrollIntoView:()=>{},
    };
    node.setAttribute=(name:string,value:string)=>{
      const old=node.attributes.find((x:any)=>x.name===name);
      if(old)old.value=value;else node.attributes.push({name,value});
      if(name==='id')node.id=value;
    };
    node.replaceChildren=(...children:any[])=>{node.childNodes=children;};
    node.replaceWith=(replacement:any)=>{replacement.textContent=node.textContent;map.set(node.id,replacement);};
    return node;
  };
  const el=(id:string)=>{
    if(id==='orders-list'||id==='journey-history')return null;
    if(!map.has(id))map.set(id,make(id,id==='legacy-hero-title'?'H1':id==='account-name'?'STRONG':headingIds.has(id)?'H2':'DIV'));
    return map.get(id);
  };
  const days=[15,30,60,90].map(n=>({ ...make('days-'+n),dataset:{journeyDays:String(n)}}));
  const orderProducts=['vpn','bundle','smart_dns'].map(p=>({...make('order-p-'+p),dataset:{orderProduct:p}}));
  const orderDays=[15,30,60,90].map(n=>({...make('order-d-'+n),dataset:{orderDays:String(n)}}));
  const platforms=['android','ios','windows','macos','linux'].map(p=>({...make(p),dataset:{journeyPlatform:p}}));
  const landing=el('journey-landing');
  landing.querySelectorAll=(q:string)=>q==='[data-journey-days]'?days:[];
  landing.querySelector=(q:string)=>el(q);
  const setup=el('journey-setup');
  setup.querySelectorAll=(q:string)=>q==='[data-journey-platform]'?platforms:[];
  const orderView=el('journey-order');
  orderView.querySelectorAll=(q:string)=>
    q==='[data-order-product]'?orderProducts:
    q==='[data-order-days]'?orderDays:[];
  orderView.querySelector=(q:string)=>el(q);
  const header=make('header');
  const back=make('back');
  const account=el('access-list');
  account.querySelectorAll=()=>[];
  const document={
    body:{dataset:{},classList:{add:()=>{}}},
    getElementById:el,
    createElement:(tag:string)=>make('',tag.toUpperCase()),
    querySelector:(q:string)=>q==='.journey-header-account'?header:
      q==='.journey-back'?back:null,
  };
  const parsed=new URL(url);
  const location={href:url,pathname:parsed.pathname,hash:parsed.hash,search:parsed.search};
  const state:any={
    loggedIn,plans:[{product:'vpn',durationDays:30,rubMinor:19900}],
    days:30,product:'vpn',guestSubscriptionUrl:null,setupLoading:false,
    csrf:'csrf',purchaseIntent:null,trialOffers:['vpn'],
  };
  const window:any={
    renderPlan:()=>{},renderAccount:()=>{},renderLoggedOut:()=>{},
    renderVpnSetup:()=>{},showPaymentLink:()=>{},scrollTo:()=>{},
    addEventListener:()=>{},
  };
  const context=vm.createContext({
    document,window,location,history:{replaceState:()=>{}},navigator:{userAgent:'Android',platform:'Linux',maxTouchPoints:0},
    URL,Date,Set,Map,Promise,Number,Object,String,state,sessionStorage:{
      store:new Map<string,string>(),
      getItem(k:string){return this.store.get(k)??null;},
      setItem(k:string,v:string){this.store.set(k,v);},
      removeItem(k:string){this.store.delete(k);},
    },
    formatMoney:(n:number)=>String(n)+' ₽',
    setSelection:(p:string,d:number)=>{state.product=p;state.days=d;window.renderPlan();},
    saveSelection:()=>{},readPurchaseIntent:()=>null,
    ensurePersonalDnsCredentials:async(id:string)=>{actions.dns=actions.dns||[];actions.dns.push(id);return null;},
    ensureProxyCredentials:async(id:string)=>{actions.proxy=actions.proxy||[];actions.proxy.push(id);return null;},
    loadSubscription:async(id:string)=>{actions.setup.push(id);},
    purchase:async()=>{actions.purchase++;},
    claimTrial:async()=>{actions.trials++;return 'PENDING';},
    toast:()=>{},
  });
  vm.runInContext(journey,context,{filename:'journey.js'});
  return {state,window,map,actions,orderProducts,orderDays};
}

test('returned unpaid order renders verification, never opens a VPN config',()=>{
  const b=browser('https://mnebyvpn.site/payment/success?payment=returned&order='+orderId,true);
  b.window.renderAccount({orders:[{id:orderId,state:'PENDING'}],access:[],identity:{email:'a@example.com'}});
  assert.equal(b.map.get('journey-payment-heading').textContent,'Проверяем оплату');
  assert.equal(b.map.get('journey-setup').hidden,true);
  assert.deepEqual(b.actions.setup,[]);
});

test('verified PAID+ACTIVE order opens setup exactly once even on refresh',()=>{
  const b=browser('https://mnebyvpn.site/payment/success?payment=returned&order='+orderId,true);
  const data={orders:[{id:orderId,state:'PAID'}],
    access:[{id:entitlementId,sourceOrderId:orderId,product:'vpn',state:'ACTIVE',secondsRemaining:86400}],
    identity:{email:'a@example.com'}};
  b.window.renderAccount(data);
  b.window.renderAccount(data);
  assert.deepEqual(b.actions.setup,[entitlementId]);
  assert.equal(b.map.get('journey-payment-heading').textContent,'VPN готов к подключению');
});

test('try button opens email-first trial auth without claiming VPN anonymously',async()=>{
  const b=browser('https://mnebyvpn.site/#plans',false);
  b.map.get('journey-trial').handlers.get('click')?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.actions.trials,0);
  assert.equal(b.map.get('journey-trial-auth').hidden,false);
  assert.equal(b.map.get('journey-setup').hidden,true);
  assert.equal(b.map.get('journey-landing').hidden,true);
  assert.equal(b.window.MnebyvpnJourney!==undefined,true);
});
test('Telegram trial login remains secondary and is disabled when OIDC unavailable',()=>{
  const b=browser('https://mnebyvpn.site/#try',false);
  assert.equal(b.map.get('journey-trial-auth').hidden,false);
  assert.equal(b.map.get('journey-trial-telegram').getAttribute('href'),null);
  assert.equal(b.actions.trials,0);
});


test('checkout is a separate MNEBYVPN review, no provider request before confirmation',async()=>{
  const b=browser('https://mnebyvpn.site/#plans',true);
  b.state.checkoutEnabled=true;
  b.window.renderAccount({orders:[],access:[],identity:{email:'verified@example.com'}});
  b.map.get('journey-buy').handlers.get('click')?.();
  assert.equal(b.map.get('journey-order').hidden,false);
  assert.equal(b.map.get('journey-landing').hidden,true);
  assert.equal(b.map.get('journey-order-period').textContent,'VPN Лайт · 30 дней');
  assert.equal(b.map.get('journey-order-email').textContent,'verified@example.com');
  assert.equal(b.actions.purchase,0);
  // Inline tariff switch directly on the checkout confirmation screen
  b.state.plans.push({product:'bundle',durationDays:60,rubMinor:69900});
  b.orderProducts[1].handlers.get('click')?.();
  b.orderDays[2].handlers.get('click')?.();
  assert.equal(b.state.product,'bundle');
  assert.equal(b.state.days,60);
  assert.equal(b.map.get('journey-order-period').textContent,'Экосистема «3 в 1» · 60 дней');
  b.map.get('journey-order-pay').handlers.get('click')?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.actions.purchase,1);
});

test('verified PAID smart_dns order auto-delivers personal DNS and WebSocket proxy',async()=>{
  const b=browser('https://mnebyvpn.site/payment/success?payment=returned&order='+orderId,true);
  b.state.personalDnsEnabled=true;
  b.state.telegramProxyBonusEnabled=true;
  const dnsId='33333333-3333-4333-8333-333333333333';
  const data={orders:[{id:orderId,product:'smart_dns',state:'PAID'}],
    access:[{id:dnsId,sourceOrderId:orderId,product:'smart_dns',state:'ACTIVE',secondsRemaining:86400}],
    identity:{email:'a@example.com'}};
  b.window.renderAccount(data);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(b.actions.dns,[dnsId]);
  assert.deepEqual(b.actions.proxy,[dnsId]);
  assert.equal(b.map.get('journey-setup').hidden,false);
});

test('anonymous checkout never calls the payment provider',async()=>{
  const b=browser('https://mnebyvpn.site/#plans',false);
  b.state.checkoutEnabled=true;
  b.map.get('journey-buy').handlers.get('click')?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.actions.purchase,0);
  assert.equal(b.map.get('journey-order').hidden,true);
});

test('only the visible route has H1; all other route headings are H2',()=>{
  const b=browser('https://mnebyvpn.site/#plans',true);
  const titles=['legacy-hero-title','journey-front-heading','journey-title','journey-trial-title','journey-setup-title',
    'journey-order-title','journey-payment-heading','journey-account-title','account-name','contact-support-title'];
  const expectations:Record<string,string>={
    plans:'journey-front-heading','trial-auth':'journey-trial-title',
    setup:'journey-setup-title',checkout:'journey-order-title',
    payment:'journey-payment-heading',account:'account-name',
    support:'contact-support-title',
  };
  for(const [view,primary] of Object.entries(expectations)){
    b.window.MnebyvpnJourney.show(view);
    const active=titles.filter(id=>b.map.get(id)?.tagName==='H1');
    assert.deepEqual(active,[primary],view);
    for(const id of titles)assert.equal(b.map.get(id)?.tagName,id===primary?'H1':id==='account-name'?'STRONG':'H2',id);
  }
});

test('account name remains updatable and reverts to strong off the account view',()=>{
  const b=browser('https://mnebyvpn.site/#account',true);
  assert.equal(b.map.get('account-name').tagName,'H1');
  b.map.get('account-name').textContent='Мой аккаунт';
  b.window.MnebyvpnJourney.show('plans');
  assert.equal(b.map.get('account-name').tagName,'STRONG');
  assert.equal(b.map.get('account-name').textContent,'Мой аккаунт');
  assert.equal(b.map.get('journey-front-heading').tagName,'H1');
});
