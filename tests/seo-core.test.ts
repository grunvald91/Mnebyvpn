import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  PUBLIC_SEO_PATHS,canonicalAlias,requiresNoindex,renderRobots,renderSitemap,
} from '../apps/web/src/seo-core.ts';

const origin='https://mnebyvpn.site';

test('sitemap contains ONLY approved canonical public URLs',()=>{
  const xml=renderSitemap(origin);
  assert.match(xml,/^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml,/xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  const urls=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(x=>x[1]);
  assert.deepEqual(urls,PUBLIC_SEO_PATHS.map(path=>origin+path));
  assert.ok(!xml.includes('/sub/') && !xml.includes('/payment/'));
  assert.equal(new Set(urls).size,urls.length);
});

test('robots.txt has exact HTTPS sitemap and avoids checkout and customer URLs',()=>{
  const txt=renderRobots(origin);
  assert.match(txt,/^User-agent: \*/);
  assert.match(txt,/^Sitemap: https:\/\/mnebyvpn\.site\/sitemap\.xml$/m);
  for(const path of ['/api/','/auth/','/sub/','/install/','/webhooks/']){
    assert.ok(txt.includes('Disallow: '+path));
  }
  assert.ok(!txt.includes('Disallow: /payment/'),
    'Keep payment responses crawlable so robots can see noindex');
  assert.ok(!txt.includes('Disallow: /terms'));
});

test('canonical aliases redirect only exact public duplicate paths',()=>{
  assert.equal(canonicalAlias('/index.html'),'/');
  for(const name of ['terms','agreement','privacy'])
    assert.equal(canonicalAlias('/'+name+'.html'),'/'+name);
  assert.equal(canonicalAlias('/payment/return'),null);
  assert.equal(canonicalAlias('/auth/login'),null);
  assert.equal(canonicalAlias('/sub/a'),null);
  assert.equal(canonicalAlias('/'),null);
});

test('private screens are noindex but legal and home stay indexable',()=>{
  for(const path of ['/payment/return','/payment/success','/api/plans',
    '/auth/login','/sub/opaque','/install/opaque',
    '/webhooks/prodamus','/landing-art.html']){
    assert.equal(requiresNoindex(path),true,path);
  }
  for(const path of ['/','/terms','/privacy','/agreement','/sitemap.xml'])
    assert.equal(requiresNoindex(path),false,path);
});

test('static public pages expose matching self-canonical and description',()=>{
  for(const [file,path] of [
    ['index.html','/'],['terms.html','/terms'],
    ['privacy.html','/privacy'],['agreement.html','/agreement'],
  ]){
    const html=readFileSync(new URL('../apps/web/public/'+file,import.meta.url),'utf8');
    assert.match(html,/<html lang="ru">/);
    assert.ok(html.includes('rel="canonical" href="'+origin+path+'"'),file);
    assert.match(html,/<meta name="description" content="[^"]+">/);
    assert.equal((html.match(/rel="canonical"/g)??[]).length,1);
  }
});
