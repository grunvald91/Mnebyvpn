/** Main Telegram catalogue rendered as one HTML widget instead of 10 inline keys.
 * Mirrors the legacy menu; that menu remains accessible behind ONE fallback.
 */
import {deflateSync} from 'node:zlib';
import {vpnPurchaseWidgetHtml} from './purchase-widget.ts';

const HOME=String.raw`<!doctype html><html lang="ru"><style>
:root{--art:url('__BRAND__');font-family:system-ui,sans-serif;color:#f4f8ff;background:#080d27}
*{box-sizing:border-box}
body{margin:0;padding:12px 12px 16px;color:#f4f8ff;background:radial-gradient(circle at 89% 5%,#5b36a966,transparent 33%),linear-gradient(150deg,#081328,#101d4c 69%,#171036)}
header{display:flex;gap:10px;align-items:center;margin-bottom:12px}
.avatar{width:40px;height:40px;flex:none;border-radius:50%;background:var(--art) center/cover;box-shadow:0 0 16px #3eeaff6e}
.name{font-size:17px;font-weight:850}.tag{color:#b9d9f2;font-size:11px}
.hero{display:flex;align-items:center;justify-content:space-between;padding:13px 10px 12px 14px;border:1px solid #74dbff5c;border-radius:20px;background:linear-gradient(110deg,#0d375c,#41246a);height:113px}
.hero .copy{max-width:58%}.hero h2{font-size:19px;line-height:1.1;margin:0 0 7px}.hero h2 span{color:#83f6ff}
.hero p{font-size:10px;line-height:1.4;color:#d5e9ff;margin:0}
.earth{width:91px;height:91px;border-radius:50%;flex:none;background:var(--art) center/cover}
.label{font-size:10px;font-weight:850;letter-spacing:.8px;color:#88e7f8;margin:14px 0 9px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.item{min-width:0;min-height:54px;color:white;padding:10px 8px;border:1px solid #9fbeef6b;border-radius:15px;background:linear-gradient(135deg,#1b567e,#343875 75%,#522e80);text-align:left;font:inherit;font-weight:700;font-size:11px;box-shadow:inset 0 1px #ffffff3a,0 7px 12px #03082650}
.item:first-child{background:linear-gradient(115deg,#0bbbd2,#387dfa 58%,#8e54e8);border-color:#a7faff}
.item:active{filter:brightness(1.25)}.item[disabled]{opacity:.55}.item strong{font-size:16px;font-weight:500;vertical-align:middle;margin-right:4px}
.item.wide{grid-column:span 2;min-height:45px;text-align:center}
#notice{font-size:10px;color:#a6efff;min-height:7px;margin:8px 0 0}
footer{font-size:10px;color:#b5c7e5;margin-top:7px;line-height:1.35}
@media(max-width:240px){.earth{width:57px;height:57px}.hero h2{font-size:16px}.item{font-size:10px;padding:8px 6px}}
</style><body><header><div class="avatar" aria-hidden="true"></div><div><div class="name">Мне бы VPN</div><div class="tag">Ваш доступ · MNEBYVPN</div></div></header>
<section class="hero"><div class="copy"><h2>Интернет<br><span>без стен.</span></h2><p>VPN, пробный доступ, подключение и помощь — в одном месте.</p></div><div class="earth" aria-hidden="true"></div></section>
<div class="label">ВЫБЕРИТЕ ДЕЙСТВИЕ</div><nav class="grid">
<button class="item" data-a="vpn"><strong>🌐</strong> VPN и тарифы</button>
<button class="item" data-a="trial"><strong>🎁</strong> Бесплатные 24 часа</button>
<button class="item" data-a="status"><strong>🔐</strong> Мои подключения</button>
<button class="item" data-a="connect"><strong>🔌</strong> Подключить</button>
<button class="item" data-a="renew"><strong>🔁</strong> Продление</button>
<button class="item" data-a="share"><strong>💙</strong> Поддержать проект</button>
<button class="item" data-a="dns"><strong>🧭</strong> Smart DNS · скоро</button>
<button class="item" data-a="help"><strong>❔</strong> Помощь</button>
<button class="item" data-a="support" id="support"><strong>✉️</strong> Поддержка</button>
<button class="item" data-a="site"><strong>🌍</strong> Сайт · резервный</button>
<button class="item wide" data-a="dnsadmin" id="admin" hidden>🛠 Управление Smart DNS</button>
</nav><div id="notice" aria-live="polite"></div>
<footer>VPN развивается. Smart DNS пока в разработке. Пробные 24 часа начнутся после активации.</footer>
<script>
(()=>{const w=typeof TelegramWidget==='undefined'?null:TelegramWidget,items=document.querySelectorAll('.item'),notice=document.getElementById('notice');let busy=false;
let data={v:1,a:0,o:0};try{data=JSON.parse(w&&w.chatData||'{}')}catch{}
if(data.v!==1){data={v:1,a:0,o:0}}
document.getElementById('admin').hidden=!data.a;
if(data.o){document.getElementById('support').innerText='📥 Входящие заявки'}
for(const el of items)el.onclick=()=>{
if(busy||!w)return;
const key=el.getAttribute('data-a');
if(key==='site'){try{w.openLink('https://mnebyvpn.site')}catch{notice.textContent='Не удалось открыть сайт.'}return}
if(typeof w.request!=='function')return;
busy=true;for(const b of items)b.disabled=true;notice.textContent='Открываю раздел…';
w.request('menu:'+key).then(a=>{notice.textContent=a&&a.result==='OPENED'?'Раздел открыт в чате.':'Не удалось открыть раздел.'},()=>{notice.textContent='Не удалось открыть раздел. Попробуйте ещё раз.'}).finally(()=>{busy=false;for(const b of items)b.disabled=false});
};
if(w)w.ready();else notice.textContent='Откройте меню в Telegram.';
})();
</script></body></html>`;

export function homeWidgetHtml():string{
  const match=/data:image\/webp;base64,[A-Za-z0-9+/=]+/.exec(vpnPurchaseWidgetHtml());
  if(!match)throw Error('Missing authentic MNEBYVPN avatar');
  const html=HOME.replace('__BRAND__',match[0]);
  const raw=Buffer.from(html,'utf8'),packed=deflateSync(raw,{level:9});
  if(raw.length>32768||packed.length>3800)throw Error('Telegram home widget exceeds payload limit: '+raw.length+'/'+packed.length);
  return html;
}
export function homeWidgetPayload(chatId:number,isAdmin:boolean,isOperator:boolean){
  if(!Number.isSafeInteger(chatId)||chatId<=0)throw Error('Invalid chat');
  return {
    method:'sendWidget',chat_id:chatId,html:homeWidgetHtml(),allow_queries:true,
    chat_data:JSON.stringify({v:1,a:isAdmin?1:0,o:isOperator?1:0}),
    caption:'Если новая функция недоступна, используйте кнопку «Обычное меню» ниже.',
    reply_markup:{inline_keyboard:[[{text:'☰ Открыть обычное меню',callback_data:'nav:menu:legacy'}]]},
  };
}
