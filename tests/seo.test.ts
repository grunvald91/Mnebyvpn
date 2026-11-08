import assert from 'node:assert/strict';
import test from 'node:test';
import {seoPages,seoPaths,renderSeoPage,renderRobots,renderSitemap} from '../apps/web/src/seo.ts';

const origin='https://mnebyvpn.site';

test('public SEO pages have unique paths, titles and descriptions',()=>{
  assert.equal(new Set(seoPaths()).size,seoPages.length);
  assert.equal(new Set(seoPages.map(p=>p.title)).size,seoPages.length);
  assert.equal(new Set(seoPages.map(p=>p.description)).size,seoPages.length);
  for(const page of seoPages){
    assert.match(page.path,/^\/[a-z-]+$/);
    const html=renderSeoPage(page.path,origin);
    assert.ok(html);
    assert.match(html!,/lang="ru"/);
    assert.ok(html!.includes('rel="canonical" href="'+origin+page.path+'"'));
    assert.ok(html!.includes('<h1>'));
    assert.ok(html!.includes('name="description"'));
    assert.ok(html!.includes('application/ld+json'));
    assert.ok(html!.includes('href="/#plans"'));
  }
  assert.equal(renderSeoPage('/unknown',origin),null);
});

test('MNEBYDNS is not advertised as available for purchase',()=>{
  for(const path of ['/smart-dns','/youtube','/google-gemini']){
    const html=renderSeoPage(path,origin)!;
    assert.match(html,/разработ/);
  }
  assert.doesNotMatch(renderSeoPage('/google-gemini',origin)!,/гарантируем доступ/);
});

test('sitemap contains canonical public pages but not private routes',()=>{
  const xml=renderSitemap(origin);
  assert.match(xml,/^<\?xml version="1.0" encoding="UTF-8"\?>/);
  for(const path of ['/','/terms','/privacy',...seoPaths()]){
    assert.ok(xml.includes('<loc>'+origin+path+'</loc>'));
  }
  for(const privatePath of ['/api','/auth','/sub','/install','/webhooks']){
    assert.ok(!xml.includes('<loc>'+origin+privatePath));
  }
});

test('robots points to sitemap and excludes private access routes',()=>{
  const txt=renderRobots(origin);
  assert.match(txt,/User-agent: \*/);
  assert.match(txt,/Disallow: \/api\//);
  assert.match(txt,/Disallow: \/sub\//);
  assert.match(txt,/Sitemap: https:\/\/mnebyvpn\.site\/sitemap\.xml/);
});
