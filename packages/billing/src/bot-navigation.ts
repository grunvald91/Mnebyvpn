/** Conversational navigation with reply and inline keyboards.
 * All prices and offers come from PostgreSQL; no hardcoded commercial tariffs.
 * /start deep-links are handled separately by the authenticated bot dispatcher.
 */
import {
  MENU,menuReplyKeyboard,menuInlineKeyboard,formatDuration,formatRoubles,
} from '../../telegram-ui/src/menu.ts';
import { referralWidgetPayload } from '../../telegram-ui/src/referral-widget.ts';
import { vpnWidgetPayload,statusWidgetData,planWidgetKey } from '../../telegram-ui/src/widget-104.ts';
import {
  PgBillingStore,pricedPlanForOrder,starsOrderFromDB,type Product,
} from './store.ts';
import { buildStarsInvoice } from './stars.ts';
import type { PricedPlan } from './channels.ts';

export interface BotSend {
  call(method:string,params:Record<string,unknown>):Promise<unknown>;
}
export interface NavConfig {
  starsPayloadSecret:string;
  telegramBotUsername?:string;
}
function categoryLabel(product:string):string {
  return product==='vpn'?'🌐 VPN':product==='smart_dns'?'🧭 Smart DNS':'🔐 VPN + DNS';
}
export async function showHome(id:number,tg:BotSend):Promise<void> {
  await tg.call('sendMessage',{
    chat_id:id,
    text:'🌐 Мне бы VPN\nВыберите нужное действие кнопками ниже.',
    reply_markup:menuReplyKeyboard,
  });
  await tg.call('sendMessage',{
    chat_id:id,text:'Что хотите сделать?',reply_markup:menuInlineKeyboard,
  });
}
export async function showCatalog(id:number,db:PgBillingStore,tg:BotSend):Promise<void> {
  const plans=await db.plans('telegram_stars');
  const products=new Set(plans.map(p=>p.product));
  const buttons:Array<Array<{text:string;callback_data:string}>>=[];
  for(const product of ['vpn','smart_dns','bundle'] as const){
    if(products.has(product))buttons.push([{text:categoryLabel(product),callback_data:'nav:plans:'+product}]);
  }
  const trial=await db.trialProducts();
  if(trial.length)buttons.push([{text:'🎁 1 день бесплатно',callback_data:'nav:trial'}]);
  buttons.push([{text:MENU.home,callback_data:'nav:home'}]);
  await tg.call('sendMessage',{
    chat_id:id,text:buttons.length>1?'Выберите услугу. Срок и стоимость покажу следующим шагом.':
      'Платные тарифы пока не опубликованы.',
    reply_markup:{inline_keyboard:buttons},
  });
}
export async function showProductPlans(
  id:number,product:Product,db:PgBillingStore,tg:BotSend,
):Promise<void> {
  const plans=(await db.plans('telegram_stars')).filter(p=>p.product===product)
    .sort((a,b)=>a.durationSeconds-b.durationSeconds || a.planId.localeCompare(b.planId));
  if(!plans.length){
    await tg.call('sendMessage',{chat_id:id,text:'В этой категории пока нет опубликованных тарифов.',
      reply_markup:{inline_keyboard:[[{text:'↩️ К услугам',callback_data:'nav:catalog'}]]}});
    return;
  }
  const visible=plans.slice(0,16);
  const lines=visible.map(p=>formatDuration(p.durationSeconds)+' — '+
    p.stars+' ⭐ / '+formatRoubles(p.rubMinor));
  const keyboard=visible.map(p=>[{text:formatDuration(p.durationSeconds)+' · '+p.stars+' ⭐',
    callback_data:'buy:'+planWidgetKey(p)}]);
  if((await db.trialProducts()).includes(product))
    keyboard.unshift([{text:'🎁 Попробовать 1 день бесплатно',callback_data:'trial:'+product}]);
  keyboard.push([{text:'↩️ К услугам',callback_data:'nav:catalog'}]);
  await tg.call('sendMessage',{
    chat_id:id,
    text:categoryLabel(product)+'\n\n'+lines.join('\n')+
      (plans.length>visible.length?'\nОстальные варианты доступны в каталоге.':'')+
      '\n\nВыберите срок, чтобы сразу получить счёт Stars.',
    reply_markup:{inline_keyboard:keyboard},
  });
}
export async function showShare(id:number,db:PgBillingStore,tg:BotSend,config:NavConfig):Promise<void> {
  if(!config.telegramBotUsername){
    await tg.call('sendMessage',{chat_id:id,
      text:'Реферальная карточка станет доступна после указания имени бота в настройках.'});
    return;
  }
  const offers=await db.referralOffers(id,12);
  if(!offers.length) {
    await tg.call('sendMessage',{chat_id:id,
      text:'Сначала необходимо опубликовать хотя бы один тариф VPN или DNS.'});
    return;
  }
  await tg.call('sendWidget',{...referralWidgetPayload(id,offers,config.telegramBotUsername)});
  await tg.call('sendMessage',{chat_id:id,
    text:'🎁 Готово! Перешлите карточку другу. Он выберет услугу и срок в самой карточке, а бот откроет счёт.',
    reply_markup:{inline_keyboard:[[{text:MENU.home,callback_data:'nav:home'}]]}});
}
export async function showTrialMenu(id:number,db:PgBillingStore,tg:BotSend):Promise<void> {
  const products=await db.trialProducts();
  if(!products.length){
    await tg.call('sendMessage',{chat_id:id,
      text:'Бесплатный день подготовлен, но пока не включён: сначала нужна проверенная выдача доступа на VPN/DNS-сервере.',
      reply_markup:{inline_keyboard:[[{text:'🌐 Выбрать тариф',callback_data:'nav:catalog'}]]}});
    return;
  }
  await tg.call('sendMessage',{
    chat_id:id,
    text:'🎁 Пробный доступ на 24 часа. Один раз на Telegram-аккаунт.\nВыберите услугу:',
    reply_markup:{inline_keyboard:[
      ...products.map(p=>[{text:categoryLabel(p)+' · 1 день бесплатно',callback_data:'trial:'+p}]),
      [{text:MENU.home,callback_data:'nav:home'}],
    ]},
  });
}
export async function startTrial(
  id:number,product:Product,db:PgBillingStore,tg:BotSend,inviteToken?:string,
):Promise<void> {
  const outcome=await db.grantTrial(id,product,inviteToken);
  const text=outcome.status==='GRANTED'
    ? '🎁 Заявка на пробный доступ принята: '+categoryLabel(product)+
      '. Отсчёт 24 часов начнётся только после подтверждённой активации на узле.'
    : outcome.status==='ALREADY_USED'
      ? 'Пробный день уже использован этим Telegram-аккаунтом. Можно выбрать обычный тариф.'
      : 'Пробный доступ для этой услуги пока не включён.';
  await tg.call('sendMessage',{chat_id:id,text,
    reply_markup:{inline_keyboard:[
      [{text:'🔐 Мои подписки',callback_data:'nav:status'}],
      [{text:'🌐 Выбрать тариф',callback_data:'nav:catalog'}],
    ]}});
}
export async function issueStarsInvoice(
  id:number,key:string,db:PgBillingStore,tg:BotSend,secret:string,requestId:string,
):Promise<'SENT'|'STALE'> {
  const plans=(await db.plans('telegram_stars')).filter(p=>p.stars!==null);
  const candidates=plans.filter(p=>planWidgetKey(p)===key);
  if(candidates.length!==1)return 'STALE';
  const plan=await db.plan(candidates[0].planId);
  if(!plan || plan.stars===null || planWidgetKey(plan)!==key)return 'STALE';
  const order=await db.createTelegramOrder(id,plan.planId,requestId,undefined,key);
  await tg.call('sendInvoice',{
    ...buildStarsInvoice(starsOrderFromDB(order),pricedPlanForOrder(order),secret),
  });
  return 'SENT';
}
export async function navigationCallback(
  id:number,data:string,requestId:string,db:PgBillingStore,tg:BotSend,config:NavConfig,
):Promise<boolean> {
  if(data==='nav:home'){await showHome(id,tg);return true;}
  if(data==='nav:catalog'){await showCatalog(id,db,tg);return true;}
  if(data==='nav:share'){await showShare(id,db,tg,config);return true;}
  if(data==='nav:trial'){await showTrialMenu(id,db,tg);return true;}
  if(data==='nav:status'){
    const state=statusWidgetData(await db.listUserPackages(id));
    await tg.call('sendWidget',{...vpnWidgetPayload(id,state)});return true;
  }
  if(data==='nav:help'){
    await tg.call('sendMessage',{chat_id:id,text:'Поддержка пока не подключена. Возможности: доступ, подписки, пробный день и приглашение.'});
    return true;
  }
  if(/^nav:plans:(vpn|smart_dns|bundle)$/.test(data)){
    const product=data.slice('nav:plans:'.length) as Product;
    await showProductPlans(id,product,db,tg);return true;
  }
  if(/^trial:(vpn|smart_dns|bundle)$/.test(data)){
    await startTrial(id,data.slice(6) as Product,db,tg);return true;
  }
  if(/^buy:[A-Za-z0-9_-]{16}$/.test(data)){
    const state=await issueStarsInvoice(id,data.slice(4),db,tg,config.starsPayloadSecret,
      'tg-callback:'+requestId);
    if(state==='STALE')await tg.call('sendMessage',{
      chat_id:id,text:'Цена или условия тарифа изменились. Откройте обновлённый каталог.',
      reply_markup:{inline_keyboard:[[{text:'Обновить тарифы',callback_data:'nav:catalog'}]]},
    });
    return true;
  }
  return false;
}
export async function navigationText(
  id:number,value:string,db:PgBillingStore,tg:BotSend,config:NavConfig,
):Promise<boolean> {
  const text=value.trim();
  if(text===MENU.home || text==='/start' || text==='/help'){
    await showHome(id,tg);return true;
  }
  if(text===MENU.catalog || text==='/plans'){
    await showCatalog(id,db,tg);return true;
  }
  if(text===MENU.mine || text==='/my' || text==='/status'){
    const state=statusWidgetData(await db.listUserPackages(id));
    await tg.call('sendWidget',{...vpnWidgetPayload(id,state)});return true;
  }
  if(text===MENU.share || text==='/share'){
    await showShare(id,db,tg,config);return true;
  }
  if(text===MENU.trial){await showTrialMenu(id,db,tg);return true;}
  if(text===MENU.help || text==='/support' || text==='/paysupport'){
    await tg.call('sendMessage',{chat_id:id,
      text:'Раздел поддержки будет доступен после настройки контактов оператора.'});return true;
  }
  return false;
}
