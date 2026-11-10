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
// Inline 80px WebP derived from apps/web/public/brand-avatar.webp; the same real Telegram avatar is reused for header and hero.
const HTML=String.raw`<!doctype html><html lang="ru"><style>:root{--art:url('data:image/webp;base64,UklGRnYDAABXRUJQVlA4IGoDAADQEgCdASpQAFAAP32gxV22Kygktx47asAviWwAuzSSiKg2Y5I/RX5rfQnbbm0a36fTIE/2pjVsSl1YTVb46mn2Bqm1bYVy3fG5HwfOJZyCuEWyYCifZ1XwQdDJU9v9iS9hyz/IfppuEssUGzBVmZXfXIKweytMoHnOhHYMtPfsqz2ECepQme1GkZW/iutaEKPnxvNEvgJpkcZ3vNyYRgAA/vVl1uzPqpyTB+XYOyuSR+34XbFOxlaCMBOpMZoyebqBBSS+MpZ4LQqua/EjGoim4GEgjhHyWCmYy2KHmGuDxeGxCM0OMI1pac6P2E1bKV3fJ5AAUMbi4ni2M6Ev8sfv37wdYSi8qswzi4dpNFLt0NBHytZXYhW0kEQsjT0HiuflOrT9eiHNgsbdUxaHB29atSZShXSphdrrDM6owHOmWNL8KgzI0pGbum+KL/tSL35DdwhvRAgGrAAmwMr+7wRw/NL55z9IzAXNYpXOz8dy9X1IwMEXVIXbVWz8ebuVz+6OCAui5FDQLRcr6jKr9Jg9wfUS4wFiB+jNhDsZfzqbK1pBp4hW/p/pIba9tZlOYnUyfOGF4e7FCAXgLEIcm4EbRwxolYHoUrPIgqxlltkwyydGKxrcT4iYaatq9oEvfNbizSwpc/nbUcsoIcBWn/nK/TwXxqW4BYX8ugrGpRe9ONOEYPVKDcEMhzGqXnjkqIIZKF2yd6bCMynna1vUWpRJErNKL9m3Xh8sE2D69g0fq+uTGj19/ShDrJm5Th179nBEBgVC3E8PrdxIao0r7sUoxYZFyU8cVo0USvgdGjQIpPGArHiS6gvvKF8dgtTZq2HfpYr4P3j0u3Q3j+888VXfHzF0RSdRKC3SmthrkULgUFErvtjGoIFY43keqf4n9u+qBrcHtTEiPeiwykWZC7JEYkBGvOIf6yeC3nu0MnWd7DdwKrewTA5wRBgHcp1jMZmSscL9Lei9oKOkHDNdUgyI0TVKlCiNQOM+tG2uGNT7T49ZWGOvrmQupIW7pR/Wl7knMI60wqFknW8k0xzXKg/Q6O26mbwBrniM2p7ItX6nQanW3/43MXuBCNqwKi1t2GgbAO8dTFIkwHfOIRE1KLyN8xqQGp68goPS5bCGBLTBRivdHv6ocYOh7GfFpmWouwTjX5Kng2ezgAAA');font-family:system-ui,sans-serif;color:#f5f8ff;background:#080b20}
*{box-sizing:border-box}body{margin:0;padding:12px 12px 15px;background:radial-gradient(circle at 88% 3%,#8d37b84d,transparent 37%),linear-gradient(156deg,#071224,#101b43 60%,#110e31);color:#f5f8ff}
header{display:flex;align-items:center;gap:9px;margin-bottom:10px}.avatar{width:39px;height:39px;flex:none;border-radius:50%;background:var(--art) center/cover;border:1px solid #7feaff5c}.name{font-size:16px;font-weight:850}.sub{font-size:10px;color:#a8bddf;margin-top:2px}
.hero{height:126px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;padding:11px 10px 11px 15px;border:1px solid #72e5ff65;border-radius:21px;background:linear-gradient(115deg,#0e375dd9,#1a316dcf 54%,#47206bdb)}
.copy{position:relative;z-index:1;width:58%}.pill{font-size:9px;color:#8ff4ff;font-weight:800;letter-spacing:1px}.hero h2{font-size:21px;line-height:1.08;margin:8px 0 6px;letter-spacing:-.6px}.hero h2 span{color:#85f9ff}.hero p{font-size:10px;color:#deebff;line-height:1.4;margin:0}.art{width:110px;height:110px;flex:none;border-radius:50%;background:var(--art) center/cover}
.eyebrow{font-weight:800;font-size:10px;color:#96dfff;letter-spacing:1px;margin:15px 0 9px}.options{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.option{position:relative;min-width:0;min-height:69px;border-radius:16px;padding:9px 11px;text-align:left;font:inherit;color:white;border:1px solid #a6beff5c;background:linear-gradient(140deg,#274574c9,#35376fb8 70%,#512671bb)}
.option[aria-pressed=true]{background:linear-gradient(114deg,#0ebfce,#347ff8 55%,#8b51e3);border:1px solid #adfeff;box-shadow:inset 0 1px #ffffff88,0 0 16px #29eaff88}
.term{display:block;font-size:13px;font-weight:700}.amount{display:block;font-size:17px;font-weight:850;margin-top:5px}.total{border-radius:15px;margin-top:10px;padding:11px 12px;background:linear-gradient(110deg,#15365bac,#261f5bd9);border:1px solid #759ed14d}.line{display:flex;align-items:center;justify-content:space-between}.hint{font-size:11px;color:#b2c8ea}.value{font-size:12px;font-weight:700}.separator{height:1px;background:#afcaff36;margin:9px 0}.price{font-size:20px;font-weight:850;color:#92faff}
#pay{width:100%;border-radius:16px;margin-top:10px;min-height:46px;border:1px solid #b5feff;color:white;background:linear-gradient(105deg,#13d9e8,#3c8efc 54%,#a25bea);font:inherit;font-size:14px;font-weight:800}#pay:disabled{opacity:.5}#notice{font-size:10px;color:#a5f4ff;min-height:8px;margin-top:7px}footer{font-size:9px;color:#a3b9df;text-align:center;line-height:1.3;margin-top:7px}</style><body><header><div class="avatar" aria-hidden="true"></div><div><div class="name">MNEBYVPN</div><div class="sub">Личный VPN · Telegram Stars</div></div></header>
<section class="hero"><div class="copy"><span class="pill">СВОБОДНЫЙ ИНТЕРНЕТ</span><h2>Без стен.<br><span>Без границ.</span></h2><p>Выбери период и оплати в Telegram.</p></div><div class="art" aria-hidden="true"></div></section>
<div class="eyebrow">ВЫБЕРИ ПЕРИОД</div>
<div class="options">
<button class="option" id="o0" type="button" hidden><span class="term" id="t0"></span><span class="amount" id="a0"></span></button>
<button class="option" id="o1" type="button" hidden><span class="term" id="t1"></span><span class="amount" id="a1"></span></button>
<button class="option" id="o2" type="button" hidden><span class="term" id="t2"></span><span class="amount" id="a2"></span></button>
<button class="option" id="o3" type="button" hidden><span class="term" id="t3"></span><span class="amount" id="a3"></span></button>
</div><section class="total"><div class="line"><span class="hint">Устройств</span><span class="value" id="devices">1</span></div><div class="separator"></div><div class="line"><span class="hint" id="duration">Выбранный период</span><span class="price" id="total">—</span></div></section>
<button id="pay" type="button" disabled>Выберите тариф</button><div id="notice" aria-live="polite"></div><footer>Разовый пакет · счёт в Stars · доступ после оплаты</footer><script>(()=>{let w=typeof TelegramWidget=='undefined'?null:TelegramWidget,s={p:[]},i=1,b=0,k='';const e=id=>document.getElementById(id),term=n=>n===1?'1 день':n%10>1&&n%10<5&&(n%100<12||n%100>14)?n+' дня':n+' дней';function draw(){let p=s.p[i];for(let j=0;j<4;j++){let r=s.p[j],o=e('o'+j);o.hidden=!r;if(r){e('t'+j).textContent=term(r[0]);e('a'+j).textContent=r[1]+' ⭐';o.setAttribute('aria-pressed',String(i===j));o.disabled=!!b}}e('devices').textContent=p?p[2]:'—';e('duration').textContent=p?term(p[0])+' · к оплате':'Выбранный период';e('total').textContent=p?p[1]+' ⭐':'—';e('pay').textContent=p?'Оплатить '+p[1]+' ⭐':'Выберите тариф';e('pay').disabled=!p||b||k===p[4]||!w}
function load(){try{let x=JSON.parse(w.chatData||'{}');if(x.v!==1||!Array.isArray(x.p)||!x.p.length||x.p.length>4||!x.p.every(r=>Array.isArray(r)&&r.length===5&&Number.isSafeInteger(r[0])&&r[0]>0&&Number.isSafeInteger(r[1])&&r[1]>0&&Number.isSafeInteger(r[2])&&r[2]>0&&/^[\w-]{16}$/.test(r[4])))throw 0;s=x;i=Math.min(i,s.p.length-1);draw()}catch{s={p:[]};draw();e('notice').textContent='Откройте карточку в личном чате.'}}
for(let j=0;j<4;j++)e('o'+j).onclick=()=>{if(b||!s.p[j])return;i=j;draw()};e('pay').onclick=()=>{let p=s.p[i];if(!p||b||k===p[4]||!w)return;b=1;k=p[4];draw();e('notice').textContent='Готовим счёт…';w.request('buy:'+k).then(a=>{e('notice').textContent=a&&a.result==='INVOICE_SENT'?'Счёт отправлен в чат.':'Проверьте чат или откройте каталог.'},()=>{e('notice').textContent='Нет ответа. Проверьте сообщения бота.'}).finally(()=>{b=0;draw()})};if(w){w.onEvent('chatDataChanged',load);load();w.ready()}else{draw();e('notice').textContent='Откройте в Telegram.'}})();</script></body></html>`;

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
