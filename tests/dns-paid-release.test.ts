import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isDnsSalesEnabled} from '../packages/billing/src/dns-paid-release.ts';

test('DNS paid sales use exactly one optional operator switch',()=>{
  assert.equal(isDnsSalesEnabled({}),false);
  assert.equal(isDnsSalesEnabled({MNEBYDNS_PAID_SALES_ENABLED:'no'}),false);
  assert.equal(isDnsSalesEnabled({MNEBYDNS_PAID_SALES_ENABLED:'1'}),false);
  assert.equal(isDnsSalesEnabled({MNEBYDNS_PAID_SALES_ENABLED:'yes'}),true);
});

test('website and central billing store rely on same single DNS switch',()=>{
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const store=readFileSync(new URL('../packages/billing/src/store.ts',import.meta.url),'utf8');
  assert.match(server,/dnsPaidCheckoutEnabled = checkoutEnabled && isDnsSalesEnabled\(process\.env\)/);
  assert.match(server,/publishedPlans=dnsPaidCheckoutEnabled\?plans:plans\.filter\(p=>p\.product==='vpn'\)/);
  assert.match(server,/trialOffers: dnsPaidCheckoutEnabled\?trialOffers:trialOffers\.filter\(p=>p==='vpn'\)/);
  assert.match(server,/plan&&plan\.product!=='vpn'/);
  assert.match(server,/DNS_PAID_NOT_READY/);
  assert.match(store,/if \(p\.product!=='vpn' &&/);
  assert.match(store,/if \(order\.product!=='vpn' &&/);
  assert.match(store,/if\(product!=='vpn' &&/);
  assert.match(store,/isDnsSalesEnabled\(process\.env\)/);
  for(const value of [server,store]){
    assert.doesNotMatch(value,/WEB_DNS_PAID_[A-Z_]+/);
    assert.doesNotMatch(value,/paidSmartDnsCheckoutReady/);
  }
});

test('checkout checks DNS operator switch before provider order creation',()=>{
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const checkout=server.indexOf("url.pathname === '/api/checkout'");
  const denied=server.indexOf("if(!dnsPaidCheckoutEnabled){",checkout);
  const payment=server.indexOf('prepareWebsiteProdamusCheckout(',checkout);
  assert.ok(checkout<denied && denied<payment,'DNS sales toggle must be read before payment order');
});

test('replayed DNS request uses one switch before creating new invoice',async()=>{
  const {PgBillingStore}=await import('../packages/billing/src/store.ts');
  const priorSwitch=process.env.MNEBYDNS_PAID_SALES_ENABLED;
  delete process.env.MNEBYDNS_PAID_SALES_ENABLED;
  const buyer='11111111-1111-4111-8111-111111111112';
  const oid='11111111-1111-4111-8111-111111111111';
  const requests:string[]=[];
  const mockClient={
    query:async(sql:string)=>{
      requests.push(sql);
      if(sql==='BEGIN'||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock'))
        return {rowCount:0,rows:[]};
      if(sql.includes('FROM checkout_requests WHERE'))
        return {rowCount:1,rows:[{order_id:oid}]};
      if(sql.includes('FROM orders o JOIN order_terms t'))
        return {rowCount:1,rows:[{
          id:oid,account_id:buyer,provider:'prodamus',currency:'RUB',
          amount_minor:'20000',product:'smart_dns',state:'PENDING',
          plan_id:'dns-month',plan_title:'DNS месяц',duration_seconds:2592000,
          dns_quota_bytes:'1000000',expires_at:new Date('2026-12-12'),
          telegram_user_id:null,
        }]};
      throw new Error('Unexpected DB operation after DNS off: '+sql.slice(0,40));
    },
    release:()=>{},
  };
  const store=new PgBillingStore({connect:async()=>mockClient} as never);
  try {
    await assert.rejects(()=>store.createWebsiteOrder(buyer,'dns-month','repeat-request'),
      /DNS_PAID_NOT_READY/);
    assert.ok(requests.some(x=>x==='ROLLBACK'));
    assert.ok(!requests.some(x=>x.includes('INSERT INTO orders')));
  } finally {
    if(priorSwitch===undefined)delete process.env.MNEBYDNS_PAID_SALES_ENABLED;
    else process.env.MNEBYDNS_PAID_SALES_ENABLED=priorSwitch;
  }
});


test('DNS and bundle browser flow follows server-published products, not a second development flag',()=>{
  const app=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  const wizard=readFileSync(new URL('../apps/web/public/journey.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(app,/const inDevelopment=state\.product!=='vpn'/);
  assert.match(app,/buy\.disabled=!plan\|\|!state\.checkoutEnabled\|\|state\.busy/);
  assert.match(app,/document\.querySelectorAll\('\[data-product\]'\)\.forEach\(button=>/);
  assert.match(app,/button\.disabled=!offered/);
  assert.doesNotMatch(app,/state\.product!=='vpn'\|\|!plan/);
  assert.match(app,/const payload=\{product:state\.product\}/);
  assert.match(wizard,/const p=state\.plans\.find\(p=>p\.product===state\.product/);
  assert.match(wizard,/landing\.querySelectorAll\('\[data-journey-product\]'\)/);
  assert.match(wizard,/setSelection\(product,term\)/);
  assert.doesNotMatch(wizard,/if\(state\.product!=='vpn'\)setSelection\('vpn'/);
  assert.match(html,/data-journey-product="smart_dns"/);
  assert.match(html,/data-journey-product="bundle"/);
  assert.doesNotMatch(html,/DNS · скоро/);
  assert.doesNotMatch(html,/Совместный вариант планируется после проверки совместимости/);
});

test('Telegram and website catalogues hide unorderable DNS and bundle plans',async()=>{
  const {PgBillingStore}=await import('../packages/billing/src/store.ts');
  const previous=process.env.MNEBYDNS_PAID_SALES_ENABLED;
  const row=(id:string,product:string)=>({
    id,product,title:id,enabled:true,duration_seconds:2592000,
    rub_minor:20000,stars:200,device_limit:1,dns_quota_bytes:100000000,
  });
  const store=new PgBillingStore({
    query:async()=>({rows:[
      row('vpn-month','vpn'),row('dns-month','smart_dns'),
      row('bundle-month','bundle'),
    ]}),
  } as never);
  try{
    delete process.env.MNEBYDNS_PAID_SALES_ENABLED;
    for(const provider of ['telegram_stars','prodamus'] as const){
      const items=await store.plans(provider);
      assert.deepEqual(items.map(p=>p.product),['vpn'],provider);
    }
    process.env.MNEBYDNS_PAID_SALES_ENABLED='yes';
    for(const provider of ['telegram_stars','prodamus'] as const){
      const items=await store.plans(provider);
      assert.deepEqual(items.map(p=>p.product),['vpn','smart_dns','bundle'],provider);
    }
  }finally{
    if(previous===undefined)delete process.env.MNEBYDNS_PAID_SALES_ENABLED;
    else process.env.MNEBYDNS_PAID_SALES_ENABLED=previous;
  }
});
