/** Telegram Bot API 10.4 widgets (TelegramMessenger/widget-sandbox, layer 233).
 * HTML is immutable and forwardable: keep user state in private chat_data,
 * never embedded in HTML or in public_data.
 */
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export interface StatusPackage {
  product:'vpn'|'smart_dns';state:string;expiresAt:Date|null;
  quotaLimitBytes:bigint|null;quotaUsedBytes:bigint;
}
export interface StarsPlan {
  title:string;planId:string;stars:number|null;
  product?:string;durationSeconds?:number;dnsQuotaBytes?:bigint|null;
}
type Card={n:string;d:string;p:number;buy:boolean;key?:string};
type State={v:1;k:'status'|'plans';c:Card[];more:number;updated:string};
const MAX=4, GIB=1024n*1024n*1024n;
/** Stable opaque catalog key, not a secret; never depend on mutable list order. */
export function planWidgetKey(plan:StarsPlan):string {
 if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(plan.planId) ||
    plan.stars===null || !Number.isSafeInteger(plan.stars) || plan.stars<=0)
   throw new Error('Invalid plan');
 const terms=JSON.stringify([plan.planId,plan.title,plan.stars,
   plan.product??null,plan.durationSeconds??null,
   plan.dnsQuotaBytes===undefined||plan.dnsQuotaBytes===null?null:String(plan.dnsQuotaBytes)]);
 return createHash('sha256').update('mnebyvpn:plan:v2:'+terms).digest('base64url').slice(0,16);
}
const gb=(n:bigint):string=>{
  const x=(n<0n?0n:n)*100n/GIB;
  return String(x/100n)+'.'+String(x%100n).padStart(2,'0')+' ГБ';
};
function pack(s:State):string {
  const json=JSON.stringify(s);
  if(Buffer.byteLength(json,'utf8')>1024||json.includes('\0'))throw new Error('Invalid widget chat data');
  return json;
}
function stamp(now:Date):string {
  if(!Number.isFinite(now.getTime()))throw new Error('Invalid timestamp');
  return now.toISOString().slice(0,16).replace('T',' ');
}
export function statusWidgetData(items:ReadonlyArray<StatusPackage>,now=new Date()):string {
  return pack({v:1,k:'status',c:items.slice(0,MAX).map(p=>{
    const label=p.product==='vpn'?'VPN':'MNEBYDNS';
    const status=p.state==='ACTIVE'?'Активен':p.state==='REFUNDED'?'Возврат':
      p.state==='EXPIRED'?'Истёк':p.state==='SUSPENDED'?'Остановлен':'Ожидает выдачи';
    const rest=p.quotaLimitBytes===null?'Квота не задана':gb(p.quotaLimitBytes-p.quotaUsedBytes);
    const pct=p.quotaLimitBytes===null||p.quotaLimitBytes<=0n?0:
      Number((p.quotaUsedBytes*100n/p.quotaLimitBytes)>100n?100n:
        (p.quotaUsedBytes*100n/p.quotaLimitBytes)<0n?0n:
        p.quotaUsedBytes*100n/p.quotaLimitBytes);
    return {n:label,d:status+' · осталось '+rest+' · до '+(p.expiresAt?.toISOString().slice(0,10)??'—'),p:pct,buy:false};
  }),more:Math.max(0,items.length-MAX),updated:stamp(now)});
}
export function plansWidgetData(items:ReadonlyArray<StarsPlan>,now=new Date()):string {
  const plans=items.filter(p=>p.stars!==null);
  return pack({v:1,k:'plans',c:plans.slice(0,MAX).map(p=>{
    if(!Number.isSafeInteger(p.stars)||p.stars===null||p.stars<=0)throw new Error('Invalid Stars price');
    return {n:p.title.slice(0,72),d:String(p.stars)+' ⭐ за пакет',p:0,buy:true,key:planWidgetKey(p)};
  }),more:Math.max(0,plans.length-MAX),updated:stamp(now)});
}
export function validateWidgetData(json:string):void {
  if(Buffer.byteLength(json,'utf8')>1024||json.includes('\0'))throw new Error('Invalid widget state bytes');
  const x=JSON.parse(json) as Partial<State>;
  if(x.v!==1||!['status','plans'].includes(x.k??'')||!Array.isArray(x.c)||x.c.length>MAX)
    throw new Error('Invalid widget state structure');
}
// Profile 1 only. All variable text arrives in TelegramWidget.chatData.
// Fixed slots avoid dynamic HTML injection; all labels use textContent.
const HTML=String.raw`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{font-family:system-ui,sans-serif;color:var(--tg-theme-text-color);background:var(--tg-theme-bg-color)}
*{box-sizing:border-box}body{margin:0;padding:12px 12px 22px}
header{display:flex;gap:9px;align-items:center;margin-bottom:12px}
.mark{width:40px;height:40px;border-radius:13px;background:#19b7c3;color:white;display:grid;place-items:center;font-weight:800;font-size:23px}
h2{font-size:17px;margin:0}small{font-size:11px;color:var(--tg-theme-hint-color)}
.tabs{display:flex;gap:7px;margin-bottom:11px}
button{border:0;border-radius:11px;padding:9px 12px;color:var(--tg-theme-text-color);background:var(--tg-theme-secondary-bg-color);font:inherit}
button[aria-selected=true],.buy{color:var(--tg-theme-button-text-color);background:var(--tg-theme-button-color)}
.card{border-radius:13px;padding:10px;margin:7px 0;background:var(--tg-theme-secondary-bg-color)}
.top{display:flex;align-items:center;justify-content:space-between;gap:6px}
.name{font-weight:700;font-size:15px}.detail{font-size:12px;color:var(--tg-theme-hint-color);margin:6px 0}
.bar{height:5px;border-radius:5px;background:var(--tg-theme-bg-color);overflow:hidden}.fill{display:block;height:100%;width:0;background:var(--tg-theme-button-color)}
.buy{padding:7px;font-size:12px}.actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
#info,#notice{font-size:11px;color:var(--tg-theme-hint-color)}
</style></head><body>
<header><div class="mark">M</div><div><h2>Мне бы VPN</h2><small>Подписки · трафик · тарифы</small></div></header>
<div class="tabs"><button type="button" id="tabstatus">Мои пакеты</button><button type="button" id="tabplans">Тарифы</button></div>
<main>
<article class="card" id="c0" hidden><div class="top"><span class="name" id="n0"></span><button class="buy" id="b0" type="button">Купить ⭐</button></div><p class="detail" id="d0"></p><div class="bar"><i class="fill" id="f0"></i></div></article>
<article class="card" id="c1" hidden><div class="top"><span class="name" id="n1"></span><button class="buy" id="b1" type="button">Купить ⭐</button></div><p class="detail" id="d1"></p><div class="bar"><i class="fill" id="f1"></i></div></article>
<article class="card" id="c2" hidden><div class="top"><span class="name" id="n2"></span><button class="buy" id="b2" type="button">Купить ⭐</button></div><p class="detail" id="d2"></p><div class="bar"><i class="fill" id="f2"></i></div></article>
<article class="card" id="c3" hidden><div class="top"><span class="name" id="n3"></span><button class="buy" id="b3" type="button">Купить ⭐</button></div><p class="detail" id="d3"></p><div class="bar"><i class="fill" id="f3"></i></div></article>
</main><small id="info">Откройте карточку в личном чате.</small>
<div class="actions"><small id="notice"></small><button id="refresh" type="button">↻ Обновить</button></div>
<script>
(function(){
 var TW=typeof TelegramWidget==="undefined"?null:TelegramWidget,view=null,busy=false;
 function el(s){return document.getElementById(s)}
 function draw(raw){
  try{var s=JSON.parse(raw||"");view=s&&s.v===1&&Array.isArray(s.c)?s:null}catch(e){view=null}
  for(var i=0;i<4;i++){
   var c=view&&view.c[i],node=el("c"+i);node.hidden=!c;
   if(!c)continue;
   el("n"+i).textContent=String(c.n).slice(0,72);
   el("d"+i).textContent=String(c.d).slice(0,160);
   el("f"+i).style.width=String(Math.max(0,Math.min(100,Number(c.p)||0)))+"%";
   el("b"+i).hidden=!c.buy;
  }
  el("tabstatus").setAttribute("aria-selected",String(!!view&&view.k==="status"));
  el("tabplans").setAttribute("aria-selected",String(!!view&&view.k==="plans"));
  el("info").textContent=view?"Обновлено: "+view.updated+(view.more?" · ещё "+view.more:""):
    "Это копия: личные данные не передаются.";
 }
 function ask(data){
  if(!TW||busy||typeof TW.request!=="function")return;
  busy=true;el("notice").textContent="Загрузка…";
  TW.request(data).then(function(answer){
   if(answer&&answer.result&&answer.result.charAt(0)==="{")draw(answer.result);
   el("notice").textContent=data.slice(0,4)==="buy:"?"Счёт отправлен":"Готово";
  },function(err){el("notice").textContent="Ошибка: "+String(err.code||"RETRY").slice(0,24)})
   .finally(function(){busy=false});
 }
 for(var i=0;i<4;i++){(function(j){el("b"+j).addEventListener("click",function(){ask("buy:"+String(view&&view.c[j]&&view.c[j].key||""))})})(i)}
 el("tabstatus").addEventListener("click",function(){ask("view:status")});
 el("tabplans").addEventListener("click",function(){ask("view:plans")});
 el("refresh").addEventListener("click",function(){ask(view&&view.k==="plans"?"view:plans":"view:status")});
 if(TW){TW.onEvent("chatDataChanged",function(){draw(TW.chatData)});draw(TW.chatData);TW.ready()}
 else draw(null);
})();
</script></body></html>`;

export function vpnWidgetHtml():string {
  const bytes=Buffer.from(HTML,'utf8'),packed=deflateSync(bytes,{level:9});
  // Stay below 4096 with margin for differences to PHP gzcompress().
  if(bytes.length>32768||packed.length>3800)throw new Error('Widget exceeds Telegram 10.4 payload limit');
  return HTML;
}
export function vpnWidgetPayload(chatId:number,chatData:string) {
  if(!Number.isSafeInteger(chatId)||chatId<=0)throw new Error('Invalid private chat id');
  validateWidgetData(chatData);
  return {chat_id:chatId,html:vpnWidgetHtml(),width:0,height:0,allow_queries:true,
    caption:'MNEBYVPN: подписки и тарифы. Старые клиенты: /my и /plans.',
    chat_data:chatData};
}
