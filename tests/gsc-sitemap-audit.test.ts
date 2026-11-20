import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {describeSitemap,readSitemapDiagnostic} from '../scripts/gsc-sitemap-audit.ts';

test('sitemap status never treats absence under one property as proof Google has not crawled it',()=>{
  assert.equal(describeSitemap([]).status,'NOT_LISTED');
  const result=describeSitemap([{path:'https://mnebyvpn.site/sitemap.xml',
    errors:0,warnings:0,isPending:false,lastSubmitted:'2026-11-19T10:20:00Z',
    lastDownloaded:'2026-11-20T09:00:00Z',
    contents:[{type:'web',submitted:11,indexed:1}]}]);
  assert.equal(result.status,'SUBMITTED');
  assert.equal(result.lastDownloaded,'2026-11-20');
  assert.equal(result.errors,0);
  assert.equal(result.submittedUrls,11);
  assert.equal(result.indexedUrls,1);
  assert.equal(describeSitemap([{path:'https://other.example/sitemap.xml'}]).status,'NOT_LISTED');
});

test('sitemap check accesses only approved read-only Search Console endpoints',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const credential=JSON.stringify({type:'service_account',
    client_email:'audit@test.iam.gserviceaccount.com',
    private_key:privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    token_uri:'https://oauth2.googleapis.com/token'});
  const urls:string[]=[];
  const fetchImpl=async(url:string|URL,init?:RequestInit):Promise<Response>=>{
    const target=String(url);urls.push(target);
    assert.equal(init?.redirect,'error');
    if(target.includes('oauth2.googleapis.com'))
      return new Response(JSON.stringify({access_token:'test'}),{status:200});
    if(target.endsWith('/sitemaps'))return new Response(JSON.stringify({sitemap:[]}),{status:200});
    if(target.includes('/sites/'))return new Response(JSON.stringify({
      siteUrl:'sc-domain:mnebyvpn.site',permissionLevel:'siteRestrictedUser'}),{status:200});
    throw Error('Unexpected URL');
  };
  const result=await readSitemapDiagnostic('sc-domain:mnebyvpn.site',credential,fetchImpl);
  assert.equal(result.status,'NOT_LISTED');
  assert.equal(urls.length,3);
  assert.equal(urls.filter(x=>x.endsWith('/sitemaps')).length,1);
  await assert.rejects(readSitemapDiagnostic('sc-domain:other.example',credential,fetchImpl),
    /GSC_SITEMAP_PROPERTY_NOT_ALLOWED/);
});
