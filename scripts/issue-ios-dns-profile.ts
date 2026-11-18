/**
 * Operator-side profile issuance, not an internet endpoint. Never run with
 * user-provided URLs, and never commit generated files or signing keys.
 *
 * Example (after installing a trusted signing identity):
 * MNEBYDNS_IOS_OUTPUT=/secure/out/test.mobileconfig \
 * MNEBYDNS_SIGN_CERT_FILE=/run/secrets/ios-sign-cert.pem \
 * MNEBYDNS_SIGN_KEY_FILE=/run/secrets/ios-sign-key.pem \
 * MNEBYDNS_SIGN_TRUST_ROOTS_FILE=/run/secrets/ios-sign-roots.pem \
 * node --experimental-strip-types scripts/issue-ios-dns-profile.ts
 */
import {writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {
  issueSignedIosDnsProfile,type IosDnsTarget,
} from '../packages/dns-policy/src/ios-signed-profile.ts';

const env=process.env;
const out=env.MNEBYDNS_IOS_OUTPUT??'';
if(!isAbsolute(out)||!out.endsWith('.mobileconfig'))throw Error('INVALID_OUTPUT_PATH');

const personalDoH=env.MNEBYDNS_VERIFIED_PERSONAL_DOH_URL;
let target:IosDnsTarget;
if(personalDoH){
  if(env.MNEBYDNS_PERSONAL_DOH_ISSUANCE_VERIFIED!=='yes'||
     env.MNEBYDNS_DNS_INGRESS_VERIFIED!=='yes')
    throw Error('PERSONAL_DNS_NOT_VERIFIED');
  target={protocol:'HTTPS',serverUrl:personalDoH};
}else{
  // Shared TEST DoT only; the filename and description MUST not imply
  // subscriber attribution, metering, revocation, or a paid service.
  target={protocol:'TLS',serverName:'dns.mnebyvpn.site'};
}
const identity={
  certificateFile:env.MNEBYDNS_SIGN_CERT_FILE??'',
  privateKeyFile:env.MNEBYDNS_SIGN_KEY_FILE??'',
  trustRootsFile:env.MNEBYDNS_SIGN_TRUST_ROOTS_FILE??'',
  intermediateChainFile:env.MNEBYDNS_SIGN_CHAIN_FILE||undefined,
};
const identifier=env.MNEBYDNS_IOS_PROFILE_IDENTIFIER||
  (personalDoH?'site.mnebyvpn.ios.personal.issuerpending':'site.mnebyvpn.ios.sharedtest');
if(personalDoH&&!env.MNEBYDNS_IOS_PROFILE_IDENTIFIER)
  throw Error('PERSONAL_PROFILE_IDENTIFIER_REQUIRED');
const data=await issueSignedIosDnsProfile({
  identifier,
  displayName:personalDoH?'MNEBYDNS — индивидуальный DNS':'MNEBYDNS — общий DNS (тест)',
  description:personalDoH
    ?'Персональный защищённый DNS. Право доступа проверяет DNS-сервер. Удаление: Настройки → Основные → VPN и управление устройством.'
    :'Общий тестовый DNS-over-TLS. Нет персональной авторизации, срока и учёта трафика. Удаление: Настройки → Основные → VPN и управление устройством.',
  target,
},identity);
// 'wx' refuses accidental overwrites of an existing issued profile.
await writeFile(out,data,{flag:'wx',mode:0o600});
console.log('IOS_DNS_SIGNED_PROFILE_CREATED');
