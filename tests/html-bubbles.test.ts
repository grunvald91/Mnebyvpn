import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVpnHtmlBubble } from '../packages/telegram-ui/src/html-bubbles.ts';

test('HTMLBubble: interactive tabs and multiple independent VPN/DNS packages',()=>{
 const html=renderVpnHtmlBubble({heading:'Мне бы VPN',packages:[
  {label:'VPN • месяц',service:'vpn',active:true,usedBytes:null,quotaBytes:null,expiresAt:'2026-12-01'},
  {label:'DNS • 10 ГБ',service:'smart_dns',active:true,usedBytes:1024n*1024n*1024n,
   quotaBytes:10n*1024n*1024n*1024n,expiresAt:'2026-12-01'},
 ]});
 assert.match(html,/data-tab="packages"/);
 assert.match(html,/data-tab="about"/);
 assert.match(html,/data-card="1"/);
 assert.match(html,/9\.00 ГБ/);
 assert.match(html,/aria-valuenow="10"/);
 assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|localStorage|Telegram\.WebApp/);
});
test('HTMLBubble: escaped titles are inert, never interpolate into JS',()=>{
 const html=renderVpnHtmlBubble({heading:'<script>alert(1)</script>',
  packages:[{label:'"><img src=x onerror=alert(1)>',service:'vpn',active:false,
    usedBytes:null,quotaBytes:null,expiresAt:null}]});
 assert.doesNotMatch(html,/<img src=x onerror/);
 assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
 assert.match(html,/&lt;img/);
 assert.match(html,/&lt;script&gt;/);
});
