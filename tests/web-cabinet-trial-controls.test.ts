import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
test('cabinet trial control follows catalog, login, busy and durable request state without another account poll',()=>{
 const start=source.indexOf('function syncCabinetTrialButton(){');
 const end=source.indexOf('function renderAccess(accesses)',start);
 assert.ok(start>=0&&end>start);
 const retry={hidden:false,disabled:false};
 const state={loggedIn:true,trialOffers:[] as string[],trialRequestStatus:'NONE',busy:false};
 const ctx=vm.createContext({state,byId:(id:string)=>id==='cabinet-trial-retry'?retry:null});
 vm.runInContext(source.slice(start,end),ctx);
 const sync=()=>vm.runInContext('syncCabinetTrialButton()',ctx);
 sync();assert.equal(retry.hidden,true);
 state.trialOffers=['vpn'];sync();assert.equal(retry.hidden,false);assert.equal(retry.disabled,false);
 state.trialOffers=['bundle'];sync();assert.equal(retry.hidden,false);assert.equal(retry.disabled,false);
 state.busy=true;sync();assert.equal(retry.disabled,true);
 state.busy=false;sync();assert.equal(retry.disabled,false);
 for(const status of ['PENDING','WAITING','SENT']){
   state.trialRequestStatus=status;sync();assert.equal(retry.hidden,true);
 }
 state.trialRequestStatus='REJECTED';sync();assert.equal(retry.hidden,false);assert.equal(retry.disabled,false);
 state.loggedIn=false;sync();assert.equal(retry.hidden,true);
});

test('trial country selector keeps same entitlements and filters proxy links without issuing access',async()=>{
 const start=source.indexOf("let trialCountry='DE';");
 const end=source.indexOf('async function ensureProxyCredentials',start);
 assert.ok(start>=0&&end>start);
 class Element {
  children:Element[]=[]; hidden=false; disabled=false; isConnected=true; type='';
  handlers:Record<string,()=>void>={}; attrs:Record<string,string>={};
  tag:string; textContent:string;
  constructor(tag:string,textContent=''){this.tag=tag;this.textContent=textContent;}
  append(...items:Element[]){this.children.push(...items);}
  replaceChildren(){for(const child of this.children)child.isConnected=false;this.children=[];}
  setAttribute(key:string,value:string){this.attrs[key]=value;}
  addEventListener(key:string,fn:()=>void){this.handlers[key]=fn;}
 }
 const slot=new Element('section');
 const shown:string[][]=[];const requests:string[]=[];const vpn:string[]=[];
 const state={lastOrders:[{id:'trial',state:'TRIAL',product:'bundle'}],personalDnsEnabled:true,fiAwgRegistrationAvailable:true};
 const accesses=[{id:'vpn1',product:'vpn',sourceOrderId:'trial',state:'ACTIVE',secondsRemaining:100},
   {id:'dns1',product:'smart_dns',sourceOrderId:'trial',state:'ACTIVE',secondsRemaining:100}];
 const data={wsLinks:[{label:'shared'}],regionalLinks:[{country:'DE',label:'de'},{country:'FI',label:'fi'}]};
 const location={search:'',href:''};
 const ctx=vm.createContext({state,location,URLSearchParams,accesses,data,dnsCredInFlight:new Map(),
   byId:(id:string)=>id==='cabinet-shared-trial-proxy'?slot:null,
   node:(tag:string,_cls:string,label?:string)=>new Element(tag,label),
   api:async(url:string)=>{requests.push(url);return {issued:false,revoked:false};},
   readCachedPersonalDns:()=>null,renderPersonalDnsBox:()=>{},
   renderProxyBonusBox:(_el:Element,value:{wsLinks:{label:string}[]})=>shown.push(value.wsLinks.map(l=>l.label)),
   loadSubscription:(id:string)=>vpn.push(id),
   downloadAppleDnsProfile:()=>{throw Error('country switch must never issue or rotate');},
 });
 vm.runInContext(source.slice(start,end)+'\nrenderSharedTrialProxy(data,accesses);',ctx);
 assert.deepEqual(Array.from(shown[0]),['de']);
 const first=slot.children[0];
 vm.runInContext('renderSharedTrialProxy(data,accesses);',ctx);
 assert.equal(slot.children[0],first,'poll must preserve the current country panel');
 await new Promise(resolve=>setImmediate(resolve));
 slot.children.find(x=>x.textContent==='VPN · Германия')!.handlers.click();
 assert.deepEqual(vpn,['vpn1']);
 slot.children.find(x=>x.textContent==='🇫🇮 Финляндия')!.handlers.click();
 assert.deepEqual(Array.from(shown[2]),['fi']);
 slot.children.find(x=>x.textContent==='VPN · Финляндия')!.handlers.click();
 assert.equal(location.href,'/awg/setup?entitlementId=vpn1');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(requests,['/api/dns/apple/status?entitlementId=dns1','/api/dns/apple/status?entitlementId=dns1&country=FI']);
 vm.runInContext("renderSharedTrialProxy(data,[]);",ctx);
 assert.equal(slot.children.some(x=>x.textContent.includes('Пробный доступ')),false);
 assert.ok(slot.children.some(x=>x.tag==='details'));
});
