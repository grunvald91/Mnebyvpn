import {randomInt} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {otpHash,otpMatches,privateDigest,deliverEmailOtp} from './email-otp.ts';

async function incrementRate(client:PoolClient,key:string,cap:number,
  windowMs:number,secret:string):Promise<boolean>{
  const hash=privateDigest('mail-rate',key,secret);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[hash]);
  const previous=await client.query(
    'SELECT attempts,window_start FROM web_email_rate_limits WHERE subject_hash=$1 FOR UPDATE',[hash]);
  const now=new Date();
  if(previous.rowCount===0){
    await client.query('INSERT INTO web_email_rate_limits(subject_hash,window_start,attempts) VALUES($1,$2,1)',[hash,now]);
    return true;
  }
  const elapsed=now.getTime()-(previous.rows[0].window_start as Date).getTime();
  const count=elapsed>windowMs?1:Number(previous.rows[0].attempts)+1;
  await client.query(
    'UPDATE web_email_rate_limits SET attempts=$2,window_start=$3 WHERE subject_hash=$1',
    [hash,count,elapsed>windowMs?now:previous.rows[0].window_start]);
  return count<=cap;
}
/** All public results are coarse: do not reveal whether the address owns an account. */
export async function beginEmailCode(pool:Pool,options:{
  email:string;ip:string;linkAccountId:string|null;secret:string;gatewaySecret:string;
}):Promise<'SENT'|'RATE_LIMIT'|'FAILED'>{
  const {email,ip,linkAccountId,secret,gatewaySecret}=options;
  const code=String(randomInt(0,1_000_000)).padStart(6,'0');
  const codeHash=otpHash(email,code,secret);
  const client=await pool.connect();
  let allowed=false;
  try{
    await client.query('BEGIN');
    const byEmail=await incrementRate(client,'email:'+email,5,60*60_000,secret);
    const byIp=await incrementRate(client,'ip:'+ip,80,60*60_000,secret);
    const previous=await client.query(
      'SELECT sent_at FROM web_email_codes WHERE email=$1 FOR UPDATE',[email]);
    const cooldown=previous.rowCount>0 &&
      Date.now()-(previous.rows[0].sent_at as Date).getTime()<60_000;
    if(byEmail&&byIp&&!cooldown){
      await client.query(
        'INSERT INTO web_email_codes(email,code_hash,expires_at,sent_at,attempts,consumed_at,link_account_id) '+
        "VALUES($1,$2,clock_timestamp()+interval '10 minutes',clock_timestamp(),0,NULL,$3) "+
        'ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,'+
        'expires_at=EXCLUDED.expires_at,sent_at=EXCLUDED.sent_at,'+
        'attempts=0,consumed_at=NULL,link_account_id=EXCLUDED.link_account_id',
        [email,codeHash,linkAccountId]);
      allowed=true;
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
  if(!allowed)return 'RATE_LIMIT';
  const sent=await deliverEmailOtp(email,code,gatewaySecret);
  if(!sent){
    await pool.query(
      'DELETE FROM web_email_codes WHERE email=$1 AND code_hash=$2 AND consumed_at IS NULL',
      [email,codeHash]);
    return 'FAILED';
  }
  return 'SENT';
}
export async function verifyEmailCode(pool:Pool,options:{
  email:string;code:string;currentAccountId:string|null;secret:string;
}):Promise<{status:'SIGNED_IN'|'INVALID'|'CONFLICT';accountId?:string}>{
  const {email,code,currentAccountId,secret}=options;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=await client.query(
      'SELECT code_hash,attempts,link_account_id FROM web_email_codes '+
      'WHERE email=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',
      [email]);
    if(found.rowCount!==1||Number(found.rows[0].attempts)>=5){
      await client.query('COMMIT');return {status:'INVALID'};
    }
    const entry=found.rows[0];
    if(!otpMatches(entry.code_hash,email,code,secret)){
      await client.query('UPDATE web_email_codes SET attempts=attempts+1 WHERE email=$1',[email]);
      await client.query('COMMIT');return {status:'INVALID'};
    }
    let accountId:string;
    if(entry.link_account_id){
      if(currentAccountId!==entry.link_account_id){
        await client.query('COMMIT');return {status:'CONFLICT'};
      }
      const linked=await client.query(
        'UPDATE accounts SET email_address=$1 WHERE id=$2 '+
        'AND (email_address IS NULL OR email_address=$1) RETURNING id',
        [email,currentAccountId]);
      if(linked.rowCount!==1){
        await client.query('COMMIT');return {status:'CONFLICT'};
      }
      accountId=linked.rows[0].id;
    }else{
      const owner=await client.query(
        'INSERT INTO accounts(id,email_address) VALUES(gen_random_uuid(),$1) '+
        'ON CONFLICT(email_address) DO UPDATE SET email_address=EXCLUDED.email_address RETURNING id',
        [email]);
      accountId=owner.rows[0].id;
    }
    await client.query(
      'UPDATE web_email_codes SET consumed_at=clock_timestamp() WHERE email=$1',[email]);
    await client.query('COMMIT');
    return {status:'SIGNED_IN',accountId};
  }catch(error){
    await client.query('ROLLBACK');
    if((error as {code?:string}).code==='23505')return {status:'CONFLICT'};
    throw error;
  }finally{client.release();}
}
