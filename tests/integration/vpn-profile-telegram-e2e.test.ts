import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {fileURLToPath} from 'node:url';

test('signed Telegram connect reveals a profile only to the confirmed owner',async()=>{
 const url='postgresql://'+(process.env.PGUSER||'test')+':'+
  (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
  (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
 const pool=new Pool({connectionString:url});
 const user=3924443388;
 const account='badd1000-0000-4000-8000-000000000001';
 const order='badd1000-0000-4000-8000-000000000002';
 const ent='badd1000-0000-4000-8000-000000000003';
 const username='mb_'+ent.replaceAll('-','');
 const link='https://subs.example.test/personal/test-token';
 const token='test_telegram_signed_vpn';
 const digest=createHash('sha256').update(token).digest('hex');
 const apiToken='synthetic_remnawave_api_token_long';
 let expiry=new Date(Date.now()+22*3600_000).toISOString();
 let remoteRevision=2;
 const panel=createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+apiToken||
     req.method!=='GET'||req.url!=='/api/users/by-username/'+username){
    res.writeHead(403).end('{}');return;
  }
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({response:{id:10,username,status:'ACTIVE',
   expireAt:expiry,description:'mnebyvpn:'+ent+':rev:'+remoteRevision,
   subscriptionUrl:link}}));
 });
 await new Promise<void>(resolve=>panel.listen(0,'127.0.0.1',resolve));
 const panelAddress=panel.address();
 if(!panelAddress||typeof panelAddress==='string')throw Error('Panel port');
 const spare=createServer();
 await new Promise<void>(resolve=>spare.listen(0,'127.0.0.1',resolve));
 const spareAddress=spare.address();
 if(!spareAddress||typeof spareAddress==='string')throw Error('Bot port');
 const port=spareAddress.port;
 await new Promise<void>(resolve=>spare.close(()=>resolve()));
 let child:ChildProcess|undefined;
 try{
  await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
    [account,String(user)]);
  await pool.query(
   `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')`,[order,account]);
  await pool.query(
   `INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at)
    VALUES($1,$2,$3,'vpn','ACTIVE',2,now()-interval '2 hours',$4)`,
    [ent,account,order,expiry]);
  await pool.query(
   `INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,fencing_token,last_observed_at)
     VALUES($1,'vpn',2,2,now())`,[ent]);
  child=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-cabinet-server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:'ignore',
    env:{...process.env,MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'no',
      BOT_PORT:String(port),DATABASE_URL:url,
      TELEGRAM_WEBHOOK_SECRET_SHA256:digest,
      REMNAWAVE_API_URL:'http://127.0.0.1:'+panelAddress.port+'/',
      REMNAWAVE_READ_API_TOKEN:apiToken,
      VPN_SUBSCRIPTION_ORIGIN:'https://subs.example.test/',
      REMNAWAVE_SQUAD_UUIDS:'123e4567-e89b-42d3-a456-426614174000'}
  });
  for(let i=0;i<50;i++){
    try{
      if((await fetch('http://127.0.0.1:'+port+'/readyz',{
        signal:AbortSignal.timeout(400)})).ok)break;
    }catch{}
    if(i===49)throw Error('Bot server not ready');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const update=async(actor:number,secret=token)=>{
    const r=await fetch('http://127.0.0.1:'+port+'/webhooks/telegram',{
      method:'POST',headers:{'Content-Type':'application/json',
        'X-Telegram-Bot-Api-Secret-Token':secret},
      body:JSON.stringify({update_id:Math.floor(Math.random()*1000000),
        callback_query:{id:'synthetic',from:{id:actor},
        message:{chat:{type:'private',id:actor},message_id:7},data:'nav:connect'}})});
    return r;
  };
  const other=await update(user+1);
  const otherMessage=await other.json() as any;
  assert.equal(other.status,200);
  assert.ok(!JSON.stringify(otherMessage).includes(link));
  const own=await update(user);
  assert.equal(own.status,200);
  const profile=await own.json() as any;
  assert.equal(profile.method,'editMessageText');
  assert.ok(profile.reply_markup.inline_keyboard.some((row:any[])=>row.some(b=>b.url===link)));
  remoteRevision=3;
  const mismatched=await (await update(user)).json() as any;
  assert.ok(!JSON.stringify(mismatched).includes(link));
  remoteRevision=2;
  await pool.query('UPDATE provisioning_state SET applied_revision=1 WHERE entitlement_id=$1',[ent]);
  const stale=await (await update(user)).json() as any;
  assert.ok(!JSON.stringify(stale).includes(link));
  const unauth=await update(user,'wrong-token');
  assert.equal(unauth.status,401);
 }finally{
  child?.kill('SIGTERM');
  await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM entitlements WHERE id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  await new Promise<void>(resolve=>panel.close(()=>resolve()));
  await pool.end();
 }
});
