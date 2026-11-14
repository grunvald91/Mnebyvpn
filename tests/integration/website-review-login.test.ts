import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {otpHash} from '../../packages/web/src/email-otp.ts';
import {newReviewSalt,reviewCodeHash} from '../../packages/web/src/review-login.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
});
const secret='review-integration-testing-secret-at-least-32-characters';
const email='review-'+randomUUID().slice(0,8)+'@example.org';
const regular='regular-'+randomUUID().slice(0,8)+'@example.org';
const pin='82736194',otp='618492';
const account=randomUUID();
let server:ChildProcess|null=null,base='';
const post=(endpoint:string,identity:string,code?:string)=>fetch(base+endpoint,{
  method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
  body:JSON.stringify(code===undefined?{email:identity}:{email:identity,code}),
});
before(async()=>{
  const socket=createServer();
  await new Promise<void>((ok,fail)=>socket.once('error',fail).listen(0,'127.0.0.1',ok));
  const address=socket.address();
  if(!address||typeof address==='string')throw Error('Missing ephemeral port');
  base='http://127.0.0.1:'+address.port;
  await new Promise<void>((ok,fail)=>socket.close(err=>err?fail(err):ok()));
  const salt=newReviewSalt();
  await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,email]);
  await pool.query('INSERT INTO web_review_login(account_id,email,code_salt,code_hash) VALUES($1,$2,$3,$4)',
    [account,email,salt,reviewCodeHash(email,pin,salt,secret)]);
  await pool.query(
    "INSERT INTO web_email_codes(email,code_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')",
    [regular,otpHash(regular,otp,secret)]);
  server=spawn(process.execPath,['--experimental-strip-types','apps/web/src/server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:'ignore',
    env:{...process.env,DATABASE_URL:process.env.DATABASE_URL??'postgresql://test:test@localhost:5432/mnebyvpn_test',
      WEB_AUTH_DATABASE_URL:'',VPN_SUBSCRIPTION_DATABASE_URL:'',
      MNEBYVPN_ENV:'offline-test',WEB_BASE_URL:base,WEB_PORT:new URL(base).port,
      WEB_SESSION_SECRET:secret,WEB_EMAIL_LOGIN_ENABLED:'yes',
      MNEBYVPN_MAIL_GATEWAY_SECRET:'offline-test-gateway-key-longer-than-32-characters',
      WEB_TELEGRAM_OIDC_ENABLED:'no',WEB_CHECKOUT_ENABLED:'0',
      WEB_PRODAMUS_WEBHOOK_ENABLED:'no',WEB_TRIAL_ENABLED:'no',
      WEB_NETWORK_PROVISIONING_VERIFIED:'no'},
  });
  for(let attempt=0;attempt<60;attempt++){
    try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(250)})).status===200)return;}catch{}
    await new Promise(ok=>setTimeout(ok,100));
  }
  throw Error('Web server did not become healthy');
});
after(async()=>{
  server?.kill();
  await pool.query('DELETE FROM website_sessions WHERE account_id=$1',[account]);
  await pool.query('DELETE FROM web_review_login WHERE account_id=$1',[account]);
  await pool.query('DELETE FROM web_email_codes WHERE email=$1',[regular]);
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]);
  await pool.end();
});
test('review login uses eight digits without email; sessions work from two browsers',async()=>{
  const start=await post('/api/auth/email/start',email);
  assert.equal(start.status,200);
  assert.deepEqual(await start.json(),{status:'REVIEW_CODE_REQUIRED',codeLength:8});
  assert.equal((await pool.query('SELECT 1 FROM web_email_codes WHERE email=$1',[email])).rowCount,0);
  assert.equal((await post('/api/auth/email/verify',email,'00000000')).status,401);
  const a=await post('/api/auth/email/verify',email,pin);
  const b=await post('/api/auth/email/verify',email,pin);
  assert.equal(a.status,200);assert.equal(b.status,200);
  const first=a.headers.get('set-cookie')?.split(';')[0];
  const second=b.headers.get('set-cookie')?.split(';')[0];
  assert.ok(first);assert.ok(second);assert.notEqual(first,second);
  const me=await fetch(base+'/api/me',{headers:{cookie:first}});
  assert.equal(me.status,200);
  const own=await me.json() as {identity:{provider:string;email:string};orders:unknown[]};
  assert.equal(own.identity.provider,'email');
  assert.equal(own.identity.email,email);
  assert.deepEqual(own.orders,[]);
  assert.equal((await fetch(base+'/api/me',{headers:{cookie:second}})).status,200);
  await pool.query('UPDATE web_review_login SET enabled=false WHERE account_id=$1',[account]);
  assert.equal((await fetch(base+'/api/me',{headers:{cookie:first}})).status,401);
  await pool.query('UPDATE web_review_login SET enabled=true WHERE account_id=$1',[account]);
});
test('normal six-digit login still works and rejects reviewer pin',async()=>{
  assert.equal((await post('/api/auth/email/verify',regular,pin)).status,400);
  assert.equal((await post('/api/auth/email/verify',regular,otp)).status,200);
  assert.equal((await post('/api/auth/email/verify',regular,otp)).status,401);
  assert.equal((await post('/api/auth/email/verify',email,otp)).status,400);
});
test('five wrong reviewer guesses lock out the correct code',async()=>{
  for(let i=0;i<5;i++)
    assert.equal((await post('/api/auth/email/verify',email,String(10000000+i))).status,401);
  const found=await pool.query('SELECT failed_attempts,locked_until FROM web_review_login WHERE account_id=$1',[account]);
  assert.equal(Number(found.rows[0].failed_attempts),5);
  assert.ok((found.rows[0].locked_until as Date).getTime()>Date.now()+29*60_000);
  assert.equal((await post('/api/auth/email/verify',email,pin)).status,401);
});
