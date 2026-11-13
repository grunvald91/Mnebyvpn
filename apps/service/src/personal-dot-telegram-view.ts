/** Restricted Telegram Bot API views for paid per-subscriber DoT.
 * The caller authenticates the Telegram webhook and checks TWO explicit
 * rollout switches before invoking these. No invoices are sent here.
 */
import type {Pool} from 'pg';
import {issueTelegramPersonalDns,rotateTelegramPersonalDns,
  telegramPersonalDnsSummary} from '../../../packages/dns-policy/src/personal-dot-telegram.ts';

type Button={
  text:string;
  callback_data?:string;
  copy_text?:{text:string};
};
export type PersonalDnsBotMessage={
  text:string;
  reply_markup:{inline_keyboard:Button[][]};
};
const home:Button={text:'🏠 Главное',callback_data:'nav:home'};
const menu:Button={text:'🧭 Мой DNS',callback_data:'nav:dns'};
const message=(text:string,actions:Button[][]):PersonalDnsBotMessage=>({
  text,reply_markup:{inline_keyboard:[...actions,[home]]},
});
const fmt=(value:string):string=>BigInt(value).toLocaleString('ru-RU');

export async function personalDnsTelegramMenu(
  db:Pool,telegramUserId:number,
):Promise<PersonalDnsBotMessage>{
  const status=await telegramPersonalDnsSummary(db,telegramUserId);
  if(!status)return message('🧭 Мой DNS\n\nПерсональной подписки пока нет. Тариф — 200 ⭐ на 30 дней. Продажа откроется после проверки публичного DoT.',[]);
  const active=status.state==='ACTIVE'&&status.expiresAt!==null&&
    status.expiresAt.getTime()>Date.now();
  const date=status.expiresAt
    ?status.expiresAt.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}):'—';
  const counters=status.queryUsed!==null&&status.queryRemaining!==null&&status.queryLimit!==null
    ?'\nИспользовано DNS-запросов: '+fmt(status.queryUsed)+
      '\nОсталось: '+fmt(status.queryRemaining)+' из '+fmt(status.queryLimit)
    :'\nУчёт запросов появится после выдачи DNS-адреса.';
  const buttons:Button[][]=[];
  if(active&&!status.credentialIssued)
    buttons.push([{text:'🔑 Получить персональный адрес',callback_data:'dns:issue'}]);
  if(active&&status.credentialIssued&&status.credentialRevision!==null)
    buttons.push([{text:'🔄 Перегенерировать адрес',
      callback_data:'dns:rotate:confirm:'+status.credentialRevision}]);
  buttons.push([{text:'🔁 Обновить',callback_data:'nav:dns'}]);
  return message('🧭 Мой DNS\n\n'+
    (active?'Подписка активна.':'Платные маршруты неактивны. Ранее выданный неотозванный адрес может работать только как обычный DNS.')+
    '\nДействует до: '+date+counters+
    (status.credentialIssued
      ?'\n\nАдрес уже выдавался. В базе сохранён только хэш. Если потеряли адрес, перегенерируйте его.':''),
    buttons);
}
export async function personalDnsTelegramAction(
  db:Pool,telegramUserId:number,action:string,
):Promise<PersonalDnsBotMessage>{
  if(action==='dns:issue'){
    const response=await issueTelegramPersonalDns(db,telegramUserId);
    if(response.kind==='issued')return message(
      '✅ Ваш персональный DNS\n\n'+response.hostname+
      '\n\nAndroid → Настройки → Частный DNS → Имя хоста провайдера. Вставьте адрес целиком и сохраните.\n\nАдрес персональный. Храните его как ключ.',
      [[{text:'📋 Скопировать DNS-адрес',copy_text:{text:response.hostname}}],[menu]]);
    if(response.kind==='already-issued')
      return message('Адрес уже выдавался. Он не хранится в открытом виде. Если потеряли его, откройте «Мой DNS» и перегенерируйте.',[[menu]]);
    if(response.kind==='not-active')
      return message('Подписка ещё не активирована. Выдача DNS-адреса недоступна.',[[menu]]);
    if(response.kind==='revoked')
      return message('Доступ отозван. Обратитесь в поддержку.',[[menu]]);
    return message('Не удалось выдать адрес. Попробуйте позже.',[[menu]]);
  }
  const match=/^dns:rotate:(confirm|execute):([1-9][0-9]{0,12})$/.exec(action);
  if(!match)return message('Неподдерживаемое действие DNS.',[[menu]]);
  const expectedRevision=Number(match[2]);
  if(!Number.isSafeInteger(expectedRevision))
    return message('Некорректная версия DNS-ключа.',[[menu]]);
  const status=await telegramPersonalDnsSummary(db,telegramUserId);
  if(!status||status.credentialRevision!==expectedRevision||
     !status.credentialIssued||status.state!=='ACTIVE'||
     !status.expiresAt||status.expiresAt.getTime()<=Date.now())
    return message('DNS-адрес уже изменён или подписка недоступна.',[[menu]]);
  if(match[1]==='confirm')return message(
    '⚠️ Перегенерация DNS\n\nПосле подтверждения старый адрес сразу перестанет работать. Введите новый адрес в настройках телефона. Срок и квота сохранятся.',
    [[{text:'🔄 Подтвердить замену',callback_data:'dns:rotate:execute:'+expectedRevision}],
     [{text:'Отмена',callback_data:'nav:dns'}]]);
  const response=await rotateTelegramPersonalDns(db,telegramUserId,expectedRevision);
  if(response.kind==='rotated')return message(
    '✅ Новый DNS-адрес\n\n'+response.hostname+
      '\n\nПрежний адрес отключён. Обновите Private DNS в настройках Android.',
    [[{text:'📋 Скопировать новый адрес',copy_text:{text:response.hostname}}],[menu]]);
  return message('Замена не выполнена: адрес уже изменён, отозван или подписка неактивна.',[[menu]]);
}
