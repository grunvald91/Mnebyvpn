import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const index=read('apps/web/public/index.html');
const art=read('apps/web/public/landing-art.html');
const css=read('apps/web/public/journey.css');
const server=read('apps/web/src/server.ts');
const offer=read('apps/web/public/terms.html');
const agreement=read('apps/web/public/agreement.html');
const privacy=read('apps/web/public/privacy.html');

test('free trial has branded compact neon back navigation',()=>{
  assert.match(index,/id="journey-trial-back" href="#plans"/);
  assert.match(index,/class="journey-back journey-back--neon"/);
  assert.match(css,/a\.journey-back--neon/);
  assert.match(css,/a\.journey-back--neon:focus-visible/);
});

test('verified seller name and INN appear in real mobile landing and legal documents',()=>{
  for(const page of [index,art,offer,agreement,privacy]){
    assert.match(page,/Кунавина Анна Александровна/);
    assert.match(page,/745214444705/);
  }
});

test('legal routes and pages are linked with consistent navigation',()=>{
  for(const path of ['/terms','/agreement','/privacy']){
    for(const page of [index,art,offer,agreement,privacy])
      assert.ok(page.includes(path),'missing '+path);
  }
  assert.match(server,/url\.pathname === '\/agreement'/);
  assert.match(server,/url\.pathname === '\/legal\.css'/);
  assert.ok(read('apps/web/public/legal.css').includes('.legal-panel'));
});

test('offer has no outdated tariffs or payment-provider advertising',()=>{
  assert.doesNotMatch(offer,/Prodamus|15 дней — 60 ₽|30 дней — 99 ₽/i);
  assert.match(offer,/Smart DNS/);
  assert.match(offer,/статье 782 ГК РФ/);
  assert.match(offer,/статье 32 Закона РФ/);
});

test('legal pages do not include infrastructure audit commentary or invented no-logs promise',()=>{
  for(const page of [offer,agreement,privacy]){
    assert.doesNotMatch(page,/no-logs|без журналов|независимым аудитом|не подтверждено.*журнал/i);
    assert.doesNotMatch(page,/2025 года/);
  }
});
