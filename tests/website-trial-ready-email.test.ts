import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {deliverVpnTrialReadyEmail,deliverVpnTrialRecoveryInvite} from '../packages/web/src/email-otp.ts';
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

test('bundle ready and invite use distinct signed gateway kinds without changing VPN or OTP contract',async()=>{
 const secret='test-only-secret-for-trial-ready-mail-12345';
 const expires=new Date(Date.now()+3600_000),messages:unknown[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
   assert.equal(String(input),'https://servgo.ru/api/auth/mnebyvpn/email-code');
   const headers=new Headers(init?.headers);
   const payload=String(init?.body);
   const signed=headers.get('X-Mnebyvpn-Timestamp')+'.'+headers.get('X-Mnebyvpn-Nonce')+'.'+payload;
   assert.equal(headers.get('X-Mnebyvpn-Signature'),createHmac('sha256',secret).update(signed).digest('hex'));
   messages.push(JSON.parse(payload));
   return new Response('{}',{status:200});
 };
 assert.equal(await deliverVpnTrialReadyEmail('test@example.org',expires,secret,fetcher,'bundle'),true);
 assert.equal(await deliverVpnTrialRecoveryInvite('test@example.org',secret,fetcher,'bundle'),true);
 assert.deepEqual(messages,[
   {email:'test@example.org',kind:'bundle_trial_ready',expiresAt:expires.toISOString()},
   {email:'test@example.org',kind:'bundle_trial_recovery_invite'},
 ]);
});

test('retry of the same canonical ready notification uses the same signed delivery nonce',async()=>{
 const secret='test-only-secret-for-trial-ready-mail-12345';
 const expires=new Date(Date.now()+3600_000),nonces:string[]=[];
 const fetcher:typeof fetch=async(_input,init)=>{
   const headers=new Headers(init?.headers);
   const nonce=headers.get('X-Mnebyvpn-Nonce')!;
   nonces.push(nonce);
   assert.match(nonce,/^trial_[a-f0-9]{56}$/);
   const body=String(init?.body);
   const signed=headers.get('X-Mnebyvpn-Timestamp')+'.'+nonce+'.'+body;
   assert.equal(headers.get('X-Mnebyvpn-Signature'),createHmac('sha256',secret).update(signed).digest('hex'));
   return new Response('{}',{status:200});
 };
 const order='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 await deliverVpnTrialReadyEmail('test@example.org',expires,secret,fetcher,'bundle',order);
 await deliverVpnTrialReadyEmail('test@example.org',expires,secret,fetcher,'bundle',order);
 await deliverVpnTrialReadyEmail('test@example.org',expires,secret,fetcher,'bundle','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 assert.equal(nonces[0],nonces[1]);assert.notEqual(nonces[0],nonces[2]);
});
