import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPersonalDnsMobileconfig,sendPersonalDnsMobileconfig}
  from '../packages/dns-policy/src/personal-dot-profile.ts';
const hostname='aa11bb22cc33.dns.mnebyvpn.site';
const token='123456:'+('T'.repeat(32));

test('valid iPhone profile contains only the personal TLS DNS, never VPN, MDM or a root CA',()=>{
  const xml=buildPersonalDnsMobileconfig(hostname);
  assert.match(xml,/com\.apple\.dnsSettings\.managed/);
  assert.match(xml,/<key>DNSProtocol<\/key><string>TLS<\/string>/);
  assert.match(xml,/<key>ServerName<\/key><string>aa11bb22cc33\.dns\.mnebyvpn\.site<\/string>/);
  assert.match(xml,/<key>PayloadRemovalDisallowed<\/key><false\/>/);
  assert.match(xml,/Германия/);
  const finnish=buildPersonalDnsMobileconfig('bb22cc33dd44.fi.mnebyvpn.site');
  assert.match(finnish,/Финляндия/);
  assert.match(finnish,/<key>PayloadIdentifier<\/key><string>site\.mnebyvpn\.personal-dns\.fi<\/string>/);
  assert.match(finnish,/<key>ServerName<\/key><string>bb22cc33dd44\.fi\.mnebyvpn\.site<\/string>/);
  assert.ok(!/IPSec|VPNType|PayloadCertificate|PayloadPassword|https?:\/\/api\.telegram\.org/.test(xml));
  for(const bad of ['https://dns.mnebyvpn.site','dns.mnebyvpn.site',
    '0.local','AA11BB22CC33.evil.org','bad\n.host.dns.mnebyvpn.site'])
    assert.throws(()=>buildPersonalDnsMobileconfig(bad));
});

test('private Telegram file uses actual multipart .mobileconfig upload',async()=>{
  const calls:{url:string;method?:string;mime?:string;filename?:string;data?:string;chat?:string}[]=[];
  const mock=(async(url:string,init?:RequestInit)=>{
    const form=init?.body as FormData;
    const document=form.get('document') as File;
    calls.push({url,method:init?.method,mime:document.type,filename:document.name,
      data:await document.text(),chat:String(form.get('chat_id'))});
    return new Response(JSON.stringify({ok:true,result:{chat:{id:12345}}}),
      {status:200,headers:{'Content-Type':'application/json'}});
  }) as typeof fetch;
  assert.equal(await sendPersonalDnsMobileconfig(12345,hostname,token,mock),true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.telegram.org/bot'+token+'/sendDocument');
  assert.equal(calls[0].method,'POST');
  assert.equal(calls[0].filename,'MNEBYDNS-iPhone-iPad.mobileconfig');
  assert.equal(calls[0].mime,'application/x-apple-aspen-config');
  assert.equal(calls[0].chat,'12345');
  assert.ok(calls[0].data?.includes(hostname));
  assert.equal(await sendPersonalDnsMobileconfig(12345,hostname,null,mock),false);
  assert.equal(calls.length,1);
  const rejection=(async()=>new Response(JSON.stringify({ok:false}),{status:400})) as typeof fetch;
  assert.equal(await sendPersonalDnsMobileconfig(12345,hostname,token,rejection),false);
  const wrong=(async()=>new Response(JSON.stringify({ok:true,result:{chat:{id:888}}}),
      {status:200})) as typeof fetch;
  assert.equal(await sendPersonalDnsMobileconfig(12345,hostname,token,wrong),false);
  assert.rejects(()=>sendPersonalDnsMobileconfig(0,hostname,token,mock));
});
