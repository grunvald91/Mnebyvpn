/** Neon brand-aligned in-chat VPN checkout for Telegram Bot API 10.4.
 * Prices and plan fingerprints come from the published server-side catalogue.
 * The widget never collects payment credentials or grants access by itself.
 */
import { deflateSync } from 'node:zlib';
import { planWidgetKey } from './widget-104.ts';
import type { PricedPlan } from '../../billing/src/channels.ts';

type Offer=[number,number,number,number,string];
type PurchaseState={v:1;p:Offer[];more:number};
const DAY=86400;
const MAX=4;

export function vpnPurchaseWidgetData(plans:ReadonlyArray<PricedPlan>):string {
  const active=plans.filter(p=>p.product==='vpn'&&p.stars!==null)
    .slice().sort((a,b)=>a.durationSeconds-b.durationSeconds||a.planId.localeCompare(b.planId));
  const p=active.slice(0,MAX).map(plan=>{
    if(!Number.isSafeInteger(plan.durationSeconds)||plan.durationSeconds<=0||
       plan.durationSeconds%DAY!==0||!Number.isSafeInteger(plan.stars)||
       (plan.stars??0)<=0||
       (plan.deviceLimit!==undefined&&(!Number.isSafeInteger(plan.deviceLimit)||plan.deviceLimit<=0))||
       (plan.rubMinor!==null&&(!Number.isSafeInteger(plan.rubMinor)||plan.rubMinor<=0)))
      throw new Error('Invalid published VPN offer');
    return [plan.durationSeconds/DAY,plan.stars!,plan.deviceLimit??1,
      plan.rubMinor??0,planWidgetKey(plan)] satisfies Offer;
  });
  if(!p.length)throw new Error('No published VPN plans');
  const data:PurchaseState={v:1,p,more:active.length-p.length};
  const encoded=JSON.stringify(data);
  if(Buffer.byteLength(encoded,'utf8')>1024)throw new Error('VPN checkout state too large');
  return encoded;
}

