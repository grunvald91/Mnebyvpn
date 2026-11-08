import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('authenticated Telegram 24-hour VPN trial persists pending access once without consuming its time',async()=>{
 const url='postgresql://'+(process.env.PGUSER||'test')+':'+
   (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
   (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
 const pool=new Pool({connectionString:url});
 const secret='test_telegram_integration_secret';
 const digest=createHash('sha256').update(secret).digest('hex');
 const user=3988339901;
 const srv=createServer();
 await new Promise<void>(resolve=>srv.listen(0,'127.0.0.1',resolve));
 const address=srv.address();
 if(!address||typeof address==='string')throw Error('No port');
 const port=address.port;
 await new Promise<void>(resolve=>srv.close(()=>resolve()));
 const child=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-cabinet-server.ts'],{
  cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:['ignore','ignore','pipe'],
  env:{...process.env,MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'no',BOT_PORT:String(port),
   DATABASE_URL:url,TELEGRAM_WEBHOOK_SECRET_SHA256:digest},
 });
 let errors='';
 child.stderr?.on('data',(d:Buffer)=>errors+=d.toString());
 try{
  const prior=await pool.query("SELECT enabled FROM trial_offers WHERE product='vpn'");
  assert.equal(prior.rowCount,1);
  await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
  for(let i=0;i<50;i++){
   try{if((await fetch('http://127.0.0.1:'+port+'/readyz',{signal:AbortSignal.timeout(500)})).status===200)break;}catch{}
   if(i===49)throw Error('Server did not connect to database: '+errors);
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  const post=async(id:number)=>fetch('http://127.0.0.1:'+port+'/webhooks/telegram',{
   method:'POST',headers:{'Content-Type':'application/json',
    'X-Telegram-Bot-Api-Secret-Token':secret},
   body:JSON.stringify({update_id:id,callback_query:{id:'cb:'+id,from:{id:user},
     message:{chat:{type:'private',id:user},message_id:320},data:'trial:vpn'}}),
  });
  const first=await post(100);
  assert.equal(first.status,200);
  const a=await first.json() as any;
  assert.equal(a.method,'editMessageText');
  assert.match(a.text,/Заявка принята/);
  const second=await post(101);
  const b=await second.json() as any;
  assert.match(b.text,/Бот автоматически пришлёт инструкцию/);
  const res=await pool.query(`SELECT t.activated_at,t.access_expires_at,
    e.starts_at,e.expires_at,e.state FROM trial_grants t
    JOIN entitlements e ON e.source_order_id=t.order_id
    WHERE t.telegram_user_id=$1`,[String(user)]);
  assert.equal(res.rowCount,1);
  assert.equal(res.rows[0].activated_at,null);
  assert.equal(res.rows[0].access_expires_at,null);
  assert.equal(res.rows[0].starts_at,null);
  assert.equal(res.rows[0].expires_at,null);
  assert.equal(res.rows[0].state,'PAID_PENDING_PROVISIONING');
  const status=await fetch('http://127.0.0.1:'+port+'/webhooks/telegram',{
    method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},
    body:JSON.stringify({update_id:102,callback_query:{id:'cb:102',from:{id:user},
     message:{chat:{type:'private',id:user},message_id:320},data:'nav:status'}}),
  });
  assert.equal(status.status,200);
  const message=await status.json() as any;
  assert.match(message.text,/Ожидает выдачи доступа/);
 }finally{
  child.kill('SIGTERM');
  await pool.query("UPDATE trial_offers SET enabled=false WHERE product='vpn'").catch(()=>{});
  await pool.end();
 }
});
