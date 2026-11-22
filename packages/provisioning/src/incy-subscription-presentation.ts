/** INCY presentation of the existing, verified RU188 VPN subscription.
 *
 * Do not change billing, server credentials, core transport endpoints or
 * already signed AWG peers. Reality remains installed server-side, but is no
 * longer advertised to customers until independently proven functional.
 */
export const INCY_SITE_URL='https://mnebyvpn.site';
export const INCY_RENEW_URL='https://mnebyvpn.site/#plans';
export const INCY_BOT_URL='https://t.me/MNEBYVPN_bot';
export const INCY_SUPPORT_URL='https://t.me/MNEBYVPN_bot?start=support';

/** Customer-facing country label; transport remains in connection fields. */
export function vpnCountryLabel(countryNameRu:string):string{
  return 'мне VPN '+countryNameRu;
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
     label.startsWith('🇩🇪 MNEBYVPN')));
}

/** INCY expects a Unix expiration timestamp in SECONDS, not a count of days
 * and not the lifetime of the reusable HTTPS bearer URL. No fabricated
 * traffic totals or free trial expiry: always use authoritative entitlement.
 */
export function incySubscriptionHeaders(expiresAt:Date):Record<string,string>{
  if(!(expiresAt instanceof Date)||!Number.isFinite(expiresAt.getTime()))
    throw Error('Invalid VPN entitlement expiry');
  const expire=Math.floor(expiresAt.getTime()/1000);
  if(!Number.isSafeInteger(expire)||expire<=0)
    throw Error('Unrepresentable INCY expiry');
  return {
    'subscription-userinfo':'upload=0;download=0;total=0;expire='+expire,
    'profile-title':'base64:'+Buffer.from('MNEBYVPN','utf8').toString('base64'),
    'profile-update-interval':'1',
    'profile-web-page-url':INCY_SITE_URL,
    // Legacy INCY-compatible alias; use the same public provider website.
    'homepage':INCY_SITE_URL,
    // A visible description remains useful if the client's button layout hides
    // either provider URL. The paid checkout itself still verifies entitlement.
    'profile-description':'base64:'+Buffer.from(
      'Оплата и продление: mnebyvpn.site','utf8').toString('base64'),
    // INCY's standard support button opens the bot with an explicit
    // support deep-link payload; the client does not need Premium API.
    'support-url':INCY_SUPPORT_URL,
    // INCY's optional "Premium" action must lead to the actual website
    // tariffs, not duplicate the Telegram support bot link.
    'premium-url':INCY_RENEW_URL,
    // Non-Premium INCY supports announcements independently of provider
    // banner-* fields. This is a second navigable route to renew access.
    'announce':'base64:'+Buffer.from(
      'Оплата и продление VPN: mnebyvpn.site','utf8').toString('base64'),
    'announce-url':INCY_RENEW_URL,
  };
}

/** Provider navigation after natural expiration. No network connection lines
 * may be present: no valid VPN entitlement or node ACK is implied by HTTP 200.
 * The site may be reached even when a subscription's servers have expired.
 */
export function incyExpiredSubscriptionHeaders(expiresAt:Date):Record<string,string>{
  return {
    ...incySubscriptionHeaders(expiresAt),
    'announce':'base64:'+Buffer.from(
      'Срок VPN истёк. Продлите доступ на mnebyvpn.site','utf8').toString('base64'),
    'announce-url':INCY_RENEW_URL,
  };
}

/** INCY recognizes these # comments in base64 text subscriptions as fallback
 * navigation metadata. Crucially NO VPN keys or server URIs are returned.
 */
export function incyExpiredSubscriptionBody():string{
  return Buffer.from([
    '#profile-title: MNEBYVPN',
    '#profile-web-page-url: '+INCY_SITE_URL,
    '#support-url: '+INCY_SUPPORT_URL,
    '#profile-update-interval: 1',
    '#announce: base64:'+Buffer.from(
      'Срок VPN истёк. Продлите доступ на mnebyvpn.site','utf8').toString('base64'),
    '#announce-url: '+INCY_RENEW_URL,
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
    '#profile-title: MNEBYVPN',
    '#profile-web-page-url: '+INCY_SITE_URL,
    '#support-url: '+INCY_SUPPORT_URL,
    '#profile-update-interval: 1',
    '#announce: base64:'+Buffer.from(
      'Оплата и продление VPN: mnebyvpn.site','utf8').toString('base64'),
    '#announce-url: '+INCY_RENEW_URL,
  ];
  return Buffer.from([...lines,verifiedProfile].join('\n')+'\n','utf8')
    .toString('base64')+'\n';
}
