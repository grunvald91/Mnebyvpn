import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const journey=readFileSync(new URL('../apps/web/public/journey.js',import.meta.url),'utf8');
const orderId='11111111-1111-4111-8111-111111111111';
const entitlementId='22222222-2222-4222-8222-222222222222';

function browser(url:string,loggedIn:boolean){
  const map=new Map<string,any>();
  const actions:{setup:string[];trials:number;purchase:number}={setup:[],trials:0,purchase:0};
  const make=(id:string)=>{
    const handlers=new Map<string,()=>void>();
    let href='';
    return {
      id,handlers,style:{},dataset:{},hidden:false,disabled:false,textContent:'',value:'',href:'',
      classList:{add:()=>{},remove:()=>{},toggle:()=>{},contains:()=>false},
      addEventListener:(event:string,cb:()=>void)=>handlers.set(event,cb),
      removeAttribute:()=>{},setAttribute:()=>{},getAttribute:()=>null,
      append:()=>{},querySelector:()=>null,querySelectorAll:()=>[],focus:()=>{},
      scrollIntoView:()=>{},
    };
  };
  const el=(id:string)=>{
    if(id==='orders-list'||id==='journey-history')return null;
    if(!map.has(id))map.set(id,make(id));
    return map.get(id);
  };
  const days=[15,30,60,90].map(n=>({ ...make('days-'+n),dataset:{journeyDays:String(n)}}));
  const platforms=['android','ios','windows','macos','linux'].map(p=>({...make(p),dataset:{journeyPlatform:p}}));
  const landing=el('journey-landing');
  landing.querySelectorAll=(q:string)=>q==='[data-journey-days]'?days:[];
  landing.querySelector=(q:string)=>el(q);
  const setup=el('journey-setup');
  setup.querySelectorAll=(q:string)=>q==='[data-journey-platform]'?platforms:[];
  const header=make('header');
  const back=make('back');
  const account=el('access-list');
  account.querySelectorAll=()=>[];
  const document={
    body:{dataset:{},classList:{add:()=>{}}},
    getElementById:el,
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
    URL,Date,Set,Map,Number,Object,String,state,sessionStorage:{
      store:new Map<string,string>(),
      getItem(k:string){return this.store.get(k)??null;},
      setItem(k:string,v:string){this.store.set(k,v);},
      removeItem(k:string){this.store.delete(k);},
    },
    formatMoney:(n:number)=>String(n)+' ₽',
    setSelection:(p:string,d:number)=>{state.product=p;state.days=d;window.renderPlan();},
    saveSelection:()=>{},readPurchaseIntent:()=>null,
    loadSubscription:async(id:string)=>{actions.setup.push(id);},
    purchase:async()=>{actions.purchase++;},
    claimTrial:async()=>{actions.trials++;return 'PENDING';},
    toast:()=>{},
  });
  vm.runInContext(journey,context,{filename:'journey.js'});
  return {state,window,map,actions};
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
  assert.equal(b.map.get('journey-order-period').textContent,'VPN · 30 дней');
  assert.equal(b.map.get('journey-order-email').textContent,'verified@example.com');
  assert.equal(b.actions.purchase,0);
  b.map.get('journey-order-pay').handlers.get('click')?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.actions.purchase,1);
});

test('anonymous checkout never calls the payment provider',async()=>{
  const b=browser('https://mnebyvpn.site/#plans',false);
  b.state.checkoutEnabled=true;
  b.map.get('journey-buy').handlers.get('click')?.();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.actions.purchase,0);
  assert.equal(b.map.get('journey-order').hidden,true);
});
