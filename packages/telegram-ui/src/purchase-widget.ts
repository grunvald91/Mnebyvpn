/** Minimalist in-chat VPN checkout for Telegram Bot API 10.4.
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
:root{font-family:system-ui,ui-sans-serif,sans-serif;color:var(--tg-theme-text-color);background:var(--tg-theme-bg-color)}
*{box-sizing:border-box}
body{margin:0;padding:13px 12px 23px;font-size:14px}
header{display:flex;align-items:center;gap:9px;margin:0 0 12px}
.brand{height:37px;width:37px;border-radius:12px;background:#1677ff;display:grid;place-items:center;color:white}
.brand svg{width:22px;height:22px}
.brandname{font-size:15px;font-weight:740;letter-spacing:.01em}
.meta{font-size:11px;color:var(--tg-theme-hint-color);margin-top:2px}
.hero{background:linear-gradient(135deg,#edf5ff,#dbeafe);border-radius:18px;min-height:116px;padding:15px;display:flex;justify-content:space-between;align-items:center;gap:6px;overflow:hidden}
.hero h2{font-size:19px;font-weight:760;line-height:1.13;letter-spacing:-.035em;margin:0 0 6px;color:#172c53}
.hero p{font-size:11px;line-height:1.4;color:#557397;margin:0;max-width:164px}
.orbit{width:94px;height:94px;min-width:94px;border-radius:50%;background:radial-gradient(circle at 25% 22%,#76bbff,#2675e2 63%,#13419b);box-shadow:0 10px 21px #2877d133;position:relative}
.orbit:before{content:"";position:absolute;inset:7px 24px;border:2px solid #ffffff91;border-radius:50%}
.orbit:after{content:"";position:absolute;top:44px;left:0;width:94px;border-top:2px solid #ffffff91}
.eyebrow{font-size:10px;letter-spacing:.11em;color:var(--tg-theme-hint-color);font-weight:750;margin:18px 0 9px}
.options{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.option{border:1px solid var(--tg-theme-section-separator-color);color:var(--tg-theme-text-color);background:var(--tg-theme-secondary-bg-color);border-radius:13px;text-align:left;padding:11px 10px;min-height:65px;font:inherit}
.option[aria-pressed=true]{border:2px solid #2481ff;background:var(--tg-theme-bg-color);padding:10px 9px;box-shadow:0 0 0 1px #2481ff26}
.term{font-size:13px;font-weight:730;display:block}
.amount{font-size:15px;font-weight:750;display:block;margin-top:6px}
.total{margin-top:11px;background:var(--tg-theme-secondary-bg-color);border-radius:13px;padding:12px}
.line{display:flex;align-items:center;justify-content:space-between;gap:9px}
.hint{color:var(--tg-theme-hint-color);font-size:12px}
.value{font-size:13px;font-weight:700}
.separator{height:1px;background:var(--tg-theme-section-separator-color);margin:11px 0}
.price{font-size:21px;font-weight:780;letter-spacing:-.025em}
#pay{border:0;border-radius:13px;width:100%;padding:13px 8px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font:inherit;font-size:14px;font-weight:740;margin-top:11px}
#pay[disabled]{opacity:.56}
#notice{min-height:16px;margin:9px 2px 0;font-size:11px;color:var(--tg-theme-hint-color);line-height:1.4}
footer{font-size:10px;color:var(--tg-theme-hint-color);line-height:1.4;margin-top:8px}
@media(prefers-color-scheme:dark){.hero{background:linear-gradient(135deg,#182c49,#213e6b)}.hero h2{color:#f2f7ff}.hero p{color:#b0c9ee}}
</style></head><body>
<header><div class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 20 6v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4Z"/><path d="m9 12 2 2 4-4"/></svg></div><div><div class="brandname">MNEBYVPN</div><div class="meta">VPN · один аккаунт · выбор периода</div></div></header>
<section class="hero"><div><h2>Доступ<br>без лишних шагов.</h2><p>Выберите период и оплатите звёздами Telegram.</p></div><div class="orbit" aria-hidden="true"></div></section>
<div class="eyebrow">ВЫБЕРИТЕ ПЕРИОД</div>
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
<footer>Разовый пакет. Telegram выставит счёт в Stars, оплата подтверждается отдельно. Доступ выдаётся только после подтверждения платежа.</footer>
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
