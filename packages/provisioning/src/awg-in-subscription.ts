/**
 * FI217 AmneziaWG 3.1 inside the EXISTING INCY subscription.
 *
 * The stable per-entitlement X25519 identity is derived only from an
 * independently provisioned 32-byte secret held by RU188 and its website.
 * The existing opaque HTTPS subscription bearer already grants access to
 * VLESS credentials; the same bearer authorizes this client configuration.
 * Never expose the master key or create a grant during subscription GET.
 */
import {createHmac,createPrivateKey,createPublicKey} from 'node:crypto';
import type {VerifiedAwgMaterial} from './awg-subscriber-material.ts';
import {renderLocalAwgConfig} from './awg-subscriber-material.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const PKCS8=Buffer.from('302e020100300506032b656e04220420','hex');
const SPKI=Buffer.from('302a300506032b656e032100','hex');
const CONTEXT='MNEBYVPN_NATIVE_AWG_INCY_SUB_V1\0fi-test-01\0';

export type SubscriptionAwgIdentity={
  privateKey:string;
  publicKey:string;
};

/**
 * Stable across updates and paid renewals; a different entitlement derives
 * an unrelated identity. A secret rotation requires a controlled peer
 * re-enrollment and must not be done automatically.
 */
export function deriveSubscriptionAwgIdentity(
  entitlementId:string,rootSecretHex:string,
):SubscriptionAwgIdentity{
  if(!UUID.test(entitlementId)||!HEX.test(rootSecretHex)||
     /^0{64}$/.test(rootSecretHex))
    throw Error('Protected AWG subscription identity required');
  const secret=Buffer.from(rootSecretHex,'hex');
  const raw=createHmac('sha256',secret).update(CONTEXT,'utf8')
    .update(entitlementId,'ascii').digest();
  const privateKey=createPrivateKey({
    key:Buffer.concat([PKCS8,raw]),format:'der',type:'pkcs8',
  });
  const publicDer=createPublicKey(privateKey).export({
    format:'der',type:'spki',
  }) as Buffer;
  if(publicDer.length!==SPKI.length+32||
     !publicDer.subarray(0,SPKI.length).equals(SPKI))
    throw Error('Unexpected X25519 public key encoding');
  return {
    privateKey:raw.toString('base64'),
    publicKey:publicDer.subarray(SPKI.length).toString('base64'),
  };
}

/**
 * Canonical INCY mixed-subscription URI. Existing VLESS links stay intact.
 * Never render it for an unacknowledged node grant or a different user key.
 */
export function verifiedIncyAwgLine(
  material:VerifiedAwgMaterial,identity:SubscriptionAwgIdentity,
):string {
  if(material.nodeId!=='fi-test-01'||
     material.clientPublicKey!==identity.publicKey)
    throw Error('No exact signed FI client binding');
  const conf=renderLocalAwgConfig(material,identity.privateKey);
  if(!conf.startsWith('[Interface]\n')||
     !conf.includes('HeaderProtectionKey = ')||
     !conf.includes('Endpoint = fi.mnebyvpn.site:51821'))
    throw Error('Incomplete AmneziaWG 3.1 client profile');
  return 'amneziawg://'+Buffer.from(conf,'utf8').toString('base64url')+
    '#'+encodeURIComponent('🇫🇮 MNEBYVPN · Финляндия · AmneziaWG 3.1');
}
