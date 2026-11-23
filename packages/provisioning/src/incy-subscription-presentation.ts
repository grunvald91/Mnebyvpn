/** INCY presentation of the existing, verified RU188 VPN subscription.
 *
 * Do not change billing, server credentials, core transport endpoints or
 * already signed AWG peers. Reality remains installed server-side, but is no
 * longer advertised to customers until independently proven functional.
 */
export const VPN_BRAND='MNEBYVPN';
export const INCY_SITE_URL='https://mnebyvpn.site';
export const INCY_RENEW_URL='https://mnebyvpn.site/#plans';
export const INCY_BOT_URL='https://t.me/MNEBYVPN_bot';
export const INCY_SUPPORT_URL='https://t.me/MNEBYVPN_bot?start=support';

/** Customer-facing country label; transport remains in connection fields. */
export function vpnCountryLabel(countryNameRu:string):string{
  return VPN_BRAND+' '+countryNameRu;
}

/** The upstream bridge is validated separately (including its WS auth).
 * Only the canonical verified German WebSocket URI is returned. */
export function germanWebSocketOnly(validatedNodeProfile:string):string{
  const links=validatedNodeProfile.split('\n');
  const ws=links.filter(link=>{
    try{
      const uri=new URL(link);
      return uri.protocol==='vless:' && uri.hostname==='cdn.servgo.ru' &&
        uri.port==='8443' && uri.searchParams.get('type')==='ws' &&
        uri.searchParams.get('security')==='tls';
    }catch{return false;}
  });
  if(ws.length!==1)throw Error('Expected one verified German WS transport');
  const uri=new URL(ws[0]!);
  uri.hash=encodeURIComponent(vpnCountryLabel('Германия'));
  return uri.toString();
}

/** Signed additional country entries are rendered by the verified registry.
 * Germany REALITY routes are currently nonfunctional and must not be offered
 * to INCY, even if an old signed registry receipt exists for a DE node.
 * Other independently verified countries are unaffected.
 */
export function keepSupportedAdditionalTransport(link:string):boolean{
  const uri=new URL(link);
  const label=decodeURIComponent(uri.hash.slice(1));
  return !(uri.protocol==='vless:' &&
    uri.searchParams.get('security')==='reality' &&
    (label===vpnCountryLabel('Германия') ||
     label==='мне VPN Германия' || // Legacy label must remain blocked.
     label.startsWith('🇩🇪 MNEBYVPN')));
}

/** INCY expects a Unix expiration timestamp in SECONDS, not a count of days
 * and not the lifetime of the reusable HTTPS bearer URL. No fabricated
 * traffic totals or free trial expiry: always use authoritative entitlement.
 */
export function incySubscriptionHeaders(expiresAt:Date,client:string|null=null):Record<string,string>{
  if(!(expiresAt instanceof Date)||!Number.isFinite(expiresAt.getTime()))
    throw Error('Invalid VPN entitlement expiry');
  const expire=Math.floor(expiresAt.getTime()/1000);
  if(!Number.isSafeInteger(expire)||expire<=0)
    throw Error('Unrepresentable INCY expiry');
  return {
    'subscription-userinfo':'upload=0;download=0;total=0;expire='+expire,
    'profile-title':'base64:'+Buffer.from(VPN_BRAND,'utf8').toString('base64'),
    'profile-update-interval':'1',
    'profile-web-page-url':client==='karing'?INCY_SITE_URL:INCY_RENEW_URL,
    // Legacy INCY-compatible alias; use the same public provider website.
    'homepage':client==='karing'?INCY_SITE_URL:INCY_RENEW_URL,
    // A visible description remains useful if the client's button layout hides
    // either provider URL. The paid checkout itself still verifies entitlement.
    'profile-description':'base64:'+Buffer.from(
      'Оплата и продление: mnebyvpn.site','utf8').toString('base64'),
    // Desktop INCY may ignore profile-web-page-url even though documented.
    // Retain the visible support-url button as a website fallback, instead
    // of silently removing the customer's only payment action. Its built-in
    // label is client-controlled and cannot be renamed by subscription data.
    // Karing keeps its original Telegram support action unchanged.
    'support-url':client==='karing'?INCY_SUPPORT_URL:INCY_RENEW_URL,
    // Keep the separate Premium action pointed at the tariffs page.
    'premium-url':INCY_RENEW_URL,
    // INCY's existing "Канал / Бот" action is driven by announce-url.
    // It opens the Telegram bot. Website metadata is also provided, but a
    // visible website action is not guaranteed in every INCY build.
    ...(client==='karing'?{}:{
      'announce':'base64:'+Buffer.from(
        'Связаться с поддержкой в Telegram: @MNEBYVPN_bot','utf8').toString('base64'),
      'announce-url':INCY_SUPPORT_URL,
    }),
  };
}

