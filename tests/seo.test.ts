import assert from 'node:assert/strict';
import test from 'node:test';
import {seoPages,seoPaths,renderSeoPage,renderRobots,renderSitemap} from '../apps/web/src/seo.ts';

const origin='https://mnebyvpn.site';

test('public SEO pages have unique paths, titles and descriptions',()=>{
  assert.equal(new Set(seoPaths()).size,seoPages.length);
  assert.equal(new Set(seoPages.map(p=>p.title)).size,seoPages.length);
  assert.equal(new Set(seoPages.map(p=>p.description)).size,seoPages.length);
  assert.equal(seoPages.length,10,'All launch guides must be included in sitemap');
  for(const path of ['/vpn-android','/vpn-iphone','/private-dns-android']){
    assert.ok(seoPaths().includes(path));
  }
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

test('JSON-LD remains valid, references canonical pages and includes breadcrumbs',()=>{
  for(const page of seoPages){
    const html=renderSeoPage(page.path,origin)!;
    const raw=/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)?.[1];
    assert.ok(raw,'Each page must expose structured data');
    const data=JSON.parse(raw) as {
      '@context':string;
      '@graph':Array<{'@type':string;url?:string;
        itemListElement?:Array<{position:number;item:string}>}>;
    };
    assert.equal(data['@context'],'https://schema.org');
    const pageItem=data['@graph'].find(x=>x['@type']==='WebPage');
    assert.equal(pageItem?.url,origin+page.path);
    const breadcrumb=data['@graph'].find(x=>x['@type']==='BreadcrumbList');
    assert.deepEqual(breadcrumb?.itemListElement?.map(x=>x.item),[origin+'/',origin+page.path]);
  }
});

test('search guides link only to stable public pages and never contain a customer token',()=>{
  const paths=new Set(['/', '/terms','/privacy', ...seoPaths()]);
  for(const page of seoPages){
    const html=renderSeoPage(page.path,origin)!;
    for(const match of html.matchAll(/href="(\/[^"#?]*)"/g)){
      const target=match[1];
      if(target.endsWith('.css')||target.endsWith('.webp'))continue;
      assert.ok(paths.has(target),'Broken internal link '+target+' from '+page.path);
    }
    assert.doesNotMatch(html,/href="\/(?:sub|install|api|auth|webhooks)\//);
    assert.doesNotMatch(html,/[0-9]+\s?₽/);
  }
});
