import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {Script,createContext} from 'node:vm';
import {vpnPurchaseWidgetHtml,vpnPurchaseWidgetData,vpnPurchaseWidgetPayload}
 from '../packages/telegram-ui/src/purchase-widget.ts';
import {planWidgetKey} from '../packages/telegram-ui/src/widget-104.ts';
import type {PricedPlan} from '../packages/billing/src/channels.ts';

const offers:PricedPlan[]=[
 {planId:'vpn_90d_1device',product:'vpn',title:'90 дней',stars:140,rubMinor:24900,durationSeconds:90*86400,deviceLimit:1,dnsQuotaBytes:null},
 {planId:'vpn_15d_1device',product:'vpn',title:'15 дней',stars:40,rubMinor:6000,durationSeconds:15*86400,deviceLimit:1,dnsQuotaBytes:null},
 {planId:'vpn_60d_1device',product:'vpn',title:'60 дней',stars:110,rubMinor:19900,durationSeconds:60*86400,deviceLimit:1,dnsQuotaBytes:null},
 {planId:'vpn_30d_1device',product:'vpn',title:'30 дней',stars:60,rubMinor:9900,durationSeconds:30*86400,deviceLimit:1,dnsQuotaBytes:null},
];
test('Apple-style purchase bubble fits Telegram 10.4 constraints and uses native chat theme',()=>{
 const html=vpnPurchaseWidgetHtml();
 assert.ok(Buffer.byteLength(html,'utf8')<=32768);
 assert.ok(deflateSync(Buffer.from(html),{level:9}).length<=3800);
 assert.match(html,/TelegramWidget/);
 assert.match(html,/#080d25/);
 assert.match(html,/#00d4df/);
 assert.match(html,/#b052f3/);
 assert.match(html,/class="planet"/);
 assert.match(html,/class="orbit"/);
 assert.match(html,/\.option\[aria-pressed=true\]/);
 assert.match(html,/@media\(max-width:320px\)/);
 assert.doesNotMatch(html,/#edf5ff|#dbeafe|linear-gradient\(135deg,#edf5ff/);
 assert.match(html,/aria-live="polite"/);
 assert.match(html,/type="button"/);
 assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|WebSocket|<iframe|@font-face/);
 assert.doesNotThrow(()=>new Script(html.split('<script>')[1].split('</script>')[0]));
});
test('catalogue, not browser, supplies all four approved Stars amounts and stable keys',()=>{
 const state=JSON.parse(vpnPurchaseWidgetData(offers));
 assert.deepEqual(state.p.map((p:number[])=>p[0]),[15,30,60,90]);
 assert.deepEqual(state.p.map((p:number[])=>p[1]),[40,60,110,140]);
 assert.deepEqual(state.p.map((p:number[])=>p[2]),[1,1,1,1]);
 assert.deepEqual(state.p.map((p:number[])=>p[3]),[6000,9900,19900,24900]);
 const sorted=offers.slice().sort((a,b)=>a.durationSeconds-b.durationSeconds);
 assert.deepEqual(state.p.map((p:(number|string)[])=>p[4]),sorted.map(planWidgetKey));
 const payload=vpnPurchaseWidgetPayload(123456,offers);
 assert.equal(payload.chat_id,123456);
 assert.equal(payload.allow_queries,true);
 assert.equal('public_data' in payload,false);
 assert.equal('is_shared' in payload,false);
 assert.equal('width' in payload,false);
 assert.ok(Buffer.byteLength(payload.chat_data,'utf8')<=1024);
 assert.ok(!payload.html.includes('vpn_15d_1device'));
 assert.ok(!payload.html.includes('249,00'));
 assert.ok(payload.caption.includes('40 ⭐'));
});
test('invalid or unavailable prices fail closed rather than showing a fabricated invoice',()=>{
 assert.throws(()=>vpnPurchaseWidgetData([]),/No published/);
 assert.throws(()=>vpnPurchaseWidgetData([{...offers[0],stars:null}]),/No published/);
 assert.throws(()=>vpnPurchaseWidgetData([{...offers[0],stars:-4}]),/Invalid published/);
 assert.throws(()=>vpnPurchaseWidgetData([{...offers[0],deviceLimit:0}]),/Invalid published/);
 assert.throws(()=>vpnPurchaseWidgetPayload(0,offers),/Invalid private chat/);
 assert.notEqual(planWidgetKey(offers[0]),planWidgetKey({...offers[0],stars:141}));
});
test('tap selects the duration and requests only the fingerprint; invoice is not opened twice',async()=>{
 const state=vpnPurchaseWidgetData(offers);
 const elements=new Map<string,any>();
 const events=new Map<string,()=>void>();
 function element(id:string){
  if(!elements.has(id)){
   elements.set(id,{hidden:false,disabled:false,textContent:'',attributes:{} as Record<string,string>,
    setAttribute(k:string,v:string){this.attributes[k]=v},
    addEventListener(ev:string,fn:()=>void){events.set(id+':'+ev,fn)}});
  }
  return elements.get(id);
 }
 const html=vpnPurchaseWidgetHtml();
 const script=html.split('<script>')[1].split('</script>')[0];
 const requests:string[]=[];
 const tw={chatData:state,request:(data:string)=>{requests.push(data);return Promise.resolve({result:'INVOICE_SENT'})},
  onEvent:()=>{},ready:()=>{}};
 new Script(script).runInContext(createContext({
  document:{getElementById:element},
  TelegramWidget:tw,
 }));
 assert.equal(element('total').textContent,'60 ⭐'); // 30 days selected by default
 events.get('o3:click')?.();
 assert.equal(element('total').textContent,'140 ⭐');
 events.get('pay:click')?.();
 assert.deepEqual(requests,['buy:'+planWidgetKey(offers[0])]);
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(element('notice').textContent,/Счёт отправлен в чат/);
 assert.equal(element('pay').disabled,true);
 events.get('pay:click')?.();
 assert.equal(requests.length,1);
});
