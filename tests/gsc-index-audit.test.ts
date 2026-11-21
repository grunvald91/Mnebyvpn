import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {assertIndexAuditComplete,describeIndex,formatIndexAudit,inspectPublicPages} from '../scripts/gsc-index-audit.ts';
import {GSC_ORIGIN} from '../scripts/gsc-weekly-report.ts';
import {PUBLIC_SEO_PATHS,renderSitemap} from '../apps/web/src/seo-core.ts';

test('GSC public index verdicts do not mistake missing data for noindex',()=>{
  const none=describeIndex('/gemini',null);
  assert.equal(none.verdict,'UNKNOWN');
  assert.match(none.issue,/Недостаточно данных|не вернул/);
  const pass=describeIndex('/chatgpt',{verdict:'PASS',coverageState:'Submitted and indexed',
    googleCanonical:GSC_ORIGIN+'/chatgpt',lastCrawlTime:'2026-11-19T12:01:02Z'});
  assert.equal(pass.canonical,'same');
  assert.equal(pass.crawl,'2026-11-19');
  assert.equal(pass.verdict,'PASS');
  const crawl=describeIndex('/claude',{verdict:'FAIL',coverageState:'Crawled - currently not indexed'});
  assert.match(crawl.issue,/просканировал/);
  const discover=describeIndex('/vpn',{verdict:'FAIL',coverageState:'Discovered - currently not indexed'});
  assert.match(discover.issue,/обнаружил/);
  const robots=describeIndex('/smart-dns',{verdict:'FAIL',robotsTxtState:'DISALLOWED'});
  assert.match(robots.issue,/robots.txt/);
  const blocked=describeIndex('/google-antigravity',{verdict:'FAIL',indexingState:'BLOCKED_BY_META_TAG'});
  assert.match(blocked.issue,/noindex/);
  const different=describeIndex('/telegram-proxy',{verdict:'PASS',
    googleCanonical:'https://other.example/fake-token'});
  assert.equal(different.canonical,'different');
  assert.ok(!JSON.stringify(different).includes('other.example'));
});

test('index audit summary contains only known public URLs, not source private URLs',()=>{
  const rows=PUBLIC_SEO_PATHS.map(path=>describeIndex(path,{
    verdict:'FAIL',coverageState:'Crawled - currently not indexed',
    googleCanonical:'https://untrusted.example/secret',
  }));
  const markdown=formatIndexAudit(rows);
  for(const path of PUBLIC_SEO_PATHS)assert.ok(markdown.includes('`'+path+'`'));
  assert.equal(rows.length,11);
  assert.ok(!markdown.includes('untrusted.example'));
  assert.ok(!markdown.includes('query='));
  assert.ok(!markdown.includes('GSC_SERVICE_ACCOUNT_JSON'));
});

test('index audit uses read-only service account and inspects only approved URLs',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const creds=JSON.stringify({type:'service_account',
    client_email:'report@test.iam.gserviceaccount.com',
    private_key:privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    token_uri:'https://oauth2.googleapis.com/token'});
  const seen:string[]=[];
  const fetchImpl=async(url:string|URL,init?:RequestInit):Promise<Response>=>{
    const target=String(url);
    assert.equal(init?.redirect,'error');
    seen.push(target);
    const json=(data:any)=>new Response(JSON.stringify(data),{status:200});
    if(target.includes('oauth2.googleapis.com'))return json({access_token:'fake'});
    if(target.includes('/sites/'))return json({
      siteUrl:'sc-domain:mnebyvpn.site',permissionLevel:'siteRestrictedUser'});
    if(target.includes('urlInspection')){
      const body=JSON.parse(String(init?.body));
      assert.ok(PUBLIC_SEO_PATHS.some(path=>body.inspectionUrl===GSC_ORIGIN+path));
      return json({inspectionResult:{indexStatusResult:{
        verdict:'FAIL',coverageState:'Discovered - currently not indexed',
      }}});
    }
    throw Error('unexpected URL');
  };
  const rows=await inspectPublicPages('sc-domain:mnebyvpn.site',creds,fetchImpl);
  assert.equal(rows.length,11);
  assert.equal(rows.every(r=>r.verdict==='FAIL'),true);
  assert.equal(seen.length,13);
  assert.equal(seen.filter(x=>x.includes('urlInspection')).length,11);
  await assert.rejects(inspectPublicPages('sc-domain:unauthorized.example',creds,fetchImpl),
    /INDEX_PROPERTY_NOT_ALLOWED/);
});

test('scheduled index audit fails closed on API errors but not on unknown URLs',()=>{
  const unknown=PUBLIC_SEO_PATHS.map(path=>describeIndex(path,null));
  assert.doesNotThrow(()=>assertIndexAuditComplete(unknown));
  const errors=[...unknown];
  errors[3]=describeIndex(PUBLIC_SEO_PATHS[3],null,true);
  assert.throws(()=>assertIndexAuditComplete(errors),/INDEX_PUBLIC_INSPECTION_API_ERRORS_1/);
  assert.throws(()=>assertIndexAuditComplete(unknown.slice(0,-1)),
    /INDEX_PUBLIC_INSPECTION_INCOMPLETE/);
  const reordered=[...unknown];
  [reordered[0],reordered[1]]=[reordered[1],reordered[0]];
  assert.throws(()=>assertIndexAuditComplete(reordered),
    /INDEX_PUBLIC_INSPECTION_INCOMPLETE/);
  assert.match(formatIndexAudit(errors),/URL Inspection API: ошибка проверки/);
});

test('Google index inspection covers exactly the canonical sitemap pages, including legal pages',()=>{
  const locs=[...renderSitemap(GSC_ORIGIN).matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>match[1]);
  assert.deepEqual(locs,PUBLIC_SEO_PATHS.map(path=>GSC_ORIGIN+path));
  assert.equal(locs.length,11);
  for(const path of ['/terms','/agreement','/privacy'])
    assert.ok(PUBLIC_SEO_PATHS.some(allowed=>allowed===path));
  for(const url of locs)assert.doesNotMatch(url,/\/(?:api|auth|sub|install|payment)\//);
});

test('Google public index audit has daily read-only checks for 11 sitemap URLs',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/gsc-public-index-audit.yml',import.meta.url),'utf8');
  assert.match(workflow,/schedule:\s*\n\s*- cron: '23 5 \* \* \*'/);
  assert.match(workflow,/GSC_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.GSC_SERVICE_ACCOUNT_JSON \}\}/);
  assert.match(workflow,/node --experimental-strip-types scripts\/gsc-index-audit\.ts/);
  assert.ok(!workflow.includes('TELEGRAM_BOT_TOKEN'));
});
