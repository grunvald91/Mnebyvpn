import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
const token='ReferralToken001';
function openPage(href:string,stored:Map<string,string>,authenticated=false){
  const elements=new Map<string,any>();
  const posts:Array<{path:string;body:any}>=[];
  const location={href,redirect:null as string|null,assign(url:string){this.redirect=url;}};
  const el=(id:string)=>{
    if(!elements.has(id)){
      const handlers=new Map<string,()=>void>();
      elements.set(id,{
        handlers, dataset:{}, classList:{toggle:()=>{},remove:()=>{},add:()=>{}},
        textContent:'',disabled:false,style:{},
        addEventListener:(type:string,fn:()=>void)=>{handlers.set(type,fn);},
        setAttribute:()=>{},scrollIntoView:()=>{},append:()=>{},replaceChildren:()=>{},
      });
    }
    return elements.get(id);
  };
  const document={
    getElementById:el,querySelectorAll:()=>[],
    addEventListener:()=>{},visibilityState:'visible',
  };
  const fetch=async(path:string,options?:{body?:string})=>{
    if(path==='/api/plans')return {ok:true,json:async()=>({
      plans:[{id:'vpn-30',title:'VPN 30 days',product:'vpn',
        durationDays:30,rubMinor:9900,dnsQuotaBytes:null}],
      checkoutEnabled:true,trialOffers:['vpn'],
    })};
    if(path==='/api/me')return authenticated
      ?{ok:true,json:async()=>({csrf:'csrf-test',access:[],orders:[]})}
      :{ok:false,status:401,json:async()=>({code:'LOGIN_REQUIRED'})};
    if(path==='/api/trial'){
      posts.push({path,body:JSON.parse(options?.body||'{}')});
      return {ok:true,json:async()=>({status:'GRANTED'})};
    }
    throw new Error('Unexpected API call '+path);
  };
  const context=vm.createContext({
    document,fetch,location,URL,crypto:{randomUUID:()=> 'aaaa-bbbb'},
    sessionStorage:{
      getItem:(k:string)=>stored.get(k)??null,
      setItem:(k:string,v:string)=>{stored.set(k,v);},
    },
    setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{},
  });
  vm.runInContext(script,context,{filename:'app.js'});
  return {elements,posts,location,context};
}
async function settle(){
  await new Promise<void>(resolve=>setImmediate(resolve));
}
test('trial referral survives Telegram OIDC redirect and arrives in authenticated request',async()=>{
  const session=new Map<string,string>();
  const first=openPage('https://vpn.example/?ref='+token+'&product=vpn&days=30',session);
  await settle();
  assert.equal(first.location.redirect,null);
  first.elements.get('trial-button').handlers.get('click')();
  assert.equal(first.location.redirect,'/auth/login');
  const saved=JSON.parse(session.get('mnebyvpn-selection')||'{}');
  assert.equal(saved.inviteToken,token);
  assert.equal(saved.days,30);
  const afterLogin=openPage('https://vpn.example/#account',session,true);
  await settle();
  afterLogin.elements.get('trial-button').handlers.get('click')();
  await settle();
  assert.equal(afterLogin.posts.length,1);
  assert.equal(afterLogin.posts[0].body.product,'vpn');
  assert.equal(afterLogin.posts[0].body.inviteToken,token);
});
test('invalid referral is never carried into checkout after login',async()=>{
  const session=new Map<string,string>();
  const client=openPage('https://vpn.example/?ref=bad<script>&product=vpn&days=30',session);
  await settle();
  client.elements.get('buy-button').handlers.get('click')();
  assert.equal(client.location.redirect,'/auth/login');
  assert.equal(JSON.parse(session.get('mnebyvpn-selection')||'{}').inviteToken,null);
});
