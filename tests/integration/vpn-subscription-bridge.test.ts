import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {additionalNodeReceiptPayload,type AdditionalNodeReceipt}
  from '../../packages/provisioning/src/multi-node-subscriptions.ts';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {fileURLToPath} from 'node:url';
import {issueSubscriptionLink} from '../../packages/provisioning/src/subscription-links.ts';
import {germanWebSocketOnly}
  from '../../packages/provisioning/src/incy-subscription-presentation.ts';

test('public HTTPS subscription bridge serves only node-verified active bearer tokens',async()=>{
 const db='postgresql://'+(process.env.PGUSER||'test')+':'+
  (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
  (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
 const pool=new Pool({connectionString:db});
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const telegramUser=9148723127;
 const token='aa'.repeat(32);
 const credential='12222222-3333-4333-8333-555555555555';
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const verifyKey=publicKey.export({format:'der',type:'spki'}).toString('base64url');
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
       VPN_WORKER_PROFILE_TOKEN:token,
       VPN_ADDITIONAL_NODES_ENABLED:'yes',
       VPN_ADDITIONAL_NODE_VERIFY_KEY:verifyKey},
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
   const encodedResponse=await response.text();
   const fullBody=Buffer.from(encodedResponse.trim(),'base64').toString('utf8').trim();
   assert.ok(fullBody.includes('#profile-web-page-url: https://mnebyvpn.site'));
   assert.ok(fullBody.includes('#support-url: https://t.me/MNEBYVPN_bot?start=support'));
   assert.ok(fullBody.includes('#announce-url: https://mnebyvpn.site/#plans'));
   const decoded=fullBody.split('\n').filter(line=>!line.startsWith('#')).join('\n');
   const displayedWs=germanWebSocketOnly(profile);
   assert.equal(decoded,displayedWs);
   assert.equal(response.headers.get('profile-web-page-url'),'https://mnebyvpn.site');
   assert.equal(response.headers.get('premium-url'),'https://mnebyvpn.site/#plans');
   assert.equal(response.headers.get('homepage'),'https://mnebyvpn.site');
   assert.equal(Buffer.from((response.headers.get('profile-description')??'').replace(/^base64:/,''),'base64').toString('utf8'),
     'Оплата и продление: mnebyvpn.site');
   assert.equal(response.headers.get('support-url'),
     'https://t.me/MNEBYVPN_bot?start=support');
   assert.equal(response.headers.get('profile-update-interval'),'1');
   assert.equal(response.headers.get('subscription-userinfo'),
     'upload=0;download=0;total=0;expire='+
     Math.floor(issued!.expiresAt.getTime()/1000));
   // A node-verified fast profile can be offered without removing existing
   // websocket access. Both links must belong to the same user credential.
   const reality='vless://'+credential+
     '@cdn.servgo.ru:2053?encryption=none&security=reality&type=tcp'+
     '&flow=xtls-rprx-vision&sni=www.cloudflare.com&fp=chrome'+
     '&pbk='+('A'.repeat(43))+'&sid=ab12cd34ef56a789&spx=%2F#MNEBYVPN%20FAST';
   const firefox=reality.replace('&fp=chrome','&fp=firefox')
     .replace('#MNEBYVPN%20FAST','#MNEBYVPN%20Firefox%20TEST');
   const fastDial=reality.replace('@cdn.servgo.ru:2053','@89.125.90.101:2053');
   assert.equal(new URL(fastDial).hostname,'89.125.90.101');
   assert.equal(new URL(firefox).hostname,'cdn.servgo.ru');
   const fallback=profile;
   profile=[reality,firefox,fallback].join('\n');
   const legacyRefresh=await fetch(root+'/sub/'+issued!.token);
   assert.equal(legacyRefresh.status,200);
   assert.equal(Buffer.from((await legacyRefresh.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n'),displayedWs);
   const dual=await fetch(root+'/sub/'+issued!.token+'?client=incy');
   assert.equal(dual.status,200);
   assert.equal(dual.headers.get('premium-url'),'https://mnebyvpn.site/#plans');
   assert.equal(dual.headers.get('support-url'),
     'https://t.me/MNEBYVPN_bot?start=support');
   assert.equal(Buffer.from((await dual.text()).trim(),'base64').toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n'),displayedWs);
   const karing=await fetch(root+'/sub/'+issued!.token+'?client=karing');
   assert.equal(karing.status,200);
   assert.equal(karing.headers.get('premium-url'),'https://mnebyvpn.site/#plans');
   assert.equal(Buffer.from((await karing.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n'),displayedWs);
   assert.equal((await fetch(root+'/sub/'+issued!.token+'?client=other')).status,400);
   // Never publish a profile from an unexpected node, even on an authenticated
   // internal response.
   profile=[
     reality.replace('cdn.servgo.ru','wrong-host.example'),firefox,fallback,
   ].join('\n');
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,503);
   profile=[reality,firefox.replace('&fp=firefox','&fp=unsafe'),fallback].join('\n');
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,503);
   profile=[reality,reality,fallback].join('\n');
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,503);
   profile=[reality,firefox.replace('pbk='+('A'.repeat(43)),'pbk='+('B'.repeat(43))),fallback].join('\n');
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,503);
   profile=fallback;
   const single=await fetch(root+'/sub/'+issued!.token+'?client=karing');
   assert.equal(single.status,200);
   assert.equal(Buffer.from((await single.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n'),displayedWs);
   // Multi-country nodes appear only after the DB release gate, fresh verified
   // registry status, and a cryptographic grant for this SAME active entitlement.
   const current=await pool.query(
     'SELECT revision,expires_at FROM entitlements WHERE id=$1',[entitlement]);
   const revision=Number(current.rows[0].revision);
   const expiry=current.rows[0].expires_at as Date;
   const observedAt=new Date();
   const extras:AdditionalNodeReceipt[]=[
     ['de-node-02','DE','Германия'],
     ['nl-node-02','NL','Нидерланды'],
   ].map(([nodeId,country,countryName])=>{
     const endpoint=nodeId+'.nodes.example.net';
     return {
       node_id:nodeId,country_code:country,country_name_ru:countryName,
       endpoint_host:endpoint,endpoint_port:2053,state:'enabled',
       exit_country_proof_sha256:'a'.repeat(64),
       vpn_e2e_proof_sha256:'b'.repeat(64),
       verified_at:observedAt,entitlement_id:entitlement,revision,
       expires_at:expiry,observed_at:observedAt,
       profile_uri:'vless://'+credential+'@'+endpoint+':2053?encryption=none'+
         '&security=reality&type=tcp&flow=xtls-rprx-vision'+
         '&sni=www.cloudflare.com&fp=chrome&pbk='+('A'.repeat(43))+
         '&sid=ab12cd34ef56a789&spx=%2F',
       signature:'',
     };
   });
   // The web env flag was enabled from startup, but the DB release gate is
   // still false: existing clients cannot see staged endpoints.
   const notReleased=await fetch(root+'/sub/'+issued!.token);
   assert.equal(Buffer.from((await notReleased.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n'),displayedWs);
   for(const row of extras){
     await pool.query(
       'INSERT INTO vpn_additional_nodes(node_id,country_code,country_name_ru,'+
       'endpoint_host,endpoint_port,state,exit_country_proof_sha256,'+
       'vpn_e2e_proof_sha256,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
       [row.node_id,row.country_code,row.country_name_ru,row.endpoint_host,
        row.endpoint_port,row.state,row.exit_country_proof_sha256,
        row.vpn_e2e_proof_sha256,row.verified_at]);
     row.signature=sign(null,additionalNodeReceiptPayload(row),privateKey)
       .toString('base64url');
     await pool.query(
       'INSERT INTO vpn_additional_node_receipts(entitlement_id,node_id,'+
       'revision,expires_at,observed_at,profile_uri,signature) '+
       'VALUES($1,$2,$3,$4,$5,$6,$7)',
       [entitlement,row.node_id,row.revision,row.expires_at,row.observed_at,
        row.profile_uri,row.signature]);
   }
   await pool.query("UPDATE vpn_release_flags SET enabled=true WHERE feature='vpn_additional_nodes'");
   const withCountries=await fetch(root+'/sub/'+issued!.token);
   assert.equal(withCountries.status,200);
   const delivered=Buffer.from((await withCountries.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n').split('\n');
   assert.equal(delivered.length,2);
   assert.equal(decodeURIComponent(new URL(delivered[0]!).hash.slice(1)),
      'мне VPN Нидерланды');
   assert.equal(delivered[1],displayedWs);
   const forKaring=await fetch(root+'/sub/'+issued!.token+'?client=karing');
   assert.deepEqual(Buffer.from((await forKaring.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n').split('\n'),delivered);
   await pool.query("UPDATE vpn_additional_nodes SET state='degraded' WHERE node_id='nl-node-02'");
   const degraded=await fetch(root+'/sub/'+issued!.token);
   assert.equal(Buffer.from((await degraded.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n').split('\n').length,1);
   await pool.query(
     "UPDATE vpn_additional_node_receipts SET signature=$1 WHERE node_id='de-node-02'",
     ['0'.repeat(86)]);
   const tampered=await fetch(root+'/sub/'+issued!.token);
   assert.equal(Buffer.from((await tampered.text()).trim(),'base64')
     .toString('utf8').trim().split('\n').filter(line=>!line.startsWith('#')).join('\n'),displayedWs);
   await pool.query("UPDATE vpn_release_flags SET enabled=false WHERE feature='vpn_additional_nodes'");
   assert.equal((await fetch(root+'/sub/'+'B'.repeat(43))).status,404);
   const installer=await fetch(root+'/install/'+issued!.token+'?client=incy');
   assert.equal(installer.status,200);
   const page=await installer.text();
   assert.match(page,/Открыть в INCY/);
   assert.match(page,/vpn-install\.js/);
   assert.ok(page.includes(issued!.link));
   assert.match(page,/\?client=incy/);
   assert.equal((await fetch(root+'/install/'+issued!.token+'?client=bogus')).status,400);
   const script=await fetch(root+'/vpn-install.js');
   assert.equal(script.status,200);
   const installerJs=await script.text();
   assert.match(installerJs,/incy:\/\/import\//);
   assert.ok(installerJs.includes('window.location.assign(target)'));
   // A naturally expired entitlement must retain PUBLIC renewal navigation
   // without returning any of the (now invalid) VPN network credentials.
   await pool.query(
     "UPDATE entitlements SET state='EXPIRED', starts_at=now()-interval '2 days', expires_at=now()-interval '1 second' WHERE id=$1",
     [entitlement]);
   const expired=await fetch(root+'/sub/'+issued!.token);
   assert.equal(expired.status,200);
   assert.equal(expired.headers.get('premium-url'),'https://mnebyvpn.site/#plans');
   assert.equal(expired.headers.get('support-url'),
     'https://t.me/MNEBYVPN_bot?start=support');
   assert.equal(expired.headers.get('profile-web-page-url'),'https://mnebyvpn.site');
   assert.equal(expired.headers.get('announce-url'),'https://mnebyvpn.site/#plans');
   assert.equal(expired.headers.get('cache-control'),'no-store');
   const expiredText=Buffer.from((await expired.text()).trim(),'base64')
     .toString('utf8');
   assert.ok(expiredText.includes('#profile-web-page-url: https://mnebyvpn.site'));
   assert.ok(expiredText.includes('#support-url: https://t.me/MNEBYVPN_bot?start=support'));
   assert.doesNotMatch(expiredText,/vless:\/\/|vmess:\/\/|trojan:\/\/|amneziawg:\/\/|awg:\/\//);
   assert.equal((await fetch(root+'/sub/'+issued!.token+'?client=incy')).status,200);
   assert.equal((await fetch(root+'/sub/'+issued!.token+'?client=bad')).status,400);
   assert.equal((await fetch(root+'/install/'+issued!.token+'?client=incy')).status,404);

   // Renewal must not mint another bearer URL: same link works only after
   // reactivation and exact node provisioning ACK.
   await pool.query(
     "UPDATE entitlements SET state='ACTIVE', expires_at=now()+interval '1 day' WHERE id=$1",
     [entitlement]);
   await pool.query(
     "UPDATE provisioning_state SET applied_revision=(SELECT revision FROM entitlements WHERE id=$1),last_observed_at=now() WHERE entitlement_id=$1 AND adapter='vpn'",
     [entitlement]);
   const restored=await fetch(root+'/sub/'+issued!.token);
   assert.equal(restored.status,200);
   assert.equal(Buffer.from((await restored.text()).trim(),'base64')
     .toString('utf8').trim(),displayedWs);
   // Revoked links are not eligible for the expired-metadata exception.
   await pool.query('UPDATE vpn_subscription_links SET revoked_at=now() WHERE entitlement_id=$1',[entitlement]);
   assert.equal((await fetch(root+'/sub/'+issued!.token)).status,404);
 } finally {
   child?.kill('SIGTERM');
   await new Promise<void>(resolve=>worker.close(()=>resolve()));
   await pool.query("UPDATE vpn_release_flags SET enabled=false WHERE feature='vpn_additional_nodes'").catch(()=>{});
   await pool.query('DELETE FROM vpn_additional_node_receipts WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query("DELETE FROM vpn_additional_nodes WHERE node_id IN ('de-node-02','nl-node-02')").catch(()=>{});
   await pool.query('DELETE FROM vpn_subscription_links WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
   await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
   await pool.end();
 }
});
