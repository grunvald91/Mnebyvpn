import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const index = readFileSync(new URL('../apps/web/public/index.html',import.meta.url),'utf8');
const script = readFileSync(new URL('../apps/web/public/about.js',import.meta.url),'utf8');
const styles = readFileSync(new URL('../apps/web/public/neo.css',import.meta.url),'utf8');
const server = readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
const privacy = readFileSync(new URL('../apps/web/public/privacy.html',import.meta.url),'utf8');

test('project panel is opt-in and leaves purchase and account sections intact',()=>{
  assert.match(index,/data-about-open="about"/);
  assert.match(index,/<dialog id="about-dialog"/);
  assert.match(index,/<section class="plans-section" id="plans"/);
  assert.match(index,/<section class="account-section shell" id="account"/);
  assert.match(index,/data-about-close-link/);
});
test('each accessible tab controls exactly one labeled panel',()=>{
  for(const name of ['about','security','bonus','roadmap']){
    assert.match(index,new RegExp('role="tab"[^>]*id="about-tab-'+name+'"[^>]*aria-controls="about-panel-'+name+'"'));
    assert.match(index,new RegExp('id="about-panel-'+name+'"[^>]*role="tabpanel"[^>]*aria-labelledby="about-tab-'+name+'"'));
    assert.match(script,new RegExp("'"+name+"'"));
  }
  assert.match(script,/ArrowLeft/);
  assert.match(script,/ArrowRight/);
  assert.match(styles,/\.about-dialog::backdrop/);
});
test('privacy copy does not make unverified no-logs or universal-access guarantees',()=>{
  assert.match(index,/не заявляем о подтверждённой политике/);
  assert.match(index,/не обещаем абсолютную анонимность/i);
  assert.match(privacy,/сведения об обработке|технически обрабатываются/i);
  assert.doesNotMatch(privacy,/без журналов|no-logs|аудит|проверенную политику/i);
  assert.match(index,/пока дни или деньги за приглашение не начисляются/);
});
test('about script is actually served by website under same-origin CSP',()=>{
  assert.match(index,/<script src="\/about\.js" defer><\/script>/);
  assert.match(server,/const aboutJs = await readFile/);
  assert.match(server,/url\.pathname === '\/about\.js'/);
  assert.match(server,/send\(res, 200, aboutJs, 'text\/javascript; charset=utf-8'\)/);
});
