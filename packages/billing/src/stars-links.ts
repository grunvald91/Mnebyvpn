import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';

/** A personal, single-order invoice link token. The order is inserted only
 * when Telegram sends its authenticated pre_checkout_query, not when a user
 * opens the catalogue. This prevents four PENDING orders per view.
 */
const prefix='mnebyvpn:link:v1';
const format=/^mnebyvpn:link:v1:([0-9a-f]{32}):([0-9a-z]{1,12}):([A-Za-z0-9_-]{16}):([0-9a-f]{24})$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface PersonalStarsLink {
  orderId:string;
  telegramUserId:number;
  offerKey:string;
}
function digest(text:string,secret:string){
  if(secret.length<32)throw Error('Invalid Stars link signing secret');
  return createHmac('sha256',secret).update(text).digest('hex').slice(0,24);
}
export function makePersonalStarsLinkPayload(
  telegramUserId:number,offerKey:string,secret:string,orderId=randomUUID(),
):string{
  if(!Number.isSafeInteger(telegramUserId)||telegramUserId<=0||
    !/^[A-Za-z0-9_-]{16}$/.test(offerKey)||!uuid.test(orderId))
    throw Error('Invalid personal invoice identity');
  const bare=prefix+':'+orderId.replaceAll('-','')+':'+telegramUserId.toString(36)+':'+offerKey;
  const payload=bare+':'+digest(bare,secret);
  if(Buffer.byteLength(payload,'utf8')>128)throw Error('Stars invoice payload too large');
  return payload;
}
export function parsePersonalStarsLinkPayload(
  payload:unknown,secret:string,
):PersonalStarsLink|null{
  if(typeof payload!=='string'||secret.length<32)return null;
  const m=format.exec(payload);
  if(!m)return null;
  const id=m[1],n=Number.parseInt(m[2],36);
  if(!Number.isSafeInteger(n)||n<=0||n.toString(36)!==m[2])return null;
  const orderId=[id.slice(0,8),id.slice(8,12),id.slice(12,16),
    id.slice(16,20),id.slice(20)].join('-');
  if(!uuid.test(orderId))return null;
  const bare=payload.slice(0,-25),expected=digest(bare,secret);
  const left=Buffer.from(m[4],'ascii'),right=Buffer.from(expected,'ascii');
  if(left.length!==right.length||!timingSafeEqual(left,right))return null;
  return {orderId,telegramUserId:n,offerKey:m[3]};
}
