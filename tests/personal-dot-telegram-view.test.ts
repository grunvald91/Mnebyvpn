import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {personalDnsTelegramAction,personalDnsTelegramMenu,personalDnsPreview,personalDnsGuide,bundleTrialDnsButtons,bundleTrialDnsAction}
  from '../apps/service/src/personal-dot-telegram-view.ts';
import {PERSONAL_DNS_STARS_OFFERS} from '../packages/dns-policy/src/smart-dns-offers.ts';
const db={query:async()=>({rows:[]})} as unknown as Pool;

test('the regional menu offers two separate profiles with one counter and honors the release gate',async()=>{
  const calls:string[]=[];
  const regionalDb={query:async(sql:string)=>{
    calls.push(sql);
    if(sql.includes('telegram_regional_dns_revision'))return {rows:[{revision:'0'}]};
    if(sql.includes('telegram_issue_regional_dns_credential'))return {rows:[{result:'ISSUED'}]};
    if(sql.includes('personal_dns_query_status'))return {rows:[{
      used_queries:'12',remaining_queries:'999988',allowed_queries:'1000000',
      access_status:'ACTIVE',credential_revision:'1',
    }]};
    return {rows:[{entitlement_id:'fixture',state:'ACTIVE',expires_at:new Date(Date.now()+60_000),
      credential_revision:'1',revoked_at:null}]};
  }} as unknown as Pool;
  const disabled=await personalDnsTelegramMenu(regionalDb,2222);
  assert.doesNotMatch(disabled.text,/Финляндия/);
  assert.ok(!calls.some(x=>x.includes('telegram_regional_dns_revision')));
  const view=await personalDnsTelegramMenu(regionalDb,2222,[],[],true);
  assert.match(view.text,/Германия и Финляндия расходуют общий лимит/);
  const buttons=view.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(x=>x.text.includes('Германия')&&x.callback_data==='dns:rotate:confirm:1'));
  assert.ok(buttons.some(x=>x.text.includes('Финляндия')&&x.callback_data==='dns:fi:execute:0'));
  const denied=await personalDnsTelegramAction(regionalDb,2222,'dns:fi:execute:0');
  assert.match(denied.text,/Неподдерживаемое/);
  assert.ok(!calls.some(x=>x.includes('telegram_issue_regional_dns_credential')));
  const delivery=await personalDnsTelegramAction(regionalDb,2222,'dns:fi:execute:0',undefined,true);
  assert.match(delivery.text,/Финляндия/);
  assert.match(delivery.text,/[a-z0-9]{12}\.fi\.mnebyvpn\.site/);
});

test('DNS preview shows four prices and instructions but no purchase buttons',()=>{
  const view=personalDnsPreview();
  for(const amount of ['14 дней — 100','30 дней — 200','60 дней — 400','90 дней — 500'])
    assert.ok(view.text.includes(amount),amount);
  assert.match(view.text,/1 000 000/);
  assert.ok(!view.reply_markup.inline_keyboard.flat().some(x=>x.callback_data?.startsWith('buy:')));
  for(const kind of ['ios','android','router','services']){
    const guide=personalDnsGuide(kind);
    assert.ok(guide.text.length>140);
    assert.ok(guide.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='nav:dns'));
  }
  assert.match(personalDnsGuide('router').text,/DNS-over-TLS/);
  assert.match(personalDnsGuide('ios').text,/mobileconfig/);
  assert.match(personalDnsGuide('services').text,/Instagram и Threads не заявлены/);
});

test('DNS purchase buttons come ONLY from approved published tariff entries',async()=>{
  const published=PERSONAL_DNS_STARS_OFFERS.map(p=>({
    planId:p.planId,product:'smart_dns',stars:p.stars,
    durationSeconds:p.days*86400,dnsQuotaBytes:null,
    dnsQuotaQueriesPer30d:1000000n,
  }));
  const view=await personalDnsTelegramMenu(db,2222,published);
  const buy=view.reply_markup.inline_keyboard.flat()
    .filter(x=>x.callback_data?.startsWith('buy:'));
  assert.deepEqual(buy.map(x=>x.callback_data),
    published.map(x=>'buy:stars:'+x.planId));
  const withYookassa=await personalDnsTelegramMenu(db,2222,published,[
    {days:15,rubMinor:14900},{days:30,rubMinor:24900},
    {days:60,rubMinor:44900},{days:90,rubMinor:59900},
  ]);
  const yookassaUrls=withYookassa.reply_markup.inline_keyboard.flat().map(x=>x.url).filter(Boolean);
  assert.deepEqual(yookassaUrls,[
    'https://mnebyvpn.site/?product=smart_dns&days=15',
    'https://mnebyvpn.site/?product=smart_dns&days=30',
    'https://mnebyvpn.site/?product=smart_dns&days=60',
    'https://mnebyvpn.site/?product=smart_dns&days=90',
  ]);
  assert.match(view.text,/купить тариф заново/);
  const blocked=await personalDnsTelegramMenu(db,2222,
    published.map(p=>({...p,dnsQuotaQueriesPer30d:42n})));
  assert.equal(blocked.reply_markup.inline_keyboard.flat()
    .filter(x=>x.callback_data?.startsWith('buy:')).length,0);
});

test('bundle-only DNS buttons use scoped revision and send actual regional bearer',async()=>{
 const calls:{sql:string;params:unknown[]}[]=[];
 let rev=0;
 const scoped={query:async(sql:string,params:unknown[])=>{
  calls.push({sql,params});
  if(sql.includes('telegram_bundle_trial_dns_status'))return {rows:[{status:{deRevision:1,fiRevision:rev}}]};
  if(sql.includes('telegram_bundle_trial_dns_issue')){rev++;return {rows:[{result:'ISSUED'}]};}
  throw Error('unexpected generic or paid query');
 }} as unknown as Pool;
 const buttons=await bundleTrialDnsButtons(scoped,2222,'FI',true);
 assert.equal(buttons[0][0].callback_data,'dns:trial:FI:execute:0');
 assert.deepEqual(await bundleTrialDnsButtons(scoped,2222,'FI',false),[]);
 const delivered:string[]=[];
 const deliver=async(hostname:string)=>{delivered.push(hostname);return true;};
 const view=await bundleTrialDnsAction(scoped,2222,'dns:trial:FI:execute:0',deliver,true);
 assert.match(view.text,/Финляндия/);
 assert.match(delivered[0],/^[a-z0-9]{12}\.fi\.mnebyvpn\.site$/);
 assert.ok(calls.some(c=>c.sql.includes('telegram_bundle_trial_dns_issue')&&c.params[0]==='2222'&&c.params[1]==='FI'&&c.params[3]===0));
 const repeated=await bundleTrialDnsAction(scoped,2222,'dns:trial:FI:execute:0',deliver,true);
 assert.match(repeated.text,/изменён или недоступен/);
 assert.equal(delivered.length,1);
 const confirm=await bundleTrialDnsAction(scoped,2222,'dns:trial:FI:confirm:1',deliver,true);
 assert.match(confirm.text,/Срок и общий лимит не изменятся/);
 assert.equal(delivered.length,1);
 assert.match(personalDnsGuide('ios').text,/Управление устройством/);
});
