import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INDEXNOW_ENDPOINT,INDEXNOW_UPDATED_PATHS,INDEXNOW_KEY_LOCATION,
  buildIndexNowPayload,sendIndexNow,
} from '../scripts/yandex-indexnow.ts';
import {PUBLIC_SEO_PATHS,YANDEX_INDEXNOW_KEY} from '../apps/web/src/seo-core.ts';

test('Yandex IndexNow payload contains only updated public canonical routes and owner proof',()=>{
  const data=buildIndexNowPayload();
  assert.equal(data.host,'mnebyvpn.site');
  assert.equal(data.key,YANDEX_INDEXNOW_KEY);
  assert.equal(data.keyLocation,INDEXNOW_KEY_LOCATION);
  assert.deepEqual(data.urlList,INDEXNOW_UPDATED_PATHS.map(p=>'https://mnebyvpn.site'+p));
  assert.equal(data.urlList.length,8);
  assert.ok(data.urlList.every(x=>PUBLIC_SEO_PATHS.some(p=>x==='https://mnebyvpn.site'+p)));
  assert.ok(!data.urlList.some(x=>/\/api\/|\/sub\/|\/payment\/|\/auth\/|\/privacy/.test(x)));
  for(const invalid of [[],['/sub/test'],['/vpn','/vpn'],['/privacy'],['https://bad.site/']])
    assert.throws(()=>buildIndexNowPayload(invalid),/INDEXNOW_INVALID_PUBLIC_URLS/);
});

test('IndexNow submission checks live HTTPS proof, posts exact URLs, never reports indexing',async()=>{
  const seen: {url:string;init?:RequestInit}[]=[];
  const mock=async(url:string,init?:RequestInit):Promise<Response>=>{
    seen.push({url,init});
    if(url===INDEXNOW_KEY_LOCATION)return new Response(YANDEX_INDEXNOW_KEY,{status:200});
    if(url===INDEXNOW_ENDPOINT)return new Response('',{status:200});
    throw Error('unexpected');
  };
  assert.equal(await sendIndexNow(mock),'SUBMITTED');
  assert.equal(seen.length,2);
  assert.equal(seen[0].init?.method,'GET');
  assert.equal(seen[1].init?.method,'POST');
  assert.equal(seen[1].init?.redirect,'error');
  assert.deepEqual(JSON.parse(String(seen[1].init?.body)),buildIndexNowPayload());
  const pending=async(url:string)=>url===INDEXNOW_KEY_LOCATION
    ?new Response(YANDEX_INDEXNOW_KEY,{status:200})
    :new Response('',{status:202});
  assert.equal(await sendIndexNow(pending),'PENDING');
});

test('IndexNow refuses any submission before correct public root key is accessible',async()=>{
  let posted=false;
  const unavailable=async()=>new Response('not found',{status:404});
  await assert.rejects(sendIndexNow(unavailable),/INDEXNOW_PROOF_HTTP_404/);
  const wrong=async()=>{posted=true;return new Response('wrong key',{status:200});};
  await assert.rejects(sendIndexNow(wrong),/INDEXNOW_PROOF_MISMATCH/);
  assert.equal(posted,true);
  for(const code of [403,422,429]){
    const fetchStub=async(url:string)=>url===INDEXNOW_KEY_LOCATION
      ?new Response(YANDEX_INDEXNOW_KEY,{status:200})
      :new Response('',{status:code});
    await assert.rejects(sendIndexNow(fetchStub),new RegExp('INDEXNOW_SUBMIT_HTTP_'+code));
  }
});
