import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {issueAccountSession,csrfForSession} from '../../packages/web/src/security.ts';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {signProdamus,type Fields} from '../../packages/billing/src/prodamus.ts';

const pg={host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test'};
const databaseUrl='postgresql://'+encodeURIComponent(pg.user)+':'+
  encodeURIComponent(pg.password)+'@'+pg.host+':'+pg.port+'/'+pg.database;
const pool=new Pool({...pg,max:4});
const billing=new PgBillingStore(pool);
const secret='offline-test-prodamus-signature-secret-0123456789';
const suffix=randomUUID().slice(0,8);
let port=0;
let website:ChildProcess|null=null;
let stderr='';
let payment:{id:string;txn:string;amount:number};
const accountId=randomUUID();
const telegramId=901339223;
before(async()=>{
  const tcp=createServer();
  await new Promise<void>((resolve,reject)=>tcp.once('error',reject).listen(0,'127.0.0.1',()=>resolve()));
  const address=tcp.address();
  if(!address||typeof address==='string')throw new Error('No ephemeral port');
  port=address.port;
  await new Promise<void>((resolve,reject)=>tcp.close(err=>err?reject(err):resolve()));
  const planId='webhook-'+suffix,amount=11900;
  await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
    [accountId,String(telegramId)]);
  await pool.query(`INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,enabled)
    VALUES($1,'vpn','HTTPS webhook test',86400,$2,true)`,[planId,amount]);
  const order=await billing.createWebsiteOrder(accountId,planId,'webhook-'+suffix);
  payment={id:order.id,txn:'test-webhook-charge-'+suffix,amount};
  website=spawn(process.execPath,['--experimental-strip-types','apps/web/src/server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,
      DATABASE_URL:databaseUrl,
      MNEBYVPN_ENV:'offline-test',
      WEB_BASE_URL:'http://127.0.0.1:'+port,
      WEB_PORT:String(port),
      WEB_SESSION_SECRET:'w'.repeat(64),
      TELEGRAM_OIDC_CLIENT_ID:'123456',
      TELEGRAM_OIDC_CLIENT_SECRET:'t'.repeat(48),
      WEB_PRODAMUS_WEBHOOK_ENABLED:'yes',
      WEB_PAYMENT_PROVIDER_TESTED:'yes',
      WEB_CHECKOUT_ENABLED:'0',
      WEB_NETWORK_PROVISIONING_VERIFIED:'no',
      PRODAMUS_FORM_URL:'https://merchant.payform.ru/',
      PRODAMUS_NOTIFICATION_URL:'http://127.0.0.1:'+port+'/webhooks/prodamus',
      PRODAMUS_SUCCESS_URL:'https://site.example/success',
      PRODAMUS_RETURN_URL:'https://site.example/return',
      PRODAMUS_SIGN_SECRET:secret,
    },
  });
  website.stderr?.on('data',(data:Buffer)=>{stderr+=data.toString().slice(0,1024);});
  let up=false;
  for(let i=0;i<60;i++){
    try{
      const response=await fetch('http://127.0.0.1:'+port+'/healthz',
        {signal:AbortSignal.timeout(250)});
      if(response.ok){up=true;break;}
    }catch{}
    if(website.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!up)throw new Error('Website failed to start on localhost: '+stderr);
});
after(async()=>{
  website?.kill('SIGTERM');
  await pool.end();
});
function wireForm(fields:Fields,encoding:'multipart'|'urlencoded'){
  const body=encoding==='multipart'?new FormData():new URLSearchParams();
  const walk=(path:string,value:Fields[string]):void=>{
    if(Array.isArray(value)){value.forEach((v,i)=>walk(path+'['+i+']',v));return;}
    if(value!==null && typeof value==='object'){
      for(const [k,v] of Object.entries(value))walk(path+'['+k+']',v);
      return;
    }
    body.append(path,String(value));
  };
  for(const [key,value] of Object.entries(fields))walk(key,value);
  return body;
}
async function post(fields:Fields,valid=true,encoding:'multipart'|'urlencoded'='multipart'){
  const sig=signProdamus(fields,secret);
  return fetch('http://127.0.0.1:'+port+'/webhooks/prodamus',{
    method:'POST',
    body:wireForm(fields,encoding),
    headers:{Sign:valid?sig:'0'.repeat(64)},
  });
}
test('live HTTP: signed Prodamus URL-encoded success, multipart retry and de-duplication',async()=>{
  const fields:Fields={
    order_num:payment.id,order_id:payment.txn,domain:'merchant.payform.ru',
    // Live Prodamus notifications omit currency and use URL-encoded fields.
    sum:'119.00',payment_status:'success',attempt:'23',
    customer_email:'customer@example.test',
    payment_status_description:'Успешно завершён',
    products:[{name:'VPN • 15 дней',price:'119.00',quantity:'1',sum:'119.00'}],
  };
  const invalid=await post(fields,false,'urlencoded');
  assert.equal(invalid.status,401);
  assert.equal((await pool.query('SELECT state FROM orders WHERE id=$1',[payment.id])).rows[0].state,'PENDING');
  const good=await post(fields,true,'urlencoded');
  assert.equal(good.status,200);
  assert.equal(await good.text(),'OK');
  assert.equal((await pool.query('SELECT state FROM orders WHERE id=$1',[payment.id])).rows[0].state,'PAID');
  const redelivery=await post({...fields,attempt:'24'},true,'multipart');
  assert.equal(redelivery.status,200);
  assert.equal(await redelivery.text(),'ALREADY_PROCESSED');
  const secondEncodedRetry=await post({...fields,attempt:'25'},true,'urlencoded');
  assert.equal(secondEncodedRetry.status,200);
  assert.equal(await secondEncodedRetry.text(),'ALREADY_PROCESSED');
  const result=await pool.query(
    'SELECT count(*)::int AS n FROM entitlement_credits WHERE order_id=$1',[payment.id]);
  assert.equal(result.rows[0].n,1);
});
test('URL-encoded Prodamus notifications reject wrong signed amount and currency',async()=>{
  const base:Fields={
    order_num:payment.id,order_id:payment.txn,domain:'merchant.payform.ru',
    sum:'99.00',payment_status:'success',attempt:'26',
  };
  const wrongAmount=await post(base,true,'urlencoded');
  assert.equal(wrongAmount.status,400);
  assert.equal(await wrongAmount.text(),'ORDER_MISMATCH');
  const wrongCurrency=await post({...base,sum:'119.00',currency:'usd'},true,'urlencoded');
  assert.equal(wrongCurrency.status,400);
  assert.equal(await wrongCurrency.text(),'ORDER_MISMATCH');
});

