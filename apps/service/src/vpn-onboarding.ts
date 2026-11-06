/**
 * Telegram-first VPN onboarding after node-acknowledged entitlement activation.
 * Official downloads and verified deep-link formats. All user actions stay in
 * Telegram; the tiny HTTPS import bridge exists only because the Bot API's
 * inline URL buttons cannot carry incy:// or karing:// schemes directly.
 */
import {setTimeout as sleep} from 'node:timers/promises';
import type {Pool} from 'pg';
import {PgBillingStore} from '../../../packages/billing/src/store.ts';
import {issueSubscriptionLink,installerLink}
  from '../../../packages/provisioning/src/subscription-links.ts';

export type Button={text:string;callback_data?:string;url?:string;copy_text?:{text:string}};
export type BotMessage={text:string;reply_markup:{inline_keyboard:Button[][]}};
const home:Button={text:'🏠 Главное',callback_data:'nav:home'};
const route=(data:string):Button=>({text:data,callback_data:'nav:connect'});
const build=(text:string,buttons:Button[][]):BotMessage=>
  ({text,reply_markup:{inline_keyboard:buttons}});
export type Platform='android'|'ios'|'windows'|'macos'|'linux';
const downloads:Record<Platform,{
  name:string;app:string;client:'incy'|'karing';primary:string;
  alternate?:string;alternateText?:string;
}>={
  android:{name:'Android',app:'INCY',client:'incy',
    primary:'https://play.google.com/store/apps/details?id=llc.itdev.incy',
    alternate:'https://github.com/INCY-DEV/incy-platforms/releases/download/latest/Incy.apk',
    alternateText:'📦 INCY APK с GitHub'},
  ios:{name:'iPhone / iPad',app:'Karing',client:'karing',
    primary:'https://apps.apple.com/ru/app/karing/id6472431552'},
  windows:{name:'Windows',app:'INCY',client:'incy',
    primary:'https://github.com/INCY-DEV/incy-platforms/releases/download/latest/incy-windows-setup.exe',
    alternate:'https://github.com/INCY-DEV/incy-platforms/releases',
    alternateText:'📦 Другие версии (официальный GitHub)'},
  macos:{name:'macOS',app:'INCY',client:'incy',
    // Both Intel and Apple Silicon have different signed packages.
    primary:'https://github.com/INCY-DEV/incy-platforms/releases',
    alternate:'https://apps.apple.com/ru/app/karing/id6472431552',
    alternateText:'🍏 Karing в App Store (альтернатива)'},
  linux:{name:'Linux',app:'INCY',client:'incy',
    primary:'https://github.com/INCY-DEV/incy-platforms/releases'},
};
export function deviceOptions():Button[][] {
  return [
    [{text:'🤖 Android · INCY',callback_data:'nav:device:android'},
     {text:'🍏 iPhone · Karing',callback_data:'nav:device:ios'}],
    [{text:'🖥 Windows · INCY',callback_data:'nav:device:windows'},
     {text:'💻 macOS · INCY',callback_data:'nav:device:macos'}],
    [{text:'🐧 Linux · INCY',callback_data:'nav:device:linux'}],
    [{text:'📋 Ручное добавление',callback_data:'nav:manual'}],
    [{text:'🔐 Мои подключения',callback_data:'nav:status'}],[home],
  ];
}
function pending():BotMessage {
  return build('⏳ Бесплатные сутки VPN\n\nЗапрос получен. '+
    'Подключение ещё подтверждается сервером. '+
    '24 часа начнутся только после реальной активации VPN.\n\n'+
    'Нажмите «Проверить активацию».',
    [[{text:'🔁 Проверить активацию',callback_data:'nav:connect'}],
     [{text:'🔐 Мои подключения',callback_data:'nav:status'}],[home]]);
}
export async function activationView(pool:Pool,userId:number,
  confirmedOnly=false):Promise<BotMessage|null>{
  const active=await new PgBillingStore(pool).confirmedVpnProfile(userId);
  if(!active)return confirmedOnly?null:pending();
  return build('✅ VPN активирован!\n\n'+
    'Подписка подтверждена VPN-сервером и действует до '+
    active.expiresAt.toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+
    ' (МСК).\n\nВыберите своё устройство. Далее получите ссылку на '+
    'официальное приложение и добавление подписки.',
    deviceOptions());
}
export async function awaitActivation(pool:Pool,userId:number):
  Promise<BotMessage|null>{
  // The node worker scans every five seconds. Keep Telegram's webhook
  // response synchronous and bound the wait to ten seconds.
  for(let i=0;i<5;i++){
    const found=await activationView(pool,userId,true);
    if(found)return found;
    if(i<4)await sleep(2000);
  }
  return null;
}
export async function deviceView(pool:Pool,userId:number,name:string):
  Promise<BotMessage>{
  if(!Object.hasOwn(downloads,name))
    return (await activationView(pool,userId))!;
  const info=downloads[name as Platform];
  const issued=await issueSubscriptionLink(pool,userId);
  if(!issued)return (await activationView(pool,userId))!;
  const buttons:Button[][]=[
    [{text:'⬇️ Установить '+info.app,url:info.primary}],
    ...(info.alternate?[[{text:info.alternateText!,url:info.alternate}]]:[]),
    [{text:'⚡ Добавить подписку автоматически',
      url:installerLink(issued.token,info.client)}],
    [{text:'📋 Копировать ссылку',copy_text:{text:issued.link}}],
    [{text:'🛠 Ручная настройка',callback_data:'nav:manual'}],
    [{text:'↩️ Другое устройство',callback_data:'nav:connect'}],[home],
  ];
  return build('✅ VPN активирован · '+info.name+'\n\n'+
    '1. Скачайте и установите '+info.app+'.\n'+
    '2. Нажмите «Добавить подписку автоматически». '+
    'На открывшейся странице нажмите «Открыть в приложении» и подтвердите импорт.\n'+
    '3. Выберите «Мне бы VPN» и включите VPN.\n\n'+
    'Если приложение не открылось, скопируйте ссылку подписки и вставьте '+
    'её через «Добавить подписку / Импорт из URL».\n\n'+
    '🔐 Персональную ссылку никому не пересылайте.',
    buttons);
}
export async function manualView(pool:Pool,userId:number):Promise<BotMessage>{
  const issued=await issueSubscriptionLink(pool,userId);
  if(!issued)return (await activationView(pool,userId))!;
  return build('🛠 Ручная настройка подписки\n\n'+
    '1. Откройте VPN-приложение.\n'+
    '2. Нажмите «+» → «Добавить подписку / Импорт из URL».\n'+
    '3. Вставьте ссылку ниже и сохраните.\n'+
    '4. Выберите созданный профиль и включите VPN.\n\n'+
    issued.link+'\n\n'+
    'Это обновляемая HTTPS-подписка, а не отдельный серверный ключ. '+
    'Она перестанет выдавать профиль после окончания срока доступа. '+
    'Не публикуйте и не пересылайте ссылку.',
    [[{text:'📋 Скопировать HTTPS-ссылку',copy_text:{text:issued.link}}],
     [{text:'📱 Выбрать устройство',callback_data:'nav:connect'}],[home]]);
}
