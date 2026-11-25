import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {deliverVpnTrialReadyEmail} from '../packages/web/src/email-otp.ts';
test('trial-ready email signs exactly the fixed recipient and deadline payload',async()=>{
 const secret='test-only-secret-for-trial-ready-mail-12345';
 const expires=new Date(Date.now()+3600_000);
 let called=0;
 const fetcher:typeof fetch=async(input,init)=>{
   called++;
   assert.equal(String(input),'https://servgo.ru/api/auth/mnebyvpn/email-code');
   const headers=new Headers(init?.headers);
   const payload=String(init?.body);
   assert.deepEqual(JSON.parse(payload),{email:'test@example.org',kind:'vpn_trial_ready',expiresAt:expires.toISOString()});
   const signed=headers.get('X-Mnebyvpn-Timestamp')+'.'+headers.get('X-Mnebyvpn-Nonce')+'.'+payload;
   assert.equal(headers.get('X-Mnebyvpn-Signature'),createHmac('sha256',secret).update(signed).digest('hex'));
   return new Response('{}',{status:200});
 };
 assert.equal(await deliverVpnTrialReadyEmail('test@example.org',expires,secret,fetcher),true);
 assert.equal(await deliverVpnTrialReadyEmail('test@example.org',new Date(0),secret,fetcher),false);
 assert.equal(called,1);
});
