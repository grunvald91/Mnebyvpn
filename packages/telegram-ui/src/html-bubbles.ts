/**
 * MNEBYVPN HTMLBubbles markup renderer.
 *
 * Telegram client 13.2 supports interactive HTML widgets. However the exact
 * public Bot API transport for uploading/sending HTMLBubbles has not been
 * independently verified in the documentation available here. Renderers create
 * a SELF-CONTAINED, no-network, no-secret bubble and DO NOT send it to Telegram.
 * Keep current Rich Messages as the working bot fallback.
 */
export interface BubblePackage {
  label: string;
  service: 'vpn' | 'smart_dns';
  active: boolean;
  usedBytes: bigint | null;
  quotaBytes: bigint | null;
  expiresAt: string | null;
}
export interface BubbleModel {
  heading: string;
  packages: ReadonlyArray<BubblePackage>;
}
export function bubbleEscape(text:string):string {
  return text.replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}
function bytes(n:bigint|null):string {
  if(n===null)return 'Без тарифа';
  if(n<0n)throw new Error('Negative traffic');
  const scale=1024n*1024n*1024n;
  return (Number(n*100n/scale)/100).toFixed(2)+' ГБ';
}
function percent(used:bigint|null,limit:bigint|null):number {
  if(used===null||limit===null||limit<=0n)return 0;
  const pct=used*100n/limit;
  return Number(pct>100n?100n:pct);
}
function isoDate(input:string|null):string {
  if(!input)return 'Не указан';
  const parsed=new Date(input);
  if(Number.isNaN(parsed.getTime()))throw new Error('Invalid package expiry');
  return parsed.toISOString().slice(0,10);
}
/**
 * No subscription URLs, personal destination IPs, profile tokens, contacts,
 * payment credentials, cookies, JS network calls or custom Telegram bridge.
 */
export function renderVpnHtmlBubble(model:BubbleModel):string {
  if(model.packages.length>20)throw new Error('Too many package cards');
  const heading=bubbleEscape(model.heading.slice(0,128));
  const cards=model.packages.map((p,i)=>{
    if(p.usedBytes!==null&&p.usedBytes<0n)throw new Error('Negative usage');
    if(p.quotaBytes!==null&&p.quotaBytes<=0n)throw new Error('Invalid quota');
    const title=bubbleEscape(p.label.slice(0,96));
    const quota=p.quotaBytes===null?'Безлимит не заявлен':bytes(p.quotaBytes);
    const usage=p.usedBytes===null?'Учёт не подключён':bytes(p.usedBytes);
    const remaining=p.quotaBytes!==null&&p.usedBytes!==null
      ? bytes(p.usedBytes>=p.quotaBytes?0n:p.quotaBytes-p.usedBytes)
      : 'Пока недоступен';
    const status=p.active?'Активен':'Не активен';
    return '<article class="pkg" data-card="'+i+'"><div class="head"><div><small>'+
      (p.service==='vpn'?'VPN':'MNEBYDNS')+'</small><h3>'+title+
      '</h3></div><span class="state">'+status+'</span></div>'+
      '<div class="metric"><span>Осталось</span><strong>'+remaining+'</strong></div>'+
      '<div class="track" role="progressbar" aria-label="Использованный трафик" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+percent(p.usedBytes,p.quotaBytes)+'"><i style="width:'+percent(p.usedBytes,p.quotaBytes)+'%"></i></div>'+
      '<div class="details"><span>Потрачено: '+usage+'</span><span>Пакет: '+quota+'</span>'+
      '<span>До: '+isoDate(p.expiresAt)+'</span></div></article>';
  }).join('');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'+
  '<meta name="color-scheme" content="dark light"><title>'+heading+'</title><style>'+
  ':root{font-family:system-ui,-apple-system,sans-serif;color:#f0f5ff;background:#071422;font-size:14px}'+
  '*{box-sizing:border-box}body{margin:0;padding:16px}header{display:flex;gap:10px;align-items:center;margin-bottom:14px}'+
  '.logo{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,#31cfca,#3568fd);display:grid;place-items:center;font-size:23px;font-weight:800}'+
  'h1{font-size:18px;line-height:1.2;margin:0}small{font-size:10px;color:#8babd4;letter-spacing:.08em}'+
  '.muted{color:#90a8c1;font-size:12px;margin:4px 0}button{border:1px solid #3a5275;background:#122844;color:#fff;border-radius:12px;padding:9px 12px;font:inherit;cursor:pointer}button[aria-selected=true]{background:#2766bc;border-color:#429fda}'+
  '.tabs{display:flex;gap:8px;margin-bottom:12px}.pkg{background:linear-gradient(145deg,#153254,#0b1d34);border:1px solid #294665;border-radius:18px;padding:16px;margin:8px 0;box-shadow:0 10px 25px #0002}'+
  '.head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.head h3{font-size:16px;margin:5px 0 14px}.state{font-size:11px;color:#5ce5b1;white-space:nowrap}.metric{display:flex;flex-direction:column;gap:4px;margin:4px 0 12px}.metric span{color:#90a8c1}.metric strong{font-size:27px}'+
  '.track{width:100%;height:6px;background:#203953;border-radius:12px;overflow:hidden}.track i{display:block;height:100%;background:linear-gradient(90deg,#28c5c9,#6f8cff);border-radius:12px}'+
  '.details{display:grid;gap:5px;margin-top:12px;color:#acc2d7;font-size:12px}footer{color:#839dbb;font-size:11px;margin-top:14px}'+
  '</style></head><body><header><div class="logo" aria-hidden="true">M</div><div><h1>'+
  heading+'</h1><p class="muted">Подписки и трафик</p></div></header>'+
  '<nav class="tabs" aria-label="Разделы"><button type="button" aria-selected="true" data-tab="packages">Мои пакеты</button>'+
  '<button type="button" aria-selected="false" data-tab="about">Информация</button></nav>'+
  '<main id="packages">'+(cards||'<p class="muted">Пакетов пока нет.</p>')+'</main>'+
  '<section id="about" hidden><p>Один пакет можно использовать на нескольких устройствах. Трафик расходуется из общей квоты пакета.</p>'+
  '<p>Оплата и выдача доступа выполняются ботом после проверки платежа.</p></section>'+
  '<footer>Состояние — снимок на момент отправки. Для актуальных данных обновите карточку через бота.</footer>'+
  '<script>(function(){var tabs=document.querySelectorAll("[data-tab]");tabs.forEach(function(b){b.addEventListener("click",function(){tabs.forEach(function(t){t.setAttribute("aria-selected",String(t===b));});document.getElementById("packages").hidden=b.dataset.tab!=="packages";document.getElementById("about").hidden=b.dataset.tab!=="about";});});})();</script>'+
  '</body></html>';
}