// Fixed, no-network HTML. Dynamic server prices are passed as private chat_data;
// never use innerHTML with any user- or database-controlled values.
const HTML=String.raw`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#f7faff;background:#080d25;color-scheme:dark}
*{box-sizing:border-box}html{background:#080d25}
body{margin:0;padding:14px 13px 16px;overflow-x:hidden;background:radial-gradient(ellipse at 100% 0,#7831ad66,transparent 65%),linear-gradient(145deg,#080d25,#142459 60%,#100d34);font-size:13px}
header{display:flex;gap:10px;align-items:center;margin-bottom:13px}
.brand{position:relative;flex:0 0 39px;height:39px;border-radius:13px;overflow:hidden;background:radial-gradient(circle at 30% 22%,#8ffeff,#1689ff 34%,#261466 75%);border:1px solid #86f4ff;box-shadow:0 0 17px #0edfff77}
.brand:before{content:"";position:absolute;width:55px;height:14px;border:2px solid #ac68ff;border-radius:50%;transform:rotate(-29deg);top:13px;left:-12px;box-shadow:0 0 9px #49eeff}
.brand:after{content:"";position:absolute;right:-8px;top:7px;width:28px;height:5px;transform:rotate(-30deg);border-radius:9px;background:linear-gradient(90deg,#e5bc76,#fff4c6,#56faff)}
.brandname{font-size:17px;font-weight:860;letter-spacing:-.5px;background:linear-gradient(95deg,#fff,#57eeff 65%,#bda4ff);color:transparent;-webkit-background-clip:text;background-clip:text}
.meta{font-size:10px;color:#b2c7ec;margin-top:3px}
.hero{display:flex;position:relative;align-items:center;justify-content:space-between;min-height:139px;gap:5px;padding:17px 12px 14px 16px;overflow:hidden;border:1px solid #80c5ff85;border-radius:23px;background:linear-gradient(125deg,#075073,#243b89 54%,#59288f);box-shadow:inset 0 1px #ffffff55,0 10px 26px #04082976}
.hero-copy{position:relative;z-index:1;min-width:0;max-width:59%}
.hero-chip{display:inline-block;padding:4px 9px;border-radius:20px;border:1px solid #a5f6ff75;color:#98efff;background:#051c417a;font-size:9px;font-weight:750;letter-spacing:.5px}
.hero h2{font-size:22px;font-weight:850;line-height:1.07;letter-spacing:-.7px;margin:10px 0 6px;color:white}
.hero h2 span{color:#93f9ff}.hero p{font-size:11px;line-height:1.42;color:#d7e5ff;margin:0}
.energy{position:relative;flex:0 0 111px;width:111px;height:115px;transform:translate(8px,3px)}
.planet{position:absolute;left:21px;top:17px;width:82px;height:82px;border-radius:50%;background:radial-gradient(circle at 30% 22%,#dcffff,#58eaff 17%,#146bfc 42%,#161063 82%);border:1px solid #a6f9ff;box-shadow:inset -10px -11px 14px #090c62,0 0 23px #23dfff9c}
.orbit{position:absolute;left:3px;top:46px;width:119px;height:32px;border:3px solid #61f4ff;border-left-color:#ac67ff;border-radius:50%;transform:rotate(-28deg);box-shadow:0 0 11px #5ef4ff}
.eyebrow{margin:16px 0 10px;color:#84e8ff;font-size:10px;font-weight:850;letter-spacing:1.1px}
.options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.option{min-width:0;min-height:77px;padding:12px 12px 10px;text-align:left;color:#fff;font:inherit;background:linear-gradient(145deg,#2a5b87,#33316d 60%,#5a2a83);border:1px solid #9cbbff77;border-radius:18px;box-shadow:inset 0 1px #ffffff52,0 7px 15px #03092380;cursor:pointer}
.option[aria-pressed=true]{background:linear-gradient(125deg,#05c8d3,#287fff 53%,#8a47f1);border:1px solid #bbffff;box-shadow:inset 0 1px #ffffffa0,0 0 0 1px #4cdcff78,0 0 19px #00deef70;transform:translateY(-1px)}
.option:focus-visible,#pay:focus-visible{outline:2px solid white;outline-offset:3px}
.term{display:block;color:#e4eeff;font-size:13px;font-weight:720}
.amount{display:block;margin-top:7px;color:white;font-size:18px;font-weight:850}
.total{margin-top:12px;padding:13px 14px;border:1px solid #9ab8f44d;border-radius:17px;background:linear-gradient(120deg,#122f56,#24205b 65%,#2e1758)}
.line{display:flex;justify-content:space-between;align-items:center;gap:9px}
.hint{color:#b4c8e7;font-size:11px}.value{font-size:12px;font-weight:740}
.separator{height:1px;background:#88b4fc52;margin:12px 0}
.price{color:#9cfcff;font-size:23px;font-weight:860;letter-spacing:-.5px}
#pay{width:100%;min-height:48px;margin-top:12px;border:1px solid #bffbff;border-radius:17px;background:linear-gradient(105deg,#00d4df,#3288ff 50%,#b052f3);color:white;font:inherit;font-size:15px;font-weight:840;box-shadow:inset 0 1px #ffffff8c,0 0 17px #00e8f46b,0 9px 20px #431ab15e}
#pay:disabled{opacity:.62;box-shadow:none}#notice{min-height:10px;margin:8px 3px 0;color:#abe3ff;font-size:11px;line-height:1.45}
footer{margin-top:10px;color:#a7b7d9;font-size:10px;line-height:1.45;text-align:center}
@media(max-width:320px){body{padding:11px 10px}.hero{padding:12px}.energy{transform:translate(9px,3px) scale(.82);margin-left:-11px}.hero h2{font-size:19px}.option{padding:10px 9px}}
</style></head><body>
<header><div class="brand" aria-hidden="true"></div><div><div class="brandname">MNEBYVPN</div><div class="meta">Личный VPN · Telegram Stars</div></div></header>
<section class="hero"><div class="hero-copy"><span class="hero-chip">VPN ACCESS</span><h2>Твой интернет.<br><span>Твои правила.</span></h2><p>Выбери период. Оплата — прямо в Telegram.</p></div><div class="energy" aria-hidden="true"><div class="planet"></div><div class="orbit"></div></div></section>
<div class="eyebrow">ВЫБЕРИ СВОЙ ПЕРИОД</div>
<div class="options">
<button class="option" id="o0" type="button" hidden><span class="term" id="t0"></span><span class="amount" id="a0"></span></button>
<button class="option" id="o1" type="button" hidden><span class="term" id="t1"></span><span class="amount" id="a1"></span></button>
<button class="option" id="o2" type="button" hidden><span class="term" id="t2"></span><span class="amount" id="a2"></span></button>
<button class="option" id="o3" type="button" hidden><span class="term" id="t3"></span><span class="amount" id="a3"></span></button>
</div>
<section class="total"><div class="line"><span class="hint">Устройств</span><span class="value" id="devices">1</span></div>
<div class="separator"></div><div class="line"><span class="hint" id="duration">Выбранный период</span><span class="price" id="total">—</span></div></section>
<button id="pay" type="button" disabled>Выберите тариф</button>
<div id="notice" aria-live="polite"></div>
<footer>Разовый пакет · счёт в Telegram Stars. Доступ после подтверждения оплаты.</footer>
<script>
(function(){
 var TW=typeof TelegramWidget==="undefined"?null:TelegramWidget,s=null,selected=-1,busy=false,locked="";
 function el(k){return document.getElementById(k)}
 function valid(row){return Array.isArray(row)&&row.length===5&&Number.isSafeInteger(row[0])&&row[0]>0&&
  Number.isSafeInteger(row[1])&&row[1]>0&&Number.isSafeInteger(row[2])&&row[2]>0&&
  typeof row[4]==="string"&&/^[A-Za-z0-9_-]{16}$/.test(row[4])}
 function days(n){return n===1?"1 день":n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?n+" дня":n+" дней"}
 function render(){
  var offer=s&&s.p[selected];
  for(var i=0;i<4;i++){
   var row=s&&s.p[i],button=el("o"+i);button.hidden=!row;
   if(!row)continue;
   el("t"+i).textContent=days(row[0]);el("a"+i).textContent=row[1]+" ⭐";
   button.setAttribute("aria-pressed",String(selected===i));button.disabled=busy;
  }
  el("devices").textContent=offer?String(offer[2]):"—";
  el("duration").textContent=offer?days(offer[0])+" · к оплате":"Выбранный период";
  el("total").textContent=offer?offer[1]+" ⭐":"—";
  el("pay").textContent=offer?"Оплатить "+offer[1]+" ⭐":"Выберите тариф";
  el("pay").disabled=!offer||busy||locked===offer[4]||!TW||typeof TW.request!=="function";
 }
 function select(i){if(busy||!s||!s.p[i])return;selected=i;el("notice").textContent="";render()}
 function receive(){
  try{
   var raw=JSON.parse(TW&&TW.chatData||"{}");
   if(raw.v!==1||!Array.isArray(raw.p)||raw.p.length<1||raw.p.length>4||!raw.p.every(valid))throw 0;
   s=raw;
   if(selected<0||selected>=s.p.length)selected=s.p.length>1?1:0;
   render();
   if(raw.more>0)el("notice").textContent="Показаны первые 4 тарифа. Остальные доступны в каталоге.";
  }catch(e){s=null;render();el("notice").textContent="Откройте обновлённую карточку в личном чате с ботом."}
 }
 for(var i=0;i<4;i++){(function(j){el("o"+j).addEventListener("click",function(){select(j)})})(i)}
 el("pay").addEventListener("click",function(){
  var row=s&&s.p[selected];if(!row||busy||locked===row[4]||!TW)return;
  busy=true;render();el("notice").textContent="Готовим счёт…";
  var key=row[4];
  TW.request("buy:"+key).then(function(answer){
   var result=answer&&answer.result;
   if(result==="INVOICE_SENT"){locked=key;el("notice").textContent="Счёт отправлен в чат. Подтвердите оплату в Telegram."}
   else if(result==="PROCESSING"||result==="ALREADY_REQUESTED"){
    locked=key;el("notice").textContent="Проверьте сообщения бота. Чтобы не создать дубль, этот запрос не повторяется."}
   else if(result==="PLAN_UNAVAILABLE"){el("notice").textContent="Цена или тариф изменились. Вернитесь в каталог и выберите заново."}
   else{el("notice").textContent="Не удалось подтвердить создание счёта. Проверьте сообщения бота."}
  },function(err){el("notice").textContent="Нет ответа от бота ("+String(err.code||"ошибка")+"). Проверьте чат перед повтором."})
   .finally(function(){busy=false;render()});
 });
 if(TW){TW.onEvent("chatDataChanged",receive);receive();TW.ready()}
 else {render();el("notice").textContent="Карточка доступна в приложении Telegram."}
})();
</script></body></html>`;

export function vpnPurchaseWidgetHtml():string {
  const original=Buffer.from(HTML,'utf8'),compressed=deflateSync(original,{level:9});
  if(original.length>32768||compressed.length>3800)
    throw new Error('Telegram purchase widget exceeds payload limit ('+original.length+'/'+compressed.length+')');
  return HTML;
}
export function vpnPurchaseWidgetPayload(chatId:number,plans:ReadonlyArray<PricedPlan>) {
  if(!Number.isSafeInteger(chatId)||chatId<=0)throw new Error('Invalid private chat');
  const chat_data=vpnPurchaseWidgetData(plans);
  const visible=JSON.parse(chat_data) as PurchaseState;
  return {chat_id:chatId,html:vpnPurchaseWidgetHtml(),allow_queries:true,chat_data,
    caption:'MNEBYVPN · VPN: '+visible.p.map(p=>p[0]+' дней — '+p[1]+' ⭐').join(' · ')+
      '. Выберите срок в карточке и подтвердите оплату в Telegram.'};
}
