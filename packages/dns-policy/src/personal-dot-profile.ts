/** iPhone/iPad encrypted DNS configuration created from a one-time bearer.
 * The hostname is personal; never log it, cache it publicly or commit it.
 */
import {randomUUID} from 'node:crypto';
import {parseRegionalPersonalDnsHostname} from './regional-personal-dot-identity.ts';

export function buildPersonalDnsMobileconfig(hostname:string):string{
  const parsed=parseRegionalPersonalDnsHostname(hostname);
  if(!parsed)throw new Error('Unrecognized personal DoT hostname');
  const finnish=parsed.countryCode==='FI';
  const server=parsed.label+(finnish?'.fi':'.dns')+'.mnebyvpn.site';
  const identifier='site.mnebyvpn.personal-dns'+(finnish?'.fi':'');
  const country=finnish?'Финляндия':'Германия';
  const profileId=randomUUID(),dnsId=randomUUID();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>PayloadType</key><string>Configuration</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '<key>PayloadIdentifier</key><string>'+identifier+'</string>',
    '<key>PayloadUUID</key><string>'+profileId+'</string>',
    '<key>PayloadDisplayName</key><string>Мне бы DNS · '+country+'</string>',
    '<key>PayloadDescription</key><string>Персональный DNS-over-TLS. Для удаления: Настройки → Основные → VPN и управление устройством.</string>',
    '<key>PayloadOrganization</key><string>MNEBYVPN</string>',
    '<key>PayloadRemovalDisallowed</key><false/>',
    '<key>PayloadContent</key><array><dict>',
    '<key>PayloadType</key><string>com.apple.dnsSettings.managed</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '<key>PayloadIdentifier</key><string>'+identifier+'.settings</string>',
    '<key>PayloadUUID</key><string>'+dnsId+'</string>',
    '<key>PayloadDisplayName</key><string>Персональный DNS (DoT)</string>',
    '<key>DNSSettings</key><dict>',
    '<key>DNSProtocol</key><string>TLS</string>',
    '<key>ServerName</key><string>'+server+'</string>',
    '</dict></dict></array>',
    '</dict></plist>',
  ].join('\n')+'\n';
}

/** Do not use a URL-based sendDocument: Telegram only accepts URL PDF/ZIP.
 * Upload a real .mobileconfig via multipart to the user's private chat.
 * Failure is reported to caller; credential and message are not fabricated.
 */
export async function sendPersonalDnsMobileconfig(
  chatId:number,hostname:string,botToken:string|null,
  transport:typeof fetch=fetch,
):Promise<boolean>{
  if(!Number.isSafeInteger(chatId)||chatId<=0)throw Error('Invalid private chat');
  if(!botToken||!/^\d{5,20}:[A-Za-z0-9_-]{25,}$/.test(botToken))return false;
  const xml=buildPersonalDnsMobileconfig(hostname);
  const form=new FormData();
  form.set('chat_id',String(chatId));
  form.set('document',new Blob([xml],{type:'application/x-apple-aspen-config'}),
    'MNEBYDNS-iPhone-iPad.mobileconfig');
  form.set('caption','🔐 Ваш персональный профиль Smart DNS для iPhone/iPad. Не пересылайте файл другим людям. Инструкция — в сообщении бота.');
  try{
    const response=await transport('https://api.telegram.org/bot'+botToken+'/sendDocument',{
      method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(7500),
    });
    if(!response.ok)return false;
    const payload:unknown=await response.json();
    if(!payload||typeof payload!=='object')return false;
    const obj=payload as {ok?:boolean;result?:{chat?:{id?:number}}};
    return obj.ok===true&&obj.result?.chat?.id===chatId;
  }catch{return false;}
}
