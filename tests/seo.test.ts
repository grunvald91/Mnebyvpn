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

test('launch-ready product pages avoid unsupported universal guarantees or invented prices',()=>{
  const dns=renderSeoPage('/smart-dns',origin)!;
  assert.match(dns,/MNEBYDNS/);
  assert.match(dns,/MNEBYVPN/);
  assert.doesNotMatch(dns,/в разработке|ещё разрабатывается|скоро/);
  assert.doesNotMatch(dns,/гарантируем (?:доступ|работу)/);
  assert.doesNotMatch(dns,/[0-9]+ ?₽/);
  for(const path of ['/youtube','/instagram','/telegram','/google-gemini','/ai-services']){
    const html=renderSeoPage(path,origin)!;
    assert.ok(html.includes('MNEBYVPN'));
    assert.doesNotMatch(html,/в разработке|ещё разрабатывается/);
  }
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
