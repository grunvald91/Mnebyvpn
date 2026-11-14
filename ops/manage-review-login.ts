/**
 * Private operator-only command; NEVER invoke from a public HTTP route.
 * Example: REVIEW_LOGIN_EMAIL=... REVIEW_LOGIN_CODE=... WEB_SESSION_SECRET=...
 *          DATABASE_URL=... node --experimental-strip-types ops/manage-review-login.ts provision
 * Secrets are supplied from a secure environment, never in Git or command arguments.
 */
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {normalizeLoginEmail} from '../packages/web/src/email-otp.ts';
import {newReviewSalt,reviewCodeHash,REVIEW_CODE_PATTERN}
  from '../packages/web/src/review-login.ts';

const action=process.argv[2];
if(!['provision','disable'].includes(action||''))throw Error('Expected provision or disable');
if(process.argv.length!==3)throw Error('Do not pass credentials as command-line arguments');
const databaseUrl=process.env.DATABASE_URL??'';
if(!/^postgres(?:ql)?:\/\//.test(databaseUrl))throw Error('Canonical database connection is required');
const secret=process.env.WEB_SESSION_SECRET??'';
const email=normalizeLoginEmail(process.env.REVIEW_LOGIN_EMAIL);
const code=process.env.REVIEW_LOGIN_CODE??'';
if(action==='provision'&&(!email||!REVIEW_CODE_PATTERN.test(code)||secret.length<32))
  throw Error('Missing or invalid private reviewer configuration');

const pool=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:3000});
try{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const existing=await client.query('SELECT account_id,email FROM web_review_login WHERE singleton=true FOR UPDATE');
    if(action==='disable'){
      if(existing.rowCount===1){
        await client.query("UPDATE web_review_login SET enabled=false,updated_at=clock_timestamp() WHERE singleton=true");
        await client.query(
          "UPDATE website_sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL",
          [existing.rows[0].account_id]);
      }
    }else if(email){
      const collision=await client.query('SELECT id FROM accounts WHERE email_address=$1 FOR UPDATE',[email]);
      if(collision.rowCount===1&&
         (existing.rowCount!==1||collision.rows[0].id!==existing.rows[0].account_id))
        throw Error('Reviewer email is already assigned to a customer; refusing');
      let accountId:string;
      if(existing.rowCount===1){
        accountId=existing.rows[0].account_id as string;
        await client.query('UPDATE accounts SET email_address=$1 WHERE id=$2',[email,accountId]);
      }else{
        accountId=randomUUID();
        await client.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[accountId,email]);
      }
      const salt=newReviewSalt();
      const hash=reviewCodeHash(email,code,salt,secret);
      await client.query(
        'INSERT INTO web_review_login(singleton,account_id,email,code_salt,code_hash,enabled) '+
        'VALUES(true,$1,$2,$3,$4,true) '+
        'ON CONFLICT(singleton) DO UPDATE SET account_id=EXCLUDED.account_id,email=EXCLUDED.email,'+
        'code_salt=EXCLUDED.code_salt,code_hash=EXCLUDED.code_hash,enabled=true,'+
        'failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp()',
        [accountId,email,salt,hash]);
      await client.query(
        "UPDATE website_sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL",
        [accountId]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
  // Do not print account identifier, email, code or hash in CI/logs.
  process.stdout.write(action==='disable'?'Reviewer access disabled.\n':'Reviewer access provisioned.\n');
}finally{await pool.end();}
