/** Bot API keyboard navigation: no user-typed slash commands required. */
export const MENU = {
  catalog:'🌐 Выбрать доступ',
  mine:'🔐 Мои подписки',
  share:'🎁 Поделиться',
  trial:'🆓 Пробный день',
  help:'💬 Помощь',
  home:'🏠 Главное',
} as const;
export const menuReplyKeyboard = {
  keyboard:[
    [{text:MENU.catalog},{text:MENU.mine}],
    [{text:MENU.share},{text:MENU.trial}],
    [{text:MENU.help}],
  ],
  resize_keyboard:true,
  is_persistent:true,
  one_time_keyboard:false,
  input_field_placeholder:'Выберите нужную функцию',
};
export const menuInlineKeyboard = {
  inline_keyboard:[
    [{text:'🌐 VPN',callback_data:'nav:plans:vpn'},
     {text:'🧭 Smart DNS',callback_data:'nav:plans:smart_dns'}],
    [{text:'🔐 Мои подписки',callback_data:'nav:status'}],
    [{text:'🎁 Поделиться',callback_data:'nav:share'},
     {text:'🆓 1 день бесплатно',callback_data:'nav:trial'}],
    [{text:'💬 Помощь',callback_data:'nav:help'}],
  ],
};
export function formatDuration(seconds:number):string {
  if(!Number.isSafeInteger(seconds)||seconds<=0)throw new Error('Invalid duration');
  if(seconds%86400===0) {
    const d=seconds/86400;
    if(d===1)return '1 день';
    if(d===15)return '15 дней';
    if(d===30)return '30 дней';
    if(d===60)return '60 дней (~2 мес.)';
    if(d===90)return '90 дней (~3 мес.)';
    return d+' дней';
  }
  const h=seconds/3600;
  return Number.isInteger(h)?h+' ч.':seconds+' сек.';
}
export function formatRoubles(minor:number|null):string {
  if(minor===null)return '—';
  if(!Number.isSafeInteger(minor)||minor<=0)throw new Error('Invalid price');
  return String(Math.floor(minor/100))+','+String(minor%100).padStart(2,'0')+' ₽';
}
export function shortCatalogRow(title:string,seconds:number,stars:number,minor:number|null):string {
  if(!Number.isSafeInteger(stars)||stars<=0)throw new Error('Invalid stars');
  return title+' · '+formatDuration(seconds)+' · '+stars+' ⭐ / '+formatRoubles(minor);
}
