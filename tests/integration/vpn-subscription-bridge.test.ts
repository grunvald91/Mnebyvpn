import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {fileURLToPath} from 'node:url';
import {issueSubscriptionLink} from '../../packages/provisioning/src/subscription-links.ts';

test('public HTTPS subscription bridge serves only node-verified active bearer tokens',async()=>{
 const db='postgresql://'+(process.env.PGUSER||'test')+':'+
  (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
  (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
 const pool=new Pool({connectionString:db});
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const telegramUser=9148723127;
 const token='aa'.repeat(32);
 const credential='12222222-3333-4333-8333-555555555555';
 let profile='vless://'+credential+'@cdn.servgo.ru:8443?encryption=none&security=tls&type=ws&host=cdn.servgo.ru&sni=cdn.servgo.ru&path=%2Fmnebyvpn-vpn%2Fws#Me';
 const worker=createServer(async(req,res)=>{
   if(req.url!=='/profile'||req.method!=='POST'||
      req.headers.authorization!=='Bearer '+token){
     res.writeHead(401).end('{}');return;
   }
   let raw='';
   for await(const c of req)raw+=String(c);
   const body=JSON.parse(raw);
   if(body.telegramUserId!==telegramUser||body.entitlementId!==entitlement){
     res.writeHead(403).end('{}');return;
   }
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({profile}));
 });
 const portSearch=createServer();
 await new Promise<void>(resolve=>portSearch.listen(0,'127.0.0.1',resolve));
 const addr=portSearch.address();
 if(!addr||typeof addr==='string')throw Error('No web port');
 const webPort=addr.port;
 await new Promise<void>(resolve=>portSearch.close(()=>resolve()));
 let child:ChildProcess|undefined;
 try {
   await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
     [account,String(telegramUser)]);
   await pool.query(
     "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
     "VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
   await pool.query(
     "INSERT INTO entitlements(id,account_id,source_order_id,product,state,"+
     "revision,starts_at,expires_at) "+
     "VALUES($1,$2,$3,'vpn','ACTIVE',2,now(),now()+interval '24 hours')",
     [entitlement,account,order]);
   await pool.query(
     "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,"+
     "fencing_token,last_observed_at) VALUES($1,'vpn',2,2,now())",[entitlement]);
   const issued=await issueSubscriptionLink(pool,telegramUser);
   assert.ok(issued);
   await new Promise<void>((resolve,reject)=>{
     worker.once('error',reject);
     worker.listen(8794,'127.0.0.1',resolve);
   });
   child=spawn(process.execPath,['--experimental-strip-types',
     'apps/web/src/server.ts'],{
     cwd:fileURLToPath(new URL('../../',import.meta.url)),
     stdio:'ignore',
     // The website's own database intentionally has NO VPN subscription
     // table; only the separately connected bot database does.
     env:{...process.env,
       DATABASE_URL:db.replace(/\/mnebyvpn_test$/, '/postgres'),
       VPN_SUBSCRIPTION_DATABASE_URL:db,
       WEB_BASE_URL:'http://127.0.0.1:'+webPort,
       WEB_PORT:String(webPort),MNEBYVPN_ENV:'offline-test',
       WEB_SESSION_SECRET:'A'.repeat(64),
       VPN_WORKER_PROFILE_TOKEN:token},
   });
   const root='http://127.0.0.1:'+webPort;
   for(let i=0;i<45;i++){
     try{
       if((await fetch(root+'/healthz',{signal:AbortSignal.timeout(400)})).ok)
         break;
     }catch{}
     if(i===44)throw Error('Web app failed to start');
     await new Promise(resolve=>setTimeout(resolve,100));
   }
   const response=await fetch(root+'/sub/'+issued!.token);
   assert.equal(response.status,200);
   assert.match(response.headers.get('content-type')??'',/text\/plain/);
   assert.equal(response.headers.get('cache-control'),'no-store');
   const decoded=Buffer.from((await response.text()).trim(),'base64').toString('utf8').trim();
   assert.equal(decoded,profile);
   // A node-verified fast profile can be offered without removing existing
   // websocket access. Both links must belong to the same user credential.
   const reality='vless://'+credential+
     '@cdn.servgo.ru:2053?encryption=none&security=reality&type=tcp'+
     '&flow=xtls-rprx-vision&sni=www.cloudflare.com&fp=chrome'+
     '&pbk='+('A'.repeat(43))+'&sid=ab12cd34ef56a789&spx=%2F#MNEBYVPN%20FAST';
   const fallback=profile;
   profile=reality+'\\n'+fallback;
   const dual=await fetch(root+'/sub/'+issued!.token);
   assert.equal(dual.status,200);
   assert.equal(Buffer.from((await dual.text()).trim(),'base64').toString('utf8').trim(),
     reality+'\\n'+fallback);
   // Never publish a profile from an unexpected node, even on an authenticated
   // internal response.
   profile=reality.replace('cdn.servgo.ru','wrong-host.example')+'\\n'+fallback;
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,503);
   profile=fallback;
   assert.equal((await fetch(root+'/sub/'+'B'.repeat(43))).status,404);
   const installer=await fetch(root+'/install/'+issued!.token+'?client=incy');
   assert.equal(installer.status,200);
   const page=await installer.text();
   assert.match(page,/Открыть в INCY/);
   assert.match(page,/vpn-install\.js/);
   assert.ok(page.includes(issued!.link));
   assert.equal((await fetch(root+'/install/'+issued!.token+'?client=bogus')).status,400);
   const script=await fetch(root+'/vpn-install.js');
   assert.equal(script.status,200);
   const installerJs=await script.text();
   assert.match(installerJs,/incy:\/\/import\//);
   assert.ok(installerJs.includes('window.location.assign(target)'));
   await pool.query("UPDATE entitlements SET state='EXPIRED' WHERE id=$1",[entitlement]);
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,404);
   assert.equal((await fetch(root+'/install/'+issued!.token+'?client=incy')).status,404);
 } finally {
   child?.kill('SIGTERM');
   await new Promise<void>(resolve=>worker.close(()=>resolve()));
   await pool.query('DELETE FROM vpn_subscription_links WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
   await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
   await pool.end();
 }
});
