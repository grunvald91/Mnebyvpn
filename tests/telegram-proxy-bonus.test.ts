import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBonusRoutes,parseOwnerProxyRoutes,sealProxySecret,openProxySecret,
  makeBonusLinks,makeOwnerProxyLinks,
  loadCustomerProxyBonus,bonusReleaseReady,ownerProxyReleaseReady,
  parseWsProxyRoutes,wsProxyReleaseReady,makeWsProxyLinks,loadCustomerWsProxy,loadSharedTrialWsProxy,trialRegionalProxyLinks,loadSharedTrialCountryProxy,sharedTrialProxyInstructions,sharedTrialProxyParameters,
} from '../packages/web/src/telegram-proxy-bonus.ts';

const id='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const name='dns_0123456789abcdef01234567';
const key='a'.repeat(64);
const raw='1234567890abcdef1234567890abcdef';
const routes=[
  {route:'direct' as const,host:'89.125.90.101',port:9446},
  {route:'ru' as const,host:'188.120.254.223',port:8443},
];
test('exactly two non-443 distinct public routes are required',()=>{
  assert.deepEqual(parseBonusRoutes(JSON.stringify(routes)),routes);
  for(const malformed of [
    '', '{', '[]',
    JSON.stringify([{...routes[0]}]),
    JSON.stringify([{...routes[0]},{...routes[0]}]),
    JSON.stringify([{...routes[0],port:443},routes[1]]),
    JSON.stringify([{...routes[0],host:'127.0.0.1'},routes[1]]),
    JSON.stringify([{...routes[0],port:0},routes[1]]),
    JSON.stringify([{...routes[0],evil:'secret'},routes[1]]),
  ])assert.equal(parseBonusRoutes(malformed),null);
});
test('verified owner route is exactly one direct :9446; public still needs two',()=>{
  const privateRoutes=[routes[0]];
  assert.deepEqual(parseOwnerProxyRoutes(JSON.stringify(privateRoutes)),privateRoutes);
  assert.equal(parseBonusRoutes(JSON.stringify(privateRoutes)),null);
  const links=makeOwnerProxyLinks(raw,'xapi.ozon.ru',privateRoutes);
  assert.equal(links.length,1);
  const direct=new URL(links[0].url);
  assert.equal(direct.hostname,'t.me');
  assert.equal(direct.pathname,'/proxy');
  assert.equal(direct.searchParams.get('server'),'89.125.90.101');
  assert.equal(direct.searchParams.get('port'),'9446');
  assert.equal(direct.searchParams.get('secret'),'ee'+raw+
    Buffer.from('xapi.ozon.ru','utf8').toString('hex'));
  for(const bad of [
    routes, [routes[1]], [{...routes[0],port:8443}],
    [{...routes[0],host:'188.120.254.223'}],
    [{...routes[0],host:'127.0.0.1'}],
    [{...routes[0],extra:'unsafe'}], [],
  ]){
    assert.equal(parseOwnerProxyRoutes(JSON.stringify(bad)),null);
    assert.throws(()=>makeOwnerProxyLinks(raw,'xapi.ozon.ru',bad as never));
  }
  assert.throws(()=>makeBonusLinks(raw,'xapi.ozon.ru',privateRoutes),
    /Unverified MTProxy routes/);
});
test('AES-GCM MTProxy secret is bound to entitlement and username',()=>{
  const box=sealProxySecret(raw,key,id,name);
  assert.match(box,/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!box.includes(raw));
  assert.equal(openProxySecret(box,key,id,name),raw);
  assert.throws(()=>openProxySecret(box,key,other,name));
  assert.throws(()=>openProxySecret(box,'b'.repeat(64),id,name));
  assert.throws(()=>openProxySecret(box,key,id,'dns_ffffffffffffffffffffffff'));
  assert.throws(()=>openProxySecret(box.slice(0,-2)+'aa',key,id,name));
  assert.throws(()=>sealProxySecret('not-a-secret',key,id,name));
});
test('two Telegram links include host, port and correct EE FakeTLS domain',()=>{
  const links=makeBonusLinks(raw,'media.bandbook.site',routes);
  assert.equal(links.length,2);
  for(const entry of links){
    const url=new URL(entry.url);
    const tg=new URL(entry.tgUrl);
    assert.equal(url.hostname,'t.me');
    assert.equal(url.pathname,'/proxy');
    assert.equal(tg.protocol,'tg:');
    assert.equal(url.searchParams.get('server'),entry.host);
    assert.equal(url.searchParams.get('port'),String(entry.port));
    assert.equal(url.searchParams.get('secret'),
      'ee'+raw+Buffer.from('media.bandbook.site').toString('hex'));
    assert.equal(tg.searchParams.get('secret'),url.searchParams.get('secret'));
  }
});
test('owner-only Telemt release requires separate route and revoker attestations',()=>{
  const env={
    MNEBYVPN_OFFLINE_MTPROXY_ISSUE_ENABLED:'yes',
    MNEBYVPN_OFFLINE_MTPROXY_ROUTES_VERIFIED:'yes',
    MNEBYVPN_OFFLINE_MTPROXY_REVOKER_VERIFIED:'yes',
    WEB_DNS_MT_PROXY_BONUS_KEY:key,
    MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON:JSON.stringify([routes[0]]),
  };
  assert.equal(ownerProxyReleaseReady({}),false);
  assert.equal(ownerProxyReleaseReady(env),true);
  for(const k of [
    'MNEBYVPN_OFFLINE_MTPROXY_ISSUE_ENABLED',
    'MNEBYVPN_OFFLINE_MTPROXY_ROUTES_VERIFIED',
    'MNEBYVPN_OFFLINE_MTPROXY_REVOKER_VERIFIED',
    'WEB_DNS_MT_PROXY_BONUS_KEY',
    'MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON',
  ]){
    assert.equal(ownerProxyReleaseReady({...env,[k]:''}),false,k);
  }
  assert.equal(bonusReleaseReady(env),false,'public sale must remain gated');
});
test('owner release never accepts unverified RU or public two-route settings',()=>{
  const privateEnv={
    MNEBYVPN_OFFLINE_MTPROXY_ISSUE_ENABLED:'yes',
    MNEBYVPN_OFFLINE_MTPROXY_ROUTES_VERIFIED:'yes',
    MNEBYVPN_OFFLINE_MTPROXY_REVOKER_VERIFIED:'yes',
    WEB_DNS_MT_PROXY_BONUS_KEY:key,
    MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON:JSON.stringify([routes[0]]),
  };
  assert.equal(ownerProxyReleaseReady(privateEnv),true);
  assert.equal(ownerProxyReleaseReady({
    ...privateEnv,MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON:JSON.stringify(routes),
  }),false);
  assert.equal(ownerProxyReleaseReady({
    ...privateEnv,MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON:JSON.stringify([routes[1]]),
  }),false);
  assert.equal(ownerProxyReleaseReady({
    ...privateEnv,MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON:undefined,
    WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON:JSON.stringify(routes),
  }),false);
  assert.equal(bonusReleaseReady(privateEnv),false);
});
test('release fails closed unless real E2E and revocation are both attested',()=>{
  const env={
    WEB_DNS_MT_PROXY_BONUS_ENABLED:'yes',
    WEB_DNS_MT_PROXY_BONUS_E2E_VERIFIED:'yes',
    WEB_DNS_MT_PROXY_BONUS_REVOKER_VERIFIED:'yes',
    WEB_DNS_MT_PROXY_BONUS_KEY:key,
    WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON:JSON.stringify(routes),
  };
  assert.equal(bonusReleaseReady({}),false);
  assert.equal(bonusReleaseReady({...env,WEB_DNS_MT_PROXY_BONUS_REVOKER_VERIFIED:'no'}),false);
  assert.equal(bonusReleaseReady({...env,WEB_DNS_MT_PROXY_BONUS_KEY:''}),false);
  assert.equal(bonusReleaseReady({...env,WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON:'[]'}),false);
  assert.equal(bonusReleaseReady(env),true);
});
test('customer secret delivery is backed by paid, active, owned DNS entitlement query',async()=>{
  const box=sealProxySecret(raw,key,other,name);
  let called=0;
  const db={async query(sql:string,values:unknown[]){
    called++;
    assert.match(sql,/e\.account_id=\$1 AND e\.id=\$2/);
    assert.match(sql,/e\.product=\$3/);
    assert.match(sql,/e\.state=\$4/);
    assert.match(sql,/o\.state=\$5/);
    assert.match(sql,/o\.product IN \(\$3,\$6\)/);
    assert.match(sql,/e\.expires_at>clock_timestamp\(\)/);
    assert.match(sql,/b\.verified_at/);
    assert.deepEqual(values,[id,other,'smart_dns','ACTIVE','PAID','bundle',10080]);
    return {rows:[{
      entitlement_id:other,telemt_username:name,secret_box:box,
      tls_domain:'media.bandbook.site',expires_at:new Date('2026-12-12T00:00:00Z'),
    }]};
  }};
  const result=await loadCustomerProxyBonus(db as never,id,other,key,routes);
  assert.equal(called,1);
  assert.equal(result?.links.length,2);
  assert.equal(result?.expiresAt,'2026-12-12T00:00:00.000Z');
  const none=await loadCustomerProxyBonus({query:async()=>({rows:[]})} as never,id,other,key,routes);
  assert.equal(none,null);
  assert.equal(await loadCustomerProxyBonus(db as never,id,'not-a-uuid',key,routes),null);
  assert.equal(called,1);
});

