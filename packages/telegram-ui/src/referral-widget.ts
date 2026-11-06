/** Forwardable Bot API 10.4 widget: PUBLIC price offers, never customer data.
 * Spec: TelegramMessenger/widget-sandbox/docs/tgw-format.md, SDK profile v1.
 * A product+duration button deep-links to a SINGLE server-side plan; bot sends
 * payment invoice without a second choice. Token is an attribution ID, not access.
 */
import { deflateSync } from 'node:zlib';
export interface PublicReferralOffer {
  planId:string;title:string;
  product:'vpn'|'smart_dns'|'bundle';
  stars:number;rubMinor:number|null;token:string;
  durationSeconds:number;dnsQuotaBytes?:bigint|null;trialAvailable?:boolean;
}
const TOKEN=/^[A-Za-z0-9_-]{16,24}$/;
const BOT=/^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const DAY=86400;
const MAX_ITEMS=16;
type Row=[number,number,number,number,string,string,number,number];
function item(o:PublicReferralOffer):Row {
  const duration=o.durationSeconds;
  if(!TOKEN.test(o.token)||!Number.isSafeInteger(duration)||duration<=0||
    duration%DAY!==0||!Number.isSafeInteger(o.stars)||o.stars<=0||
    (o.rubMinor!==null&&(!Number.isSafeInteger(o.rubMinor)||o.rubMinor<=0))) {
      throw new Error('Invalid public offer');
  }
  const id=o.product==='vpn'?0:o.product==='smart_dns'?1:2;
  const quota=o.dnsQuotaBytes===null||o.dnsQuotaBytes===undefined?0:
    Number((o.dnsQuotaBytes*10n)/(1024n*1024n*1024n));
  if(!Number.isSafeInteger(quota)||quota<0||quota>1000000)
    throw new Error('Invalid DNS quota');
  return [id,duration/DAY,o.stars,o.rubMinor??0,o.token,o.title.slice(0,26),
    o.trialAvailable?1:0,quota];
}
export function referralPublicData(offers:ReadonlyArray<PublicReferralOffer>,botUsername:string,
  allowRuble=false):string {
  if(!BOT.test(botUsername)||!botUsername.toLowerCase().endsWith('bot'))
    throw new Error('Invalid configured Telegram bot username');
  const sorted=offers.slice(0,MAX_ITEMS).map(item);
  const body={v:2,b:botUsername,o:sorted,r:allowRuble?1:0,
    more:Math.max(0,offers.length-sorted.length)};
  // Preserve all 15/30/60/90 options for both VPN and DNS when 8 exist.
  // Truncate only beyond payload size, never silently change a selected plan.
  while(true){
    const json=JSON.stringify(body);
    if(Buffer.byteLength(json,'utf8')<=1024 && !json.includes('\0'))return json;
    if(body.o.length===0)throw new Error('Catalog exceeds Telegram payload limits');
    body.o.pop();body.more++;
  }
}
const HTML=String.raw`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color:var(--tg-theme-text-color);background:var(--tg-theme-bg-color);font-family:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;padding:14px 12px 17px}
header{display:flex;align-items:center;gap:9px;margin-bottom:12px}.logo{width:42px;height:42px;border-radius:14px;background:#0eafc1;color:white;display:grid;place-items:center;font-weight:900;font-size:22px}
h2{font-size:17px;margin:0}.sub{font-size:11px;color:var(--tg-theme-hint-color);margin:3px 0}
#tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
button{border:0;border-radius:11px;padding:8px 11px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);font:inherit;font-size:13px}
button[aria-selected=true],.pay{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
.offer{background:var(--tg-theme-secondary-bg-color);border-radius:14px;padding:11px;margin:7px 0}
.top{display:flex;align-items:center;justify-content:space-between;gap:9px}
.term{font-weight:750;font-size:15px}.desc{font-size:11px;color:var(--tg-theme-hint-color);margin:4px 0}
.price{font-weight:650;font-size:13px;margin:8px 0}.pay{font-size:12px;white-space:nowrap}
.trial{border:1px solid var(--tg-theme-button-color)}.trial .term{color:var(--tg-theme-link-color)}
footer{color:var(--tg-theme-hint-color);font-size:10px;line-height:1.4;margin-top:10px}
</style></head><body>
<header><div class="logo">M</div><div><h2>Мне бы VPN</h2><p class="sub">Открой интернет. Выбери свой доступ.</p></div></header>
<div id="tabs"></div><main id="offers"></main>
<footer id="footer">Цены за выбранный срок. Окончательная стоимость подтверждается ботом перед оплатой.</footer>
<script>
(function(){
 var tw=typeof TelegramWidget==="undefined"?null:TelegramWidget,s={v:0,o:[]},type=0;
 function el(k){return document.getElementById(k)}
 function mk(tag,klass,text){var e=document.createElement(tag);if(klass)e.className=klass;if(text!==undefined)e.textContent=String(text);return e}
 function open(prefix,token){
  if(!tw||typeof tw.openTelegramLink!=="function"||!new RegExp("^[A-Za-z0-9_-]{16,24}$").test(token))return;
  var bot=String(s.b||"");
  if(!new RegExp("^[A-Za-z][A-Za-z0-9_]{4,31}$").test(bot))return;
  tw.openTelegramLink("https://t.me/"+bot+"?start="+prefix+token);
 }
 function title(d){return d===1?"1 день":d<5?d+" дня":d+" дней"}
 function rub(x){return Math.floor(x/100)+","+String(x%100).padStart(2,"0")+" ₽"}
 function draw(){
  var tabs=el("tabs"),list=el("offers");tabs.textContent="";list.textContent="";
  var cats=[[0,"🌐 VPN"],[1,"🧭 Smart DNS"],[2,"🔐 Комплект"]];
  cats.forEach(function(c){
   if(!s.o.some(function(r){return Array.isArray(r)&&r[0]===c[0]}))return;
   var b=mk("button","",c[1]);b.type="button";b.setAttribute("aria-selected",String(type===c[0]));
   b.addEventListener("click",function(){type=c[0];draw()});tabs.appendChild(b);
  });
  var rows=s.o.filter(function(r){return Array.isArray(r)&&r[0]===type});
  rows.sort(function(a,b){return a[1]-b[1]});
  rows.forEach(function(r){
   var card=mk("article","offer"),top=mk("div","top"),left=mk("div"),btn=mk("button","pay","Оплатить ⭐");
   left.appendChild(mk("div","term",title(r[1])));
   left.appendChild(mk("div","desc",String(r[5]||"").slice(0,26)));
   if(r[0]!==0&&r[7]>0)left.appendChild(mk("div","desc","DNS: "+String(r[7]/10)+" ГБ"));
   top.appendChild(left);btn.type="button";
   btn.addEventListener("click",function(){open("r",r[4])});top.appendChild(btn);card.appendChild(top);
   card.appendChild(mk("div","price",String(r[2])+" ⭐  ·  "+(r[3]>0?rub(r[3]):"₽ —")));
   if(s.r===1&&r[3]>0){
    var rubButton=mk("button","pay","Оплатить ₽");
    rubButton.type="button";
    rubButton.addEventListener("click",function(){open("p",r[4])});
    card.appendChild(rubButton);
   }
   list.appendChild(card);
  });
  var trial=rows.find(function(r){return r[6]===1});
  if(trial){
   var box=mk("article","offer trial"),top=mk("div","top"),label=mk("div");
   label.appendChild(mk("div","term","🎁 1 день бесплатно"));
   label.appendChild(mk("div","desc","Один раз на Telegram-аккаунт"));
   top.appendChild(label);
   var b=mk("button","pay","Попробовать");b.type="button";
   b.addEventListener("click",function(){open("t",trial[4])});
   top.appendChild(b);box.appendChild(top);list.insertBefore(box,list.firstChild);
  }
  if(!rows.length)list.appendChild(mk("p","desc","В этой категории пока нет опубликованных тарифов."));
  el("footer").textContent="Оплата через Telegram Stars. ₽ — цена для отдельного сайта Продамус. "+
   "Перед оплатой бот проверит текущую цену."+(s.more?" Ещё тарифы доступны в боте.":"");
 }
 try{
  s=JSON.parse(tw&&tw.publicData||"{}");
  if(s.v!==2||!Array.isArray(s.o)||!s.o.length||typeof s.b!=="string")throw 0;
  if(!s.o.some(function(r){return r[0]===0}))type=s.o[0][0];
  draw();
 }catch(e){el("offers").appendChild(mk("p","desc","Предложение недоступно. Откройте обновлённую карточку."))}
 if(tw)tw.ready();
})();
</script></body></html>`;
export function referralWidgetHtml():string {
  const utf8=Buffer.from(HTML,'utf8'),packed=deflateSync(utf8,{level:9});
  if(utf8.length>32768||packed.length>3800)
    throw new Error('Forwardable widget exceeds Telegram size limits');
  return HTML;
}
export function referralWidgetPayload(chatId:number,offers:ReadonlyArray<PublicReferralOffer>,
  botUsername:string,allowRuble=false) {
  if(!Number.isSafeInteger(chatId)||chatId<=0)throw new Error('Invalid chat');
  const public_data=referralPublicData(offers,botUsername,allowRuble);
  const first=offers[0];
  return {
    chat_id:chatId,html:referralWidgetHtml(),width:0,height:0,
    caption:'Мне бы VPN · VPN, DNS и бесплатный пробный день. Выбери услугу и срок внутри карточки.'+
      (first?' https://t.me/'+botUsername+'?start=r'+first.token:''),
    public_data,
  };
}
