import assert from 'node:assert/strict';
import test from 'node:test';
import {formatPrivatePageQueryLines,selectPageQueryOpportunities}
  from '../scripts/gsc-private-page-query.ts';

const site='https://mnebyvpn.site';
const pages=['/','/vpn','/smart-dns','/chatgpt','/claude','/gemini',
  '/google-antigravity','/telegram-proxy'];

test('only observed canonical page/query pairs, correctly weighted position',()=>{
  const rows=[
    {keys:[site+'/vpn','впн не работает'],clicks:2,impressions:120,position:9},
    {keys:[site+'/vpn','впн не работает'],clicks:1,impressions:30,position:11},
    {keys:[site+'/gemini','джемини не открывается'],clicks:0,impressions:70,position:12},
    {keys:[site+'/vpn/','неправильный canonical'],clicks:0,impressions:800},
    {keys:['https://sub.mnebyvpn.site/vpn','другой хост'],impressions:900},
    {keys:[site+'/payment/success','заказ'],clicks:0,impressions:300},
  ];
  const result=selectPageQueryOpportunities(rows,site,pages);
  assert.equal(result.length,2);
  assert.equal(result[0].path,'/vpn');
  assert.equal(result[0].query,'впн не работает');
  assert.equal(result[0].clicks,3);
  assert.equal(result[0].impressions,150);
  assert.equal(result[0].ctr,3/150);
  assert.equal(result[0].position,9.4);
  assert.equal(result[1].position,12);
  const lines=formatPrivatePageQueryLines(rows,site,pages);
  assert.ok(lines.some(x=>x.includes('показы: 150; клики: 3')));
  assert.ok(lines.some(x=>x.includes('поз. 9.4')));
  assert.ok(!lines.join(' ').includes('другой хост'));
});

test('sensitive or unsafe search phrases are omitted, never leaked in plaintext',()=>{
  const raw=['someone@example.com','https://example.com/private?token=abc',
    'vpn\nFORGED_ADMIN_LINE','vpn\u202eereh','api_key=secret',
    'text | injected table','<script>alert(1)</script>', ''],
    rows=raw.map(query=>({keys:[site+'/vpn',query],impressions:30,clicks:0}));
  const result=selectPageQueryOpportunities(rows,site,pages);
  assert.deepEqual(result,[]);
  const message=formatPrivatePageQueryLines(rows,site,pages).join('\n');
  assert.match(message,/данных пока нет/);
  for(const phrase of raw.filter(Boolean))assert.ok(!message.includes(phrase));
});

test('absent or invalid query samples do not imply zero organic demand',()=>{
  assert.deepEqual(selectPageQueryOpportunities(undefined,site,pages),[]);
  assert.match(formatPrivatePageQueryLines([],site,pages).join(' '),
    /не доказывает отсутствие показов/);
  const malformed=[
    {keys:[site+'/vpn','valid phrase'],impressions:-1,clicks:0},
    {keys:[site+'/vpn','valid phrase'],impressions:5,clicks:6},
    {keys:[site+'/vpn'],impressions:10},
  ];
  assert.deepEqual(selectPageQueryOpportunities(malformed,site,pages),[]);
  assert.throws(()=>selectPageQueryOpportunities([],site,pages,0),
    /GSC_PRIVATE_QUERY_LIMIT_INVALID/);
});
