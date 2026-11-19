import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {SEO_PAGES,renderSeoPage} from '../apps/web/src/seo-pages.ts';
import {PUBLIC_SEO_PATHS,renderSitemap,canonicalAlias,requiresNoindex} from '../apps/web/src/seo-core.ts';

const ORIGIN='https://mnebyvpn.site';

test('public topic pages have crawlable metadata, unique H1, canonical and structured data',()=>{
  assert.equal(SEO_PAGES.length,7);
  assert.equal(new Set(SEO_PAGES.map(p=>p.path)).size,SEO_PAGES.length);
  const titles=new Set<string>();
  for(const page of SEO_PAGES){
    const html=renderSeoPage(page.path);
    assert.ok(html,page.path);
    assert.ok(html.includes('<html lang="ru">'));
    assert.ok(html.includes('<title>'+page.title+'</title>'));
    assert.ok(html.includes('<meta name="description" content="'));
    assert.ok(html.includes('rel="canonical" href="'+ORIGIN+page.path+'"'));
    assert.equal((html.match(/<h1>/g)??[]).length,1,page.path);
    assert.ok(html.includes('<script type="application/ld+json">'),page.path);
    assert.ok(html.includes('"BreadcrumbList"'),page.path);
    assert.ok(html.includes('class="seo-faq"'),page.path);
    assert.ok(html.includes('href="/#plans"'),page.path);
    assert.ok(!html.includes('name="robots" content="noindex"'),page.path);
    assert.ok(!html.includes('/sub/')&&!html.includes('/payment/'),page.path);
    assert.ok(!titles.has(page.title),page.title);
    titles.add(page.title);
    assert.equal(canonicalAlias(page.path+'/'),page.path);
    assert.equal(requiresNoindex(page.path),false);
    assert.ok(PUBLIC_SEO_PATHS.includes(page.path));
  }
});

test('sitemap covers new public pages but not authorization, checkout or opaque credentials',()=>{
  const xml=renderSitemap(ORIGIN);
  for(const page of SEO_PAGES)assert.ok(xml.includes('<loc>'+ORIGIN+page.path+'</loc>'));
  for(const excluded of ['/api/','/auth/','/payment/','/sub/','/install/'])
    assert.ok(!xml.includes(excluded));
});

test('public SEO renderer does not capture unknown or user-specific paths',()=>{
  for(const path of ['/', '/vpn/not-a-page', '/payment/success', '/sub/abc',
    '/gemini/anything', '/api/plans']) assert.equal(renderSeoPage(path),null);
});

test('homepage includes Gemini, Antigravity, canonical, organization schema and route links',()=>{
  const home=readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
  assert.ok(home.includes('Gemini не работает'));
  assert.ok(home.includes('Gemini не открывается'));
  assert.ok(home.includes('Google Antigravity'));
  assert.ok(home.includes('"Organization"'));
  assert.ok(home.includes('"WebSite"'));
  for(const page of SEO_PAGES)assert.ok(home.includes('href="'+page.path+'"'),page.path);
  // Different client-only views retain their original headings and styling.
  assert.ok((home.match(/<h1\b/g)??[]).length>=2);
});

test('SEO-specific CSS has no inline scripts, and routes have an external stylesheet',()=>{
  const style=readFileSync(new URL('../apps/web/public/seo-pages.css',import.meta.url),'utf8');
  assert.ok(style.includes('.seo-top'));
  for(const page of SEO_PAGES){
    const html=renderSeoPage(page.path)!;
    assert.ok(html.includes('href="/seo-pages.css"'));
    assert.ok(!/<script(?! type="application\/ld\+json")/i.test(html));
  }
});
