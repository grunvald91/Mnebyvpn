import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomInt,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {otpHash} from '../../packages/web/src/email-otp.ts';

const pg={
  host:process.env.PGHOST??'localhost',
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',
  password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
};
const dbUrl='postgresql://'+encodeURIComponent(pg.user)+':'+
  encodeURIComponent(pg.password)+'@'+pg.host+':'+pg.port+'/'+pg.database;
const pool=new Pool({...pg,max:2});
const secret='website-email-integration-session-secret-over-32-characters';
const email='signin-'+randomUUID().slice(0,8)+'@example.org';
const otp=String(randomInt(0,1_000_000)).padStart(6,'0');
let port=0;
let server:ChildProcess|null=null;
let stderr='';
let base='';
before(async()=>{
  const socket=createServer();
  await new Promise<void>((ok,fail)=>socket.once('error',fail).listen(0,'127.0.0.1',ok));
  const address=socket.address();
  if(!address||typeof address==='string')throw Error('Ephemeral port unavailable');
  port=address.port;
  await new Promise<void>((ok,fail)=>socket.close(error=>error?fail(error):ok()));
  base='http://127.0.0.1:'+port;
  await pool.query(
    "INSERT INTO web_email_codes(email,code_hash,expires_at,sent_at,attempts) VALUES($1,$2,clock_timestamp()+interval '10 minutes',clock_timestamp(),0)",
    [email,otpHash(email,otp,secret)],
  );
  server=spawn(process.execPath,['--experimental-strip-types','apps/web/src/server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{
      ...process.env,
      DATABASE_URL:dbUrl,
      WEB_AUTH_DATABASE_URL:'',
      VPN_SUBSCRIPTION_DATABASE_URL:'',
      MNEBYVPN_ENV:'offline-test',
      WEB_BASE_URL:base,
      WEB_PORT:String(port),
      WEB_SESSION_SECRET:secret,
      WEB_EMAIL_LOGIN_ENABLED:'yes',
      MNEBYVPN_MAIL_GATEWAY_SECRET:'mock-only-gateway-secret-for-offline-tests-0123456789',
      WEB_TELEGRAM_OIDC_ENABLED:'no',
      WEB_CHECKOUT_ENABLED:'0',
      WEB_PRODAMUS_WEBHOOK_ENABLED:'no',
      WEB_TRIAL_ENABLED:'no',
      WEB_NETWORK_PROVISIONING_VERIFIED:'no',
    },
  });
  server.stderr?.on('data',(buf:Buffer)=>{stderr+=String(buf).slice(0,500)});
  for(let attempt=0;attempt<60;attempt++){
    try{
      const response=await fetch(base+'/healthz',{signal:AbortSignal.timeout(250)});
      if(response.status===200)return;
    }catch{}
    if(server.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Test website never started: '+stderr.slice(0,500));
});
after(async()=>{
  server?.kill('SIGTERM');
  await pool.end();
});
function verify(code:string,origin=base){
  return fetch(base+'/api/auth/email/verify',{
    method:'POST',
    headers:{'Content-Type':'application/json',Origin:origin},
    body:JSON.stringify({email,code}),
  });
}
test('email code verification creates a real session; OTP is consumed and logout revokes cookie',async()=>{
  const plans=await fetch(base+'/api/plans');
  assert.equal(plans.status,200);
  const settings=await plans.json() as {emailLoginEnabled:boolean;checkoutEnabled:boolean;trialOffers:string[]};
  assert.equal(settings.emailLoginEnabled,true);
  assert.equal(settings.checkoutEnabled,false);
  assert.deepEqual(settings.trialOffers,[]);
  assert.equal((await fetch(base+'/api/me')).status,401);

  const badOrigin=await verify(otp,'https://untrusted.example');
  assert.equal(badOrigin.status,403);
  const wrong=await verify(otp==='000000'?'000001':'000000');
  assert.equal(wrong.status,401);

  const correct=await verify(otp);
  assert.equal(correct.status,200);
  assert.equal((await correct.json() as {status:string}).status,'SIGNED_IN');
  const cookie=correct.headers.get('set-cookie')?.split(';')[0];
  if(!cookie)throw new Error('Missing signed session cookie');
  assert.ok(cookie.startsWith('mnebyvpn_session='));
  assert.equal((await verify(otp)).status,401,'One-time code cannot be reused');

  const me=await fetch(base+'/api/me',{headers:{cookie}});
  assert.equal(me.status,200);
  const data=await me.json() as {identity:{provider:string;email:string};csrf:string};
  assert.equal(data.identity.provider,'email');
  assert.equal(data.identity.email,email);
  assert.ok(data.csrf);

  const logout=await fetch(base+'/api/logout',{
    method:'POST',
    headers:{cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':data.csrf},
    body:'{}',
  });
  assert.equal(logout.status,200);
  assert.equal((await fetch(base+'/api/me',{headers:{cookie}})).status,401);
  const consumed=await pool.query('SELECT consumed_at IS NOT NULL AS used FROM web_email_codes WHERE email=$1',[email]);
  assert.equal(consumed.rows[0].used,true);
});
