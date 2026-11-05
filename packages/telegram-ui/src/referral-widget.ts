/** Public, forwardable mini HTMLBubble. Telegram layer 233 / Bot API 10.4.
 * Unlike personal dashboard widgets, all displayed state is PUBLIC and
 * intentionally survives forwards in public_data. No customer secrets or
 * private Telegram IDs are embedded.
 */
import { deflateSync } from 'node:zlib';

export interface PublicReferralOffer {
  planId:string;title:string;product:'vpn'|'smart_dns'|'bundle';
  stars:number;rubMinor:number|null;token:string;
}
const tokenPattern=/^[A-Za-z0-9_-]{16,24}$/;
const botPattern=/^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const rub=(minor:number)=>String(Math.floor(minor/100))+','+String(minor%100).padStart(2,'0')+' ₽';

export function referralPublicData(offers:ReadonlyArray<PublicReferralOffer>,botUsername:string):string {
  if(!botPattern.test(botUsername)||!botUsername.toLowerCase().endsWith('bot'))
    throw new Error('Invalid configured Telegram bot username');
  if(offers.length>3)throw new Error('Referral card has three offers max');
  const cards=offers.map(o=>{
    if(!tokenPattern.test(o.token)||!Number.isSafeInteger(o.stars)||o.stars<=0||
       (o.rubMinor!==null&&(!Number.isSafeInteger(o.rubMinor)||o.rubMinor<=0)))
      throw new Error('Invalid public referral offer');
    return {
      n:o.title.slice(0,54),
      p:o.product==='vpn'?'VPN':o.product==='smart_dns'?'Smart DNS':'VPN + DNS',
      s:o.stars,
      r:o.rubMinor===null?'—':rub(o.rubMinor),
      u:'https://t.me/'+botUsername+'?start=r'+o.token,
    };
  });
  const result=JSON.stringify({v:1,c:cards});
  if(Buffer.byteLength(result,'utf8')>1024||result.includes('\0'))
    throw new Error('Public referral catalog exceeds 1024 UTF-8 bytes');
  return result;
}
// HTML is fixed for EVERY referrer; links and titles arrive only as public_data.
// Forwarded copies receive public_data, but NEVER the private dashboard chat_data.
const HTML=String.raw`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color:var(--tg-theme-text-color);background:var(--tg-theme-bg-color);font-family:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;padding:13px 12px 22px}
h2{font-size:17px;margin:0 0 4px}.lead{font-size:12px;color:var(--tg-theme-hint-color);margin:0 0 12px}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;background:var(--tg-theme-secondary-bg-color);border-radius:14px;padding:11px;margin:7px 0}
.n{font-weight:700;font-size:14px}.p{font-size:11px;color:var(--tg-theme-hint-color);margin:5px 0}.price{font-size:13px;font-weight:700;margin:5px 0}
button{border:0;border-radius:10px;padding:9px 11px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font:inherit;font-size:12px;font-weight:700}
small{color:var(--tg-theme-hint-color);font-size:11px}
</style></head><body>
<h2>🌐 Мне бы VPN</h2><p class="lead">Выбери то, что нужно: VPN или Smart DNS</p>
<div id="list">
<div id="c0" class="row" hidden><div><div id="n0" class="n"></div><p class="p" id="p0"></p><div id="x0" class="price"></div></div><button id="b0">Выбрать</button></div>
<div id="c1" class="row" hidden><div><div id="n1" class="n"></div><p class="p" id="p1"></p><div id="x1" class="price"></div></div><button id="b1">Выбрать</button></div>
<div id="c2" class="row" hidden><div><div id="n2" class="n"></div><p class="p" id="p2"></p><div id="x2" class="price"></div></div><button id="b2">Выбрать</button></div>
</div><small id="info">Цены на момент отправки. Перед оплатой бот покажет актуальную стоимость.</small>
<script>
(function(){
 var tw=typeof TelegramWidget!=="undefined"?TelegramWidget:null,links=[];
 function el(id){return document.getElementById(id)}
 try{var s=JSON.parse(tw&&tw.publicData||'{}');if(s.v!==1||!Array.isArray(s.c))throw 0;
 for(var i=0;i<3;i++){var c=s.c[i];el("c"+i).hidden=!c;if(!c)continue;
  el("n"+i).textContent=String(c.n).slice(0,54);
  el("p"+i).textContent=String(c.p).slice(0,20);
  el("x"+i).textContent=String(c.s)+" ⭐ · "+String(c.r).slice(0,30);
  links[i]=String(c.u);
 }
 }catch(e){el("info").textContent="Откройте предложение в Telegram заново."}
 for(var j=0;j<3;j++){(function(k){el("b"+k).addEventListener("click",function(){
  if(tw&&links[k]&&new RegExp("^https://t[.]me/[A-Za-z0-9_]+[?]start=r[A-Za-z0-9_-]{16,24}$").test(links[k]))
    tw.openTelegramLink(links[k]);
 })})(j)}
 if(tw)tw.ready();
})();
</script></body></html>`;
export function referralWidgetHtml():string {
  const utf8=Buffer.from(HTML,'utf8'),packed=deflateSync(utf8,{level:9});
  if(utf8.length>32768||packed.length>3800)
    throw new Error('Forwardable widget exceeds Telegram size limits');
  return HTML;
}
/** No allow_queries, no chat_data: forwarded copies are functional and safe. */
export function referralWidgetPayload(chatId:number,offers:ReadonlyArray<PublicReferralOffer>,botUsername:string) {
  if(!Number.isSafeInteger(chatId)||chatId<=0)throw new Error('Invalid chat');
  const public_data=referralPublicData(offers,botUsername);
  return {
    chat_id:chatId,html:referralWidgetHtml(),width:0,height:0,
    caption:'Мне бы VPN · VPN и Smart DNS. Тарифы и выбор внутри карточки. '+
      'Если карточка не открывается: https://t.me/'+botUsername+'?start=r'+(offers[0]?.token??''),
    public_data,
  };
}
