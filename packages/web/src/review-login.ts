import {randomBytes,scrypt,scryptSync,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scryptAsync=promisify(scrypt);
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool,PoolClient} from 'pg';
import {incrementRate} from './email-auth-service.ts';

export const REVIEW_CODE_PATTERN=/^[0-9]{8}$/;
export const REVIEW_LOCK_MINUTES=30;

/** Salted, peppered and memory-hard; never persist an eight-digit plaintext code. */
export function reviewCodeHash(email:string,code:string,salt:string,secret:string):string{
  if(!REVIEW_CODE_PATTERN.test(code)||!/^[a-f0-9]{32}$/.test(salt)||
     secret.length<32)throw Error('Invalid review credential');
  return scryptSync(email+':'+code+':'+secret,Buffer.from(salt,'hex'),32,{
    N:16384,r:8,p:1,maxmem:64*1024*1024,
  }).toString('hex');
}
export function newReviewSalt():string{
  return randomBytes(16).toString('hex');
}
async function matchesHash(expected:string,email:string,code:string,salt:string,secret:string):Promise<boolean>{
  if(!REVIEW_CODE_PATTERN.test(code)||!/^[a-f0-9]{64}$/.test(expected)||
     !/^[a-f0-9]{32}$/.test(salt))return false;
  const actual=await scryptAsync(email+':'+code+':'+secret,Buffer.from(salt,'hex'),32,
    {N:16384,r:8,p:1,maxmem:64*1024*1024}) as Buffer;
  return timingSafeEqual(Buffer.from(expected,'hex'),actual);
}

export async function isReviewEmail(pool:Pool,email:string):Promise<boolean>{
  const row=await pool.query('SELECT 1 FROM web_review_login WHERE email=$1',[email]);
  return row.rowCount===1;
}
export async function isReviewAccount(pool:Pool,accountId:string):Promise<boolean>{
  const row=await pool.query('SELECT 1 FROM web_review_login WHERE account_id=$1',[accountId]);
  return row.rowCount===1;
}
export async function beginReviewCode(pool:Pool,options:{
  email:string;ip:string;secret:string;
}):Promise<'READY'|'RATE_LIMIT'|'DISABLED'>{
  const {email,ip,secret}=options;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const byEmail=await incrementRate(client,'review-start-email:'+email,5,60*60_000,secret);
    const byIp=await incrementRate(client,'review-start-ip:'+ip,80,60*60_000,secret);
    const row=await client.query('SELECT enabled FROM web_review_login WHERE email=$1',[email]);
    await client.query('COMMIT');
    if(!row.rowCount||row.rows[0].enabled!==true)return 'DISABLED';
    return byEmail&&byIp?'READY':'RATE_LIMIT';
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
type ReviewResult={status:'SIGNED_IN';accountId:string}|{status:'INVALID'|'RATE_LIMIT'};

export async function verifyReviewCode(pool:Pool,options:{
  email:string;code:string;ip:string;secret:string;
}):Promise<ReviewResult>{
  const {email,code,ip,secret}=options;
  if(!REVIEW_CODE_PATTERN.test(code))return {status:'INVALID'};
  const client:PoolClient=await pool.connect();
  let result:ReviewResult={status:'INVALID'};
  try{
    await client.query('BEGIN');
    const byEmail=await incrementRate(client,'review-verify-email:'+email,10,60*60_000,secret);
    const byIp=await incrementRate(client,'review-verify-ip:'+ip,80,60*60_000,secret);
    const found=await client.query(
      'SELECT account_id,code_hash,code_salt,enabled,failed_attempts,locked_until '+
      'FROM web_review_login WHERE email=$1 FOR UPDATE',[email]);
    if(!byEmail||!byIp){
      result={status:'RATE_LIMIT'};
    }else if(found.rowCount===1){
      const entry=found.rows[0];
      const now=Date.now();
      const lockedUntil=entry.locked_until?(entry.locked_until as Date).getTime():0;
      const locked=lockedUntil>now;
      const attempts=lockedUntil>0&&lockedUntil<=now?0:Number(entry.failed_attempts);
      if(entry.enabled===true&&!locked){
        const matching=await matchesHash(entry.code_hash,email,code,entry.code_salt,secret);
        if(matching){
          // A disabled, renamed or detached review account must never authenticate.
          const owner=await client.query(
            'SELECT id FROM accounts WHERE id=$1 AND email_address=$2',
            [entry.account_id,email]);
          if(owner.rowCount===1){
            result={status:'SIGNED_IN',accountId:owner.rows[0].id as string};
            await client.query(
              'UPDATE web_review_login SET failed_attempts=0,locked_until=NULL WHERE email=$1',
              [email]);
          }
        }else{
          const next=Math.min(5,attempts+1);
          await client.query(
            "UPDATE web_review_login SET failed_attempts=$2,locked_until="+
            "CASE WHEN $2>=5 THEN clock_timestamp()+interval '30 minutes' ELSE NULL END "+
            'WHERE email=$1',[email,next]);
        }
      }
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
  // A failed eight-digit guess must not be answered at wire speed.
  if(result.status!=='SIGNED_IN')await delay(400);
  return result;
}