test('WebSocket proxy validates routes, encodes 0x70 marked token and enforces paid smart_dns ownership',async()=>{
  const wsRoutes=[
    {route:'ru' as const,server:'bandbook.site/6omdaevzovf3lisy',secret:raw},
    {route:'direct' as const,server:'cdn.servgo.ru/c3hhpzagkvw7oo3o',secret:'dd'+raw},
  ];
  const parsed=parseWsProxyRoutes(JSON.stringify(wsRoutes));
  assert.equal(parsed?.length,2);
  assert.equal(parseWsProxyRoutes('[]'),null);
  assert.equal(parseWsProxyRoutes(JSON.stringify([{route:'ru',server:'127.0.0.1/abc',secret:raw}])),null);
  assert.equal(parseWsProxyRoutes(JSON.stringify([{route:'ru',server:'bandbook.site/abc',secret:'bad'}])),null);

  const wsEnv={
    WEB_TELEGRAM_WS_PROXY_ENABLED:'yes',
    WEB_TELEGRAM_WS_PROXY_ROUTES_JSON:JSON.stringify(wsRoutes),
  };
  assert.equal(wsProxyReleaseReady({}),false);
  assert.equal(wsProxyReleaseReady(wsEnv),true);

  const links=makeWsProxyLinks(wsRoutes);
  assert.equal(links.length,2);
  const expectedMarked=Buffer.concat([Buffer.from([0x70]),Buffer.from(raw,'hex')]).toString('base64url');
  for(const l of links){
    assert.equal(l.kind,'webproxy');
    assert.ok(l.url.startsWith('https://t.me/webproxy?'));
    assert.ok(l.tgUrl.startsWith('tg://webproxy?'));
    const u=new URL(l.url);
    assert.equal(u.searchParams.get('server'),l.server);
    assert.equal(u.searchParams.get('secret'),expectedMarked);
  }

  let calls=0;
  const db={async query(sql:string,values:unknown[]){
    calls++;
    assert.match(sql,/e\.account_id=\$1 AND e\.id=\$2/);
    assert.match(sql,/o\.state=\$5/);
    assert.deepEqual(values,[id,other,'smart_dns','ACTIVE','PAID','bundle']);
    return {rows:[{expires_at:new Date('2026-12-20T00:00:00Z')}]};
  }};
  const res=await loadCustomerWsProxy(db as never,id,other,wsRoutes);
  assert.equal(calls,1);
  assert.equal(res?.wsLinks.length,2);
  assert.equal(res?.expiresAt,'2026-12-20T00:00:00.000Z');
  assert.equal(await loadCustomerWsProxy(db as never,id,'invalid-uuid',wsRoutes),null);
  assert.equal(calls,1);
});

