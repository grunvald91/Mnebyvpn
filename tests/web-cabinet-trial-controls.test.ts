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
 state.busy=true;sync();assert.equal(retry.disabled,true);
 state.busy=false;sync();assert.equal(retry.disabled,false);
 for(const status of ['PENDING','WAITING','SENT']){
   state.trialRequestStatus=status;sync();assert.equal(retry.hidden,true);
 }
 state.trialRequestStatus='REJECTED';sync();assert.equal(retry.hidden,false);assert.equal(retry.disabled,false);
 state.loggedIn=false;sync();assert.equal(retry.hidden,true);
});
