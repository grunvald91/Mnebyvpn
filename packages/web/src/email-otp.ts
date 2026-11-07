import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

/** Preserve a single canonical case-insensitive ASCII mailbox identity. */
export function normalizeLoginEmail(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const email=value.trim().toLowerCase();
  if(email.length<6||email.length>254||/[\r\n\s<>]/.test(email)||
     !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)||
     email.includes('..')||email.includes('@.'))return null;
  return email;
}
export function privateDigest(purpose:string,value:string,secret:string):string{
  return createHmac('sha256',secret).update(purpose).update(':').update(value).digest('hex');
}
export function otpHash(email:string,code:string,secret:string):string{
  return privateDigest('email-login-v1',email+':'+code,secret);
}
export function otpMatches(expected:string,email:string,code:string,secret:string):boolean{
  if(!/^[0-9]{6}$/.test(code)||!/^[a-f0-9]{64}$/.test(expected))return false;
  const hash=otpHash(email,code,secret);
  return timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(hash,'hex'));
}
const ENDPOINT='https://servgo.ru/api/auth/mnebyvpn/email-code';
export async function deliverEmailOtp(
 email:string,code:string,secret:string,fetcher:typeof fetch=fetch,
):Promise<boolean>{
  if(secret.length<32||normalizeLoginEmail(email)!==email||!/^[0-9]{6}$/.test(code))
    throw Error('Invalid email delivery configuration');
  const timestamp=String(Math.floor(Date.now()/1000));
  const nonce=randomBytes(24).toString('base64url');
  const payload=JSON.stringify({email,code});
  const signature=createHmac('sha256',secret)
    .update(timestamp+'.'+nonce+'.'+payload).digest('hex');
  try{
    const response=await fetcher(ENDPOINT,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(9000),
      headers:{'Content-Type':'application/json','X-Mnebyvpn-Timestamp':timestamp,
        'X-Mnebyvpn-Nonce':nonce,'X-Mnebyvpn-Signature':signature},
      body:payload});
    return response.status===200;
  }catch{return false;}
}
