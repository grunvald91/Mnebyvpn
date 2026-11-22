import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  INDEXNOW_ENDPOINT,INDEXNOW_UPDATED_PATHS,INDEXNOW_KEY_LOCATION,
  buildIndexNowPayload,verifyLiveSeoReady,sendIndexNow,
} from '../scripts/yandex-indexnow.ts';
import {PUBLIC_SEO_PATHS,YANDEX_INDEXNOW_KEY} from '../apps/web/src/seo-core.ts';
import {SEO_PAGES} from '../apps/web/src/seo-pages.ts';

const ORIGIN='https://mnebyvpn.site';
type FetchClient=(url:string,init?:RequestInit)=>Promise<Response>;

function livePublic(url:string):Response{
  if(url===INDEXNOW_KEY_LOCATION)
    return new Response(YANDEX_INDEXNOW_KEY,{status:200,headers:{'Content-Type':'text/plain'}});
  assert.ok(INDEXNOW_UPDATED_PATHS.some(p=>url===ORIGIN+p),'unexpected public URL: '+url);
  const path=new URL(url).pathname;
  const guide=SEO_PAGES.find(p=>p.path===path);
  const html='<html><head><link rel="canonical" href="'+url+'">'+
    (guide?'<title>'+guide.title+'</title>':'<title>MNEBYVPN</title>')+
    '</head><body>'+(guide?'<h1>'+guide.headline+'</h1>':'<h1>Мне бы VPN</h1>')+
    '</body></html>';
  return new Response(html,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}});
}

test('Yandex IndexNow payload includes only 8 changed public canonical routes',()=>{
  const data=buildIndexNowPayload();
  assert.equal(data.host,'mnebyvpn.site');
  assert.equal(data.key,YANDEX_INDEXNOW_KEY);
  assert.equal(data.keyLocation,INDEXNOW_KEY_LOCATION);
  assert.deepEqual(data.urlList,INDEXNOW_UPDATED_PATHS.map(p=>ORIGIN+p));
  assert.equal(data.urlList.length,8);
  assert.ok(data.urlList.every(x=>PUBLIC_SEO_PATHS.some(p=>x===ORIGIN+p)));
  assert.ok(!data.urlList.some(x=>/\/api\/|\/sub\/|\/payment\/|\/auth\/|\/privacy/.test(x)));
  for(const invalid of [[],['/sub/test'],['/vpn','/vpn'],['/privacy'],['https://bad.site/']])
    assert.throws(()=>buildIndexNowPayload(invalid),/INDEXNOW_INVALID_PUBLIC_URLS/);
});

test('preflight checks the exact live key and all eight published, indexable routes',async()=>{
  const seen:string[]=[];
  const fetchImpl:FetchClient=async(url,init)=>{
    seen.push(url);
    assert.equal(init?.method,'GET');
    assert.equal(init?.redirect,'error');
    return livePublic(url);
  };
  await verifyLiveSeoReady(fetchImpl);
  assert.deepEqual(seen,[INDEXNOW_KEY_LOCATION,...INDEXNOW_UPDATED_PATHS.map(p=>ORIGIN+p)]);
});

test('IndexNow sends only after all public checks; 200 is accepted, 202 is pending',async()=>{
  const seen: {url:string;init?:RequestInit}[]=[];
  const mock:FetchClient=async(url,init)=>{
    seen.push({url,init});
    if(url===INDEXNOW_ENDPOINT)return new Response('',{status:200});
    return livePublic(url);
  };
  assert.equal(await sendIndexNow(mock),'SUBMITTED');
  assert.equal(seen.length,10);
  assert.equal(seen[0].url,INDEXNOW_KEY_LOCATION);
  assert.deepEqual(seen.slice(1,9).map(x=>x.url),INDEXNOW_UPDATED_PATHS.map(p=>ORIGIN+p));
  assert.equal(seen[9].url,INDEXNOW_ENDPOINT);
  assert.equal(seen[9].init?.method,'POST');
  assert.equal(seen[9].init?.redirect,'error');
  assert.deepEqual(JSON.parse(String(seen[9].init?.body)),buildIndexNowPayload());
  const pending:FetchClient=async url=>url===INDEXNOW_ENDPOINT
    ?new Response('',{status:202}):livePublic(url);
  assert.equal(await sendIndexNow(pending),'PENDING');
});

test('key mismatch/unavailable must block outbound submission',async()=>{
  for(const invalid of [
    new Response('not found',{status:404}),
    new Response('wrong key',{status:200}),
  ]){
    let posted=false;
    const stub:FetchClient=async url=>{
      if(url===INDEXNOW_ENDPOINT)posted=true;
      return invalid;
    };
    await assert.rejects(sendIndexNow(stub),
      /INDEXNOW_PROOF_HTTP_404|INDEXNOW_PROOF_MISMATCH/);
    assert.equal(posted,false);
  }
});

test('one unpublished or noindex route aborts before any IndexNow POST',async()=>{
  const target=ORIGIN+'/claude';
  const variants: {response:Response;reason:RegExp}[]=[
    {response:new Response('missing',{status:503}),reason:/INDEXNOW_PUBLIC_PAGE_HTTP_503/},
    {response:new Response('not html',{status:200}),reason:/INDEXNOW_PUBLIC_PAGE_NOT_HTML/},
    {response:new Response('<link rel="canonical" href="https://wrong.invalid/">',
      {headers:{'Content-Type':'text/html'}}),reason:/INDEXNOW_PUBLIC_PAGE_CANONICAL/},
    {response:new Response('<meta name="robots" content="noindex"><link rel="canonical" href="'+target+'">',
      {headers:{'Content-Type':'text/html'}}),reason:/INDEXNOW_PUBLIC_PAGE_NOINDEX/},
    {response:new Response('<link rel="canonical" href="'+target+'"><h1>Outdated</h1>',
      {headers:{'Content-Type':'text/html'}}),reason:/INDEXNOW_PUBLIC_PAGE_STALE/},
    {response:new Response('<link rel="canonical" href="'+target+'">',
      {headers:{'Content-Type':'text/html','X-Robots-Tag':'noindex, follow'}}),
      reason:/INDEXNOW_PUBLIC_PAGE_NOINDEX/},
  ];
  for(const {response,reason} of variants){
    let posted=false;
    const stub:FetchClient=async url=>{
      if(url===INDEXNOW_ENDPOINT){posted=true;return new Response('',{status:200});}
      return url===target?response:livePublic(url);
    };
    await assert.rejects(sendIndexNow(stub),reason);
    assert.equal(posted,false);
  }
});

test('Yandex HTTP errors remain errors, not indexing success',async()=>{
  for(const status of [403,422,429]){
    const stub:FetchClient=async url=>url===INDEXNOW_ENDPOINT
      ?new Response('',{status}):livePublic(url);
    await assert.rejects(sendIndexNow(stub),new RegExp('INDEXNOW_SUBMIT_HTTP_'+status));
  }
});

test('automation only sends on main, never from PR/test branch',()=>{
  const yaml=readFileSync(new URL('../.github/workflows/yandex-indexnow.yml',import.meta.url),'utf8');
  assert.match(yaml,/workflow_dispatch:/);
  assert.match(yaml,/push:\s*\n\s*paths:/);
  assert.match(yaml,/github\.ref == 'refs\/heads\/main'/);
  assert.match(yaml,/scripts\/yandex-indexnow\.ts --preflight/);
  assert.match(yaml,/scripts\/yandex-indexnow\.ts\s*$/m);
});
