/** Subscription metadata recognized by INCY: https://docs.incy.cc/app-management/.
 * No account IDs, access tokens or private subscription URLs in navigation links.
 * INCY's expiry-banner-* requires provider Premium; ordinary links do not.
 */
export const INCY_SITE_URL='https://mnebyvpn.site/';
export const INCY_RENEW_URL='https://mnebyvpn.site/#account';
export const INCY_SUPPORT_URL='https://t.me/MnebyVPN_bot';
const b64=(value:string)=>'base64:'+Buffer.from(value,'utf8').toString('base64');
const EXPIRED_MESSAGE='Срок VPN-доступа истёк. Продлите подписку на сайте MNEBYVPN.';
const EXPIRING_MESSAGE='Срок VPN-доступа скоро закончится. Продлите подписку на сайте MNEBYVPN.';
const THREE_DAYS=3*24*60*60*1000;

/** Expiration is measured at the server, never supplied by the request URL. */
export function incyMetadata(expiresAt:Date,now=Date.now()):Record<string,string>{
  const expires=expiresAt.getTime();
  if(!Number.isFinite(expires))throw Error('Invalid VPN expiration');
  const metadata:Record<string,string>={
    'profile-title':'MNEBYVPN',
    'profile-web-page-url':INCY_SITE_URL,
    'support-url':INCY_SUPPORT_URL,
    'premium-url':INCY_RENEW_URL,
    'profile-update-interval':'1',
    // Keep the existing zero/unlimited traffic placeholders; measured usage
    // must not be claimed without real node traffic metering.
    'subscription-userinfo':'upload=0;download=0;total=0;expire='+Math.floor(expires/1000),
    'expiry-banner-text':b64('Срок VPN-доступа заканчивается или истёк. Продлите на сайте.'),
    'expiry-banner-button-text':b64('Продлить доступ'),
    'expiry-banner-button-url':INCY_RENEW_URL,
  };
  if(expires-now<=THREE_DAYS){
    metadata.announce=b64(expires<=now?EXPIRED_MESSAGE:EXPIRING_MESSAGE);
    metadata['announce-url']=INCY_RENEW_URL;
  }
  return metadata;
}

/** No VLESS secrets returned for expired access; metadata remains refreshable.
 * INCY's actual handling of a config-less refresh needs a device E2E check.
 */
export function expiredIncyBody():string{
  const comments=[
    '#profile-title: MNEBYVPN',
    '#support-url: '+INCY_SUPPORT_URL,
    '#profile-web-page-url: '+INCY_SITE_URL,
    '#profile-update-interval: 1',
    '#announce: '+b64(EXPIRED_MESSAGE),
    '#announce-url: '+INCY_RENEW_URL,
  ];
  return Buffer.from(comments.join('\n')+'\n','utf8').toString('base64')+'\n';
}