test('shared bundle trial proxy remains available without an expiry or personal MTProto credential',async()=>{
 const routes=parseWsProxyRoutes(JSON.stringify([{route:'direct',server:'example.org/shared',secret:'a'.repeat(32)}]));
 assert.ok(routes);
 let eligible=true,calls=0;
 const db={async query(sql:string,values:unknown[]){
   calls++;
   assert.match(sql,/t\.account_id=\$1/);
   assert.match(sql,/t\.product='bundle'/);
   assert.match(sql,/o\.provider='internal_trial'/);
   assert.match(sql,/o\.state='TRIAL'/);
   assert.doesNotMatch(sql,/expires_at|dns_mtproxy_bonus_credentials/);
   assert.equal(values.length,1);
   return {rows:eligible?[{ok:1}]:[]};
 }};
 const account='11111111-1111-4111-8111-111111111111';
 const result=await loadSharedTrialWsProxy(db as never,account,routes);
 assert.equal(result?.wsLinks.length,1);
 assert.deepEqual(Object.keys(result??{}),['wsLinks']);
 eligible=false;
 assert.equal(await loadSharedTrialWsProxy(db as never,account,routes),null);
 assert.equal(await loadSharedTrialWsProxy(db as never,'invalid',routes),null);
 assert.equal(calls,2);
});

