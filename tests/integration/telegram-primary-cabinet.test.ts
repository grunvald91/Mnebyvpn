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
 const user=3988339901,bundleUser=3988339902;
 const priorOffers=await pool.query("SELECT product,enabled,dns_quota_bytes FROM trial_offers WHERE product IN ('vpn','bundle')");
 const srv=createServer();
 await new Promise<void>(resolve=>srv.listen(0,'127.0.0.1',resolve));
 const address=srv.address();
 if(!address||typeof address==='string')throw Error('No port');
 const port=address.port;
 await new Promise<void>(resolve=>srv.close(()=>resolve()));
 const child=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-cabinet-server.ts'],{
  cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:['ignore','ignore','pipe'],
  env:{...process.env,MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'no',BOT_PORT:String(port),
   DATABASE_URL:url,TELEGRAM_WEBHOOK_SECRET_SHA256:digest,
   WEB_TELEGRAM_WS_PROXY_ENABLED:'yes',WEB_TELEGRAM_WS_PROXY_ROUTES_JSON:JSON.stringify([{route:'direct',server:'example.org/shared',secret:'a'.repeat(32)}])},
 });
 let errors='';
 child.stderr?.on('data',(d:Buffer)=>errors+=d.toString());
 try{
  const prior=await pool.query("SELECT enabled FROM trial_offers WHERE product='vpn'");
  assert.equal(prior.rowCount,1);
  await pool.query("UPDATE trial_offers SET enabled=(product='vpn') WHERE product IN ('vpn','bundle')");
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
  await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='bundle'");
  const bundlePost=async(id:number,data:string,actor=bundleUser)=>{
    const response=await fetch('http://127.0.0.1:'+port+'/webhooks/telegram',{
      method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},
      body:JSON.stringify({update_id:id,callback_query:{id:'cb:'+id,from:{id:actor},message:{chat:{type:'private',id:actor},message_id:321},data}})
    });
    assert.equal(response.status,200);
    return await response.json() as any;
  };
  const bundle=await bundlePost(103,'trial:vpn');
  assert.match(bundle.text,/«3 в 1»/);
  assert.match(bundle.text,/Заявка принята/);
  assert.match((await bundlePost(104,'trial:smart_dns')).text,/подключается/);
  const canonical=await pool.query("SELECT t.order_id,t.product AS trial_product,t.activated_at,e.product,e.state FROM trial_grants t JOIN entitlements e ON e.source_order_id=t.order_id WHERE t.telegram_user_id=$1",[String(bundleUser)]);
  assert.equal(canonical.rowCount,2);
  assert.deepEqual(canonical.rows.map(x=>x.product).sort(),['smart_dns','vpn']);
  assert.ok(canonical.rows.every(x=>x.trial_product==='bundle'&&x.activated_at===null&&x.state==='PAID_PENDING_PROVISIONING'));
  assert.equal(new Set(canonical.rows.map(x=>x.order_id)).size,1);
  const proxy=await bundlePost(105,'nav:trial-proxy');
  assert.ok(proxy.reply_markup.inline_keyboard.flat().some((b:any)=>b.url?.startsWith('https://t.me/webproxy?')));
  const oldProxy=await bundlePost(106,'nav:trial-proxy',user);
  assert.ok(!oldProxy.reply_markup.inline_keyboard.flat().some((b:any)=>b.url?.startsWith('https://t.me/webproxy?')));
  // The proxy is deliberately not limited by the VPN/DNS trial deadline.
  await pool.query("UPDATE trial_grants SET activated_at=statement_timestamp()-interval '25 hours',access_expires_at=statement_timestamp()-interval '1 hour' WHERE order_id=$1",[canonical.rows[0].order_id]);
  assert.ok((await bundlePost(107,'nav:trial-proxy')).reply_markup.inline_keyboard.flat().some((b:any)=>b.url?.startsWith('https://t.me/webproxy?')));
 }finally{
  child.kill('SIGTERM');
  for(const offer of priorOffers.rows)await pool.query('UPDATE trial_offers SET enabled=$2,dns_quota_bytes=$3 WHERE product=$1',[offer.product,offer.enabled,offer.dns_quota_bytes]).catch(()=>{});
  await pool.end();
 }
});
