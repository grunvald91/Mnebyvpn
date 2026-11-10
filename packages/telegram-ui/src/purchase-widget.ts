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
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#f5f8ff;background:#080d25;color-scheme:dark}
*{box-sizing:border-box}
html{background:#080d25}
body{margin:0;min-width:0;padding:14px 13px 17px;overflow-x:hidden;background:radial-gradient(ellipse at 100% 2%,#6625a267,transparent 65%),linear-gradient(145deg,#080d25,#132256 65%,#100d34);font-size:13px}
header{display:flex;align-items:center;gap:10px;margin:0 0 13px}
.brand{position:relative;flex:0 0 39px;width:39px;height:39px;border-radius:13px;overflow:hidden;background:radial-gradient(circle at 33% 26%,#66ffff,#137df6 36%,#28166f 72%);border:1px solid #80efffe0;box-shadow:0 0 17px #0edfff73,inset 0 0 9px #070825}
.brand:before{content:"";position:absolute;width:57px;height:14px;border:2px solid #a75aff;transform:rotate(-29deg);top:13px;left:-12px;border-radius:50%;box-shadow:0 0 10px #32eaff}
.brand:after{content:"";position:absolute;width:29px;height:5px;background:linear-gradient(90deg,#edc67e,#fff6ba,#34f4ff);top:8px;right:-8px;transform:rotate(-28deg);border-radius:5px;box-shadow:0 0 10px #ffdb94}
.brandname{font-size:17px;font-weight:880;letter-spacing:-.55px;line-height:1.1;background:linear-gradient(95deg,#fff 25%,#57eeff 66%,#bda4ff);color:transparent;-webkit-background-clip:text;background-clip:text}
.meta{font-size:10px;color:#b2c7ec;margin-top:3px;letter-spacing:.1px}
.hero{position:relative;isolation:isolate;min-height:139px;border:1px solid #80c5ff78;border-radius:23px;padding:17px 12px 14px 16px;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:5px;background:linear-gradient(128deg,#075073b8,#233c87a8 51%,#5a2390ba);box-shadow:inset 0 1px #ffffff6e,0 10px 26px #04082976}
.hero-copy{position:relative;z-index:2;min-width:0;max-width:59%}
.hero-chip{display:inline-block;border:1px solid #a5f6ff75;border-radius:20px;padding:4px 9px;background:#051c417a;color:#98efff;font-weight:750;font-size:9px;letter-spacing:.6px;box-shadow:inset 0 1px #ffffff30}
.hero h2{font-size:22px;font-weight:850;line-height:1.07;letter-spacing:-.7px;margin:10px 0 6px;color:#fff;text-shadow:0 2px 15px #00194777}
.hero h2 span{color:#93f9ff}
.hero p{font-size:11px;line-height:1.42;color:#d7e5ff;margin:0;max-width:168px}
.energy{width:111px;min-width:111px;height:115px;position:relative;transform:translate(8px,3px);filter:drop-shadow(0 12px 17px #050f4d88)}
.planet{position:absolute;left:21px;top:17px;width:82px;height:82px;border-radius:50%;background:radial-gradient(circle at 30% 23%,#dbffff 0%,#58eaff 16%,#146bfc 39%,#1e1a80 71%,#100839 90%);border:1px solid #a6f9ffb5;box-shadow:inset -10px -12px 16px #090c62,0 0 24px #23dfff9c}
.orbit{position:absolute;left:3px;top:46px;width:119px;height:32px;border:3px solid #61f4ff;border-left-color:#a96aff;border-right-color:#d98bff;border-radius:50%;transform:rotate(-28deg);box-shadow:0 0 9px #5ef4ff,0 0 17px #9e58ff55}
.eyebrow{margin:16px 1px 10px;font-size:10px;font-weight:850;letter-spacing:1.1px;color:#84e8ff}
.options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.option{position:relative;isolation:isolate;overflow:hidden;min-height:77px;min-width:0;border:1px solid #9cbbff77;border-radius:18px;padding:12px 12px 10px;text-align:left;font:inherit;color:#f3f9ff;background:linear-gradient(145deg,#235987b5,#33316dba 60%,#5a2a83a3);box-shadow:inset 0 1px #ffffff52,0 7px 15px #03092380;cursor:pointer}
.option[aria-pressed=true]{background:linear-gradient(125deg,#05c8d3d9,#287fffe6 51%,#8a47f1e1);border:1px solid #bbffff;box-shadow:inset 0 1px #ffffff9d,0 0 0 1px #4cdcff78,0 0 19px #00deef69;transform:translateY(-1px)}
.option:focus-visible,#pay:focus-visible{outline:2px solid #fff;outline-offset:3px}
.term{display:block;font-size:13px;font-weight:720;color:#e4eeff}
.amount{display:block;font-size:18px;font-weight:850;letter-spacing:-.25px;margin-top:7px;color:#fff;text-shadow:0 1px 10px #06dcfa40}
.total{margin-top:12px;border:1px solid #9ab8f44d;background:linear-gradient(123deg,#112f55ad,#232159c9 65%,#2d1758c7);box-shadow:inset 0 1px #ffffff29,0 7px 20px #03092363;border-radius:17px;padding:13px 14px}
.line{display:flex;align-items:center;justify-content:space-between;gap:9px}
.hint{color:#b4c8e7;font-size:11px}
.value{font-size:12px;font-weight:740;color:#e8f8ff}
.separator{height:1px;background:linear-gradient(90deg,transparent,#88b4fc52,transparent);margin:12px 0}
.price{font-size:23px;font-weight:860;letter-spacing:-.55px;color:#9cfcff;text-shadow:0 0 19px #01dff74a}
#pay{width:100%;min-height:48px;margin-top:12px;border:1px solid #bffbffe0;border-radius:17px;color:#fff;background:linear-gradient(105deg,#00d4df,#3288ff 49%,#b052f3);font:inherit;font-size:15px;font-weight:840;letter-spacing:.1px;text-shadow:0 1px 2px #08163657;box-shadow:inset 0 1px #ffffff8c,0 0 16px #00e8f45c,0 9px 20px #431ab15e;}
#pay:disabled{opacity:.62;cursor:not-allowed;box-shadow:none}
#notice{min-height:10px;margin:8px 3px 0;font-size:11px;color:#abe3ff;line-height:1.45}
footer{margin-top:10px;font-size:10px;color:#9dadcf;line-height:1.45;text-align:center}
@media(max-width:320px){body{padding:11px 10px 14px}.hero{padding:12px}.energy{transform:translate(9px,3px) scale(.82);margin-left:-11px}.hero h2{font-size:19px}.option{padding:10px 9px}}
@media(prefers-reduced-motion:reduce){.option,#pay{transition:none}}
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
    throw new Error('Telegram purchase widget exceeds payload limit');
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