test('trial country proxy routes require explicit independent verification and trial ownership',async()=>{
 const route=(server:string)=>JSON.stringify([{route:'ru',server,secret:raw}]);
 const env={
  WEB_TELEGRAM_WS_PROXY_ENABLED:'yes',
  WEB_TELEGRAM_WS_PROXY_ROUTES_JSON:route('shared.example.org/path'),
  WEB_TRIAL_WS_PROXY_DE_ROUTES_JSON:route('de.example.org/path'),
  WEB_TRIAL_WS_PROXY_FI_ROUTES_JSON:route('fi.example.org/path'),
  WEB_TRIAL_WS_PROXY_DE_VERIFIED:'yes',
  WEB_TRIAL_WS_PROXY_FI_VERIFIED:'yes',
 };
 assert.deepEqual(trialRegionalProxyLinks(env).map(l=>l.country),['DE','FI']);
 assert.deepEqual(trialRegionalProxyLinks({...env,WEB_TRIAL_WS_PROXY_FI_VERIFIED:'no'}).map(l=>l.country),['DE']);
 assert.deepEqual(trialRegionalProxyLinks({...env,WEB_TRIAL_WS_PROXY_FI_ROUTES_JSON:env.WEB_TRIAL_WS_PROXY_DE_ROUTES_JSON}),[]);
 assert.deepEqual(trialRegionalProxyLinks({...env,WEB_TELEGRAM_WS_PROXY_ENABLED:'no'}),[]);
 const yes={query:async()=>({rows:[{ok:1}]})};
 const no={query:async()=>({rows:[]})};
 const allowed=await loadSharedTrialCountryProxy(yes as never,id,env);
 assert.equal(allowed?.regionalLinks.length,2);
 assert.equal(allowed?.wsLinks.length,1);
 assert.equal(await loadSharedTrialCountryProxy(no as never,id,env),null);
});

test('trial proxy instructions preserve the complete WebSocket path and separate HTTPS link from manual secret',()=>{
 const link=makeWsProxyLinks([{route:'ru',server:'example.org/testpath',secret:raw}])[0];
 const manual=sharedTrialProxyParameters(link);
 assert.ok(manual.includes('Название: '+link.label));
 assert.ok(manual.includes('Сервер: example.org/testpath'));
 assert.ok(manual.includes('Порт: 443 (HTTPS)'));
 assert.ok(manual.includes('Секрет: '+raw));
 assert.match(sharedTrialProxyInstructions,/Избранное/);
 assert.match(sharedTrialProxyInstructions,/если есть отдельное поле порта/);
 assert.match(sharedTrialProxyInstructions,/не отключаются по окончании/);
 const env={
  WEB_TELEGRAM_WS_PROXY_ENABLED:'yes',
  WEB_TELEGRAM_WS_PROXY_ROUTES_JSON:JSON.stringify([{route:'ru',server:'shared.example.org/path',secret:raw}]),
  WEB_TRIAL_WS_PROXY_DE_VERIFIED:'yes',WEB_TRIAL_WS_PROXY_FI_VERIFIED:'yes',
  WEB_TRIAL_WS_PROXY_DE_ROUTES_JSON:JSON.stringify([{route:'ru',server:'example.org/testpath',secret:raw}]),
  WEB_TRIAL_WS_PROXY_FI_ROUTES_JSON:JSON.stringify([{route:'direct',server:'EXAMPLE.ORG/testpath',secret:'b'.repeat(32)}]),
 };
 assert.deepEqual(trialRegionalProxyLinks(env),[]);
});
