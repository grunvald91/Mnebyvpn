/** Owner-only link management. Authorization is checked again for every call.
 * Stored bearers use authenticated encryption; logs must never contain them.
 */
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {makePersonalDoTIdentity,parsePersonalDoTHostname} from '../../../packages/dns-policy/src/personal-dot-identity.ts';

type Button={text:string;callback_data?:string;copy_text?:{text:string}};
type Page={text:string;reply_markup:{inline_keyboard:Button[][]}};
type Db=Pick<Pool,'query'>;
type Link={id:string;owner_telegram_id:string;token_ciphertext:string;permanent:boolean;expires_at:Date|null;revoked_at:Date|null};
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const back:Button={text:'↩️ Мои DNS-ссылки',callback_data:'dnslinks:menu'};
const page=(text:string,buttons:Button[][]=[[back]]):Page=>({text,reply_markup:{inline_keyboard:buttons}});
export const OWNER_DNS_EXPIRY_PROMPT='🔐 MNEBYDNS • срок ссылки';
export const ownerDnsKey=(value:string|undefined):Buffer|null=>value&&/^[a-f0-9]{64}$/.test(value)?Buffer.from(value,'hex'):null;
export function encryptOwnerDnsLabel(label:string,id:string,ownerId:number,key:Buffer):string{
  if(!parsePersonalDoTHostname(label+'.dns.mnebyvpn.site')||key.length!==32)throw Error('Invalid DNS encryption input');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('owner-dns:v1:'+id+':'+ownerId));
  const encrypted=Buffer.concat([cipher.update(label,'ascii'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function decryptOwnerDnsLabel(value:string,id:string,ownerId:number,key:Buffer):string{
  const raw=Buffer.from(value,'base64url');
  if(raw.length!==40||key.length!==32)throw Error('Invalid encrypted DNS link');
  const cipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
  cipher.setAAD(Buffer.from('owner-dns:v1:'+id+':'+ownerId));
  cipher.setAuthTag(raw.subarray(12,28));
  const label=Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('ascii');
  if(!parsePersonalDoTHostname(label+'.dns.mnebyvpn.site'))throw Error('Invalid decrypted DNS link');
  return label;
}
export function ownerDnsDuration(value:string):number|null{
  const m=/^([1-9][0-9]{0,4})\s*(ч|час|часа|часов|h|д|день|дня|дней|d)?$/i.exec(value.trim());
  if(!m)return null;
  const seconds=Number(m[1])*(m[2]&&/^(ч|час|часа|часов|h)$/i.test(m[2])?3600:86400);
  return seconds<=315360000?seconds:null;
}
function expiry(row:Link):string{
  if(row.revoked_at)return 'Отозвана';
  if(row.permanent)return 'Бессрочно';
  return (new Date(row.expires_at!).getTime()<=Date.now()?'Истекла: ':'До ')+
    new Date(row.expires_at!).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК';
}
export function ownerDnsMenu():Page{
  return page('🔐 Персональные Smart DNS ссылки\n\nТолько владелец может получать и создавать ссылки, менять срок и отзывать их. Любой, кому вы передадите адрес, сможет использовать его до окончания срока.\n\nПостоянная ссылка сохраняется при повторном получении. Сроки временных ссылок отсчитываются от создания.',[
    [{text:'♾ Моя постоянная ссылка',callback_data:'dnslinks:permanent'}],
    [{text:'➕ На 1 час',callback_data:'dnslinks:new:1h'},{text:'На 24 часа',callback_data:'dnslinks:new:1d'}],
    [{text:'➕ На 7 дней',callback_data:'dnslinks:new:7d'},{text:'На 30 дней',callback_data:'dnslinks:new:30d'}],
    [{text:'✏️ Свой срок',callback_data:'dnslinks:custom:new'}],
    [{text:'📋 Выданные ссылки',callback_data:'dnslinks:list:0'}],
    [{text:'↩️ Управление Smart DNS',callback_data:'dnsadmin:menu'}],
  ]);
}
function card(row:Link,ownerId:number,key:Buffer):Page{
  const active=!row.revoked_at&&(row.permanent||new Date(row.expires_at!).getTime()>Date.now());
  const hostname=active?decryptOwnerDnsLabel(row.token_ciphertext,row.id,ownerId,key)+'.dns.mnebyvpn.site':null;
  const buttons:Button[][]=[];
  if(hostname)buttons.push([{text:'📋 Скопировать адрес',copy_text:{text:hostname}}]);
  if(!row.permanent&&!row.revoked_at){
    buttons.push([{text:'✏️ Изменить срок',callback_data:'dnslinks:custom:'+row.id}]);
    buttons.push([{text:'🚫 Отозвать',callback_data:'dnslinks:revoke:'+row.id}]);
  }
  buttons.push([back]);
  return page('🔐 Персональный Smart DNS\n\n'+expiry(row)+(hostname?'\n\n'+hostname+
    '\n\nAndroid: Настройки → Частный DNS → Имя хоста провайдера. Вставьте только адрес выше. Не передавайте постоянную ссылку посторонним.':'')+
    (row.permanent?'\n\nБез срока действия и без лимита запросов; защита от частых запросов сохраняется.':''),buttons);
}
export async function ownerDnsLinksAction(
  db:Db|null,ownerId:number|null,actorId:number,key:Buffer|null,action:string,requestId:string,
):Promise<Page>{
  if(ownerId===null||!Number.isSafeInteger(ownerId)||ownerId<=0||actorId!==ownerId)
    return page('Доступ закрыт.',[]);
  if(!db||!key)return page('Управление ссылками пока недоступно.');
  try{
    if(action==='dnslinks:menu')return ownerDnsMenu();
    const list=/^dnslinks:list:(0|[1-9][0-9]{0,3})$/.exec(action);
    if(list){
      const offset=Number(list[1]);
      const {rows}=await db.query('SELECT id,permanent,expires_at,revoked_at FROM owner_dns_links WHERE owner_telegram_id=$1 ORDER BY created_at DESC,id LIMIT 11 OFFSET $2',[String(ownerId),offset]);
      const buttons:Button[][]=rows.slice(0,10).map((r:any)=>[{text:(r.permanent?'♾ ':'🔗 ')+expiry(r),callback_data:'dnslinks:show:'+r.id}]);
      if(offset)buttons.push([{text:'← Назад',callback_data:'dnslinks:list:'+Math.max(0,offset-10)}]);
      if(rows.length>10)buttons.push([{text:'Ещё →',callback_data:'dnslinks:list:'+(offset+10)}]);
      buttons.push([back]);
      return page('📋 Выданные персональные ссылки'+(!rows.length?'\n\nСсылок пока нет.':''),buttons);
    }
    const show=new RegExp('^dnslinks:show:('+UUID+')$').exec(action);
    if(show){
      const {rows}=await db.query('SELECT * FROM owner_dns_links WHERE owner_telegram_id=$1 AND id=$2',[String(ownerId),show[1]]);
      return rows.length?card(rows[0],ownerId,key):page('Ссылка не найдена.');
    }
    const revoke=new RegExp('^dnslinks:(revoke|yes-revoke):('+UUID+')$').exec(action);
    if(revoke){
      if(revoke[1]==='revoke')return page('Отозвать эту ссылку? Новые DNS-запросы будут отклонены.',[
        [{text:'Да, отозвать',callback_data:'dnslinks:yes-revoke:'+revoke[2]}],[back]]);
      const r=await db.query('UPDATE owner_dns_links SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_telegram_id=$1 AND id=$2 AND NOT permanent RETURNING id',[String(ownerId),revoke[2]]);
      return page(r.rows.length?'Ссылка отозвана.':'Ссылка не найдена или является постоянной.');
    }
    const duration=/^dnslinks:new:(1h|1d|7d|30d|s[0-9]+)$/.exec(action);
    if(action==='dnslinks:permanent'||duration){
      const permanent=action==='dnslinks:permanent';
      const seconds=permanent?null:({'1h':3600,'1d':86400,'7d':604800,'30d':2592000}[duration![1]]??Number(duration![1].slice(1)));
      if(!permanent&&(!Number.isSafeInteger(seconds)||Number(seconds)<3600||Number(seconds)>315360000))return page('Неверный срок.');
      if(!/^[A-Za-z0-9:_-]{1,80}$/.test(requestId))return page('Неверный запрос.');
      const id=randomUUID(),identity=makePersonalDoTIdentity();
      const requestKey=permanent?'permanent':'new:'+requestId;
      await db.query(`INSERT INTO owner_dns_links(id,owner_telegram_id,token_sha256,token_ciphertext,request_key,permanent,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 THEN NULL ELSE clock_timestamp()+$7::bigint*interval '1 second' END)
        ON CONFLICT(owner_telegram_id,request_key) DO NOTHING`,
        [id,String(ownerId),identity.tokenSha256,encryptOwnerDnsLabel(identity.label,id,ownerId,key),requestKey,permanent,seconds]);
      const {rows}=await db.query('SELECT * FROM owner_dns_links WHERE owner_telegram_id=$1 AND request_key=$2',[String(ownerId),requestKey]);
      return rows.length?card(rows[0],ownerId,key):page('Ссылка не создана.');
    }
    const change=new RegExp('^dnslinks:expire:('+UUID+'):([0-9]+)$').exec(action);
    if(change){
      const seconds=Number(change[2]);
      if(!Number.isSafeInteger(seconds)||seconds<3600||seconds>315360000)return page('Неверный срок.');
      if(!/^[A-Za-z0-9:_-]{1,80}$/.test(requestId))return page('Неверный запрос.');
      // A replayed Telegram update never extends access for a second time,
      // including a late replay after a more recent change.
      await db.query(`WITH accepted AS (
        INSERT INTO owner_dns_link_edits(owner_telegram_id,request_key,link_id)
        SELECT owner_telegram_id,$4,id FROM owner_dns_links
          WHERE owner_telegram_id=$1 AND id=$2 AND NOT permanent AND revoked_at IS NULL
        ON CONFLICT(owner_telegram_id,request_key) DO NOTHING RETURNING changed_at
      ) UPDATE owner_dns_links SET expires_at=(SELECT changed_at FROM accepted)+$3::bigint*interval '1 second'
        WHERE owner_telegram_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM accepted)`,[String(ownerId),change[1],seconds,requestId]);
      const {rows}=await db.query('SELECT * FROM owner_dns_links WHERE owner_telegram_id=$1 AND id=$2 AND NOT permanent AND revoked_at IS NULL',[String(ownerId),change[1]]);
      return rows.length?card(rows[0],ownerId,key):page('Срок не изменён: ссылка отозвана или постоянная.');
    }
    return page('Неизвестное действие.');
  }catch{return page('Не удалось выполнить действие. Существующие ссылки сохранены.');}
}
export function ownerDnsExpiryPrompt(action:string):{text:string;reply_markup:{force_reply:true;selective:true}}|null{
  const m=new RegExp('^dnslinks:custom:(new|'+UUID+')$').exec(action);
  if(!m)return null;
  return {text:OWNER_DNS_EXPIRY_PROMPT+'\n['+m[1]+']\n\nВведите срок: «12 ч», «7 д» или «30» (дней). От 1 часа до 3650 дней. Новый срок начинается сейчас.',reply_markup:{force_reply:true,selective:true}};
}
export function ownerDnsExpiryReply(prompt:string,value:string):string|null{
  const target=new RegExp('^'+OWNER_DNS_EXPIRY_PROMPT+'\\n\\[(new|'+UUID+')\\]\\n').exec(prompt)?.[1];
  const seconds=ownerDnsDuration(value);
  if(!target||seconds===null)return null;
  return target==='new'?'dnslinks:new:s'+seconds:'dnslinks:expire:'+target+':'+seconds;
}
