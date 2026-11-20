/**
 * Authenticated, tightly scoped read-only GSC summary relay to the existing
 * private MNEBYVPN operator chat. No operator ID ever leaves the server.
 * HMAC key is the existing shared bot token; the token is NEVER transmitted.
 */
import {createHmac,timingSafeEqual} from 'node:crypto';

const DOMAIN='MNEBYVPN-gsc-owner-relay-v1';
const TOKEN=/^[0-9]{5,20}:[A-Za-z0-9_-]{25,}$/;
const SIGNATURE=/^[a-f0-9]{64}$/;
const TIMESTAMP=/^[1-9][0-9]{9}$/;
const PREFIX='MNEBYVPN · Google Search Console';

export function validGscOwnerReport(text:unknown):text is string{
  return typeof text==='string' && text.startsWith(PREFIX) &&
    text.length>40 && text.length<=3800 &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

export function createGscOwnerRelaySignature(token:string,timestamp:string,text:string):string{
  if(!TOKEN.test(token)||!TIMESTAMP.test(timestamp)||!validGscOwnerReport(text))
    throw Error('GSC_OWNER_RELAY_INVALID_INPUT');
  return createHmac('sha256',token).update(DOMAIN+'\n'+timestamp+'\n'+text).digest('hex');
}

export function verifyGscOwnerRelaySignature(
  token:string,timestamp:unknown,signature:unknown,text:unknown,now=Date.now(),
):boolean{
  if(typeof timestamp!=='string'||!TIMESTAMP.test(timestamp)||
    typeof signature!=='string'||!SIGNATURE.test(signature)||
    !validGscOwnerReport(text)||!TOKEN.test(token)||
    Math.abs(Math.floor(now/1000)-Number(timestamp))>120)
    return false;
  const expected=createGscOwnerRelaySignature(token,timestamp,text);
  return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'));
}
