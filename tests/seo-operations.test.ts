import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
const audit=readFileSync(new URL('../scripts/seo_public_audit_20261113.py',import.meta.url),'utf8');

test('ETag hashes are memoized per immutable Buffer, and private HTML remains no-store',()=>{
  assert.match(server,/const staticEtags=new WeakMap<Buffer,string>\(\)/);
  assert.match(server,/function contentEtag\(data: Buffer\): string/);
  assert.match(server,/staticEtags\.get\(data\)/);
  assert.match(server,/staticEtags\.set\(data,tag\)/);
  assert.match(server,/const etag=contentEtag\(landingArtHtml\)/);
  assert.match(server,/const etag=representationEtag\(contentEtag\(data\),representation\.encoding\)/);
  assert.match(server,/res\.setHeader\('Vary','Accept-Encoding'\)/);
  assert.match(server,/res\.setHeader\('Content-Encoding',representation\.encoding\)/);
  assert.match(server,/send\(res, 200, page, 'text\/html; charset=utf-8'\)/);
  assert.match(server,/function send\(res: ServerResponse, status: number, body: string\|Buffer, type = 'application\/json; charset=utf-8', cacheControl = 'no-store'\)/);
});

test('SEO crawler discovers only the real seven navigation hrefs in homepage HTML',()=>{
  assert.match(audit,/HOME_PUBLIC_GUIDE_LINKS=/);
  assert.match(audit,/set\(meta\.guide_links\)!=set\(GUIDE_ROUTES\)/);
  const parserTest=[
    'import sys,json',
    'source=open(sys.argv[1],encoding="utf-8").read().split("failures=[]")[0]',
    'scope={}',
    'exec(source,scope)',
    'Parser=scope["Meta"]',
    'p=Parser()',
    'p.feed(\'<nav class="journey-guide-links"><a href="/vpn">VPN</a><nav><a href="/smart-dns">DNS</a></nav><a href="/claude">Claude</a></nav><nav><a href="/private">Private</a></nav>\')',
    'print(json.dumps(p.guide_links))'
  ].join('\\n');
  const result=spawnSync('python3',['-c',parserTest,
    fileURLToPath(new URL('../scripts/seo_public_audit_20261113.py',import.meta.url))],
    {encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),['/vpn','/smart-dns','/claude']);
});

test('SEO crawler fails fast and honestly when GitHub runner cannot reach HTTPS',()=>{
  assert.match(audit,/SEO_PUBLIC_CRAWLER_GATE=FAIL_NETWORK/);
  assert.match(audit,/SEO_CRAWLER_TRANSPORT_UNAVAILABLE=/);
  const source=fileURLToPath(new URL('../scripts/seo_public_audit_20261113.py',import.meta.url));
  // No production network traffic: replace urllib opener BEFORE running script.
  const simulation=[
    'import sys,runpy,urllib.request,urllib.error',
    'from unittest.mock import patch',
    'class Offline:',
    '  def __init__(self): self.calls=0',
    '  def open(self,*args,**kwargs):',
    '    self.calls+=1',
    "    raise urllib.error.URLError('offline fixture')",
    'fake=Offline()',
    "with patch.object(urllib.request,'build_opener',return_value=fake):",
    "  with patch('time.sleep',return_value=None):",
    '    try: runpy.run_path(sys.argv[1],run_name="__main__")',
    '    except SystemExit as err:',
    '      print("TEST_CALLS="+str(fake.calls))',
    '      sys.exit(err.code)',
    'sys.exit(99)',
  ].join('\n');
  const result=spawnSync('python3',['-c',simulation,source],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stdout,/TEST_CALLS=2/);
  assert.match(result.stdout,/PATH=\/ transport=URLError attempt=1\/2/);
  assert.match(result.stdout,/PATH=\/ transport=URLError attempt=2\/2/);
  assert.match(result.stdout,/SEO_PUBLIC_CRAWLER_GATE=FAIL_NETWORK/);
  assert.doesNotMatch(result.stdout,/PATH=\/robots\.txt/);
});