test('webhook remains available when new checkout is disabled, and customer APIs remain protected',async()=>{
  const plans=await fetch('http://127.0.0.1:'+port+'/api/plans');
  assert.equal(plans.status,200);
  assert.equal((await plans.json() as {checkoutEnabled:boolean}).checkoutEnabled,false);
  const checkout=await fetch('http://127.0.0.1:'+port+'/api/checkout',{
    method:'POST',headers:{'content-type':'application/json'},body:'{}',
  });
  assert.equal(checkout.status,401);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/me')).status,401);
  const noSig=await fetch('http://127.0.0.1:'+port+'/webhooks/prodamus',{
    method:'POST',body:wireForm({payment_status:'success'},'multipart'),
  });
  assert.equal(noSig.status,401);
  const wrongContent=await fetch('http://127.0.0.1:'+port+'/webhooks/prodamus',{
    method:'POST',headers:{Sign:'a'.repeat(64),'Content-Type':'application/json'},body:'{}',
  });
  assert.equal(wrongContent.status,415);
});

test('signed cookie not in server ledger cannot access account; logout revokes it',async()=>{
  const key='w'.repeat(64);
  const raw=issueAccountSession(accountId,key);
  const headers={cookie:'mnebyvpn_session='+raw};
  const base='http://127.0.0.1:'+port;
  assert.equal((await fetch(base+'/api/me',{headers})).status,401);
  await pool.query(`INSERT INTO website_sessions(token_sha256,account_id,expires_at)
    VALUES($1,$2,$3)`,[createHash('sha256').update(raw).digest('hex'),
      accountId,new Date(Date.now()+3600_000)]);
  const me=await fetch(base+'/api/me',{headers});
  assert.equal(me.status,200);
  assert.equal((await me.json() as {identity:{provider:string}}).identity.provider,'telegram');
  const logout=await fetch(base+'/api/logout',{method:'POST',
    headers:{...headers,origin:base,'content-type':'application/json',
      'x-csrf-token':csrfForSession(raw,key)},body:'{}'});
  assert.equal(logout.status,200);
  assert.equal((await fetch(base+'/api/me',{headers})).status,401);
});
