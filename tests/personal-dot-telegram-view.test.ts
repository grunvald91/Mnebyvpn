import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {personalDnsTelegramMenu,personalDnsPreview,personalDnsGuide}
  from '../apps/service/src/personal-dot-telegram-view.ts';
import {PERSONAL_DNS_STARS_OFFERS} from '../packages/dns-policy/src/smart-dns-offers.ts';
const db={query:async()=>({rows:[]})} as unknown as Pool;

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
  assert.match(view.text,/купить тариф заново/);
  const blocked=await personalDnsTelegramMenu(db,2222,
    published.map(p=>({...p,dnsQuotaQueriesPer30d:42n})));
  assert.equal(blocked.reply_markup.inline_keyboard.flat()
    .filter(x=>x.callback_data?.startsWith('buy:')).length,0);
});