/** Provider navigation after natural expiration. No network connection lines
 * may be present: no valid VPN entitlement or node ACK is implied by HTTP 200.
 * The site may be reached even when a subscription's servers have expired.
 */
export function incyExpiredSubscriptionHeaders(
  expiresAt:Date,client:string|null=null,
):Record<string,string>{
  const karing=client==='karing';
  return {
    ...incySubscriptionHeaders(expiresAt,client),
    'announce':'base64:'+Buffer.from(
      karing?'Срок VPN истёк. Продлите доступ на mnebyvpn.site':
        'Срок VPN истёк. Продление: mnebyvpn.site/#plans; бот: @MNEBYVPN_bot','utf8').toString('base64'),
    // Preserve Karing's historical expired-subscription link. INCY's
    // Channel / Bot action opens Telegram; the website is a separate action.
    'announce-url':karing?INCY_RENEW_URL:INCY_SUPPORT_URL,
  };
}

/** INCY recognizes these # comments in base64 text subscriptions as fallback
 * navigation metadata. Crucially NO VPN keys or server URIs are returned.
 */
export function incyExpiredSubscriptionBody(client:string|null=null):string{
  const karing=client==='karing';
  return Buffer.from([
    '#profile-title: '+VPN_BRAND,
    '#profile-web-page-url: '+(karing?INCY_SITE_URL:INCY_RENEW_URL),
    '#support-url: '+(karing?INCY_SUPPORT_URL:INCY_RENEW_URL),
    '#profile-update-interval: 1',
    '#announce: base64:'+Buffer.from(
      karing?'Срок VPN истёк. Продлите доступ на mnebyvpn.site':
        'Срок VPN истёк. Продление: mnebyvpn.site/#plans; бот: @MNEBYVPN_bot','utf8').toString('base64'),
    '#announce-url: '+(karing?INCY_RENEW_URL:INCY_SUPPORT_URL),
  ].join('\n')+'\n','utf8').toString('base64')+'\n';
}

/** INCY documents #profile-web-page-url/#support-url/#announce as body
 * fallbacks when HTTP headers are removed by a gateway or ignored by a
 * particular importer. Keep the exact server-verified connection lines.
 * Karing continues receiving its historical, comment-free base64 payload.
 * Neither provider metadata nor announcements confer VPN access.
 */
export function incyEncodeActiveSubscription(
  verifiedProfile:string,client:string|null,
):string{
  if(!verifiedProfile||verifiedProfile.split('\n').some(line=>!line||line.startsWith('#')))
    throw Error('Invalid verified VPN profile lines');
  const lines=client==='karing'?[]:[
    '#profile-title: '+VPN_BRAND,
    '#profile-web-page-url: '+INCY_RENEW_URL,
    // Visible website fallback for Desktop variants that ignore site metadata.
    '#support-url: '+INCY_RENEW_URL,
    '#profile-update-interval: 1',
    '#announce: base64:'+Buffer.from(
      'Связаться с поддержкой в Telegram: @MNEBYVPN_bot','utf8').toString('base64'),
    '#announce-url: '+INCY_SUPPORT_URL,
  ];
  return Buffer.from([...lines,verifiedProfile].join('\n')+'\n','utf8')
    .toString('base64')+'\n';
}
