import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBonusRoutes,sealProxySecret,openProxySecret,makeBonusLinks,
  loadCustomerProxyBonus,bonusReleaseReady,
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
    assert.deepEqual(values,[id,other,'smart_dns','ACTIVE','PAID','bundle']);
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
