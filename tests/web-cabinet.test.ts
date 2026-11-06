import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  createLoginChallenge, consumeLoginChallenge, issueSession, readSession,
  csrfForSession, isValidCsrf, verifyTelegramIdToken,
} from '../packages/web/src/security.ts';
import { publicEntitlement } from '../packages/web/src/dashboard.ts';

const secret = 'offline-web-session-secret-with-over-32-characters';
const now = Date.UTC(2026,10,6,9,0,0);
test('OIDC PKCE state is one-browser-bound and expires in five minutes',()=>{
  const a=createLoginChallenge(secret,now);
  const b=createLoginChallenge(secret,now);
  assert.match(a.state,/^[A-Za-z0-9_-]{32}$/);
  assert.match(a.codeChallenge,/^[A-Za-z0-9_-]{43}$/);
  const verifier=consumeLoginChallenge(a.cookie,a.state,secret,now+1000);
  assert.ok(verifier);
  assert.equal(consumeLoginChallenge(a.cookie,b.state,secret,now+1000),null);
  assert.equal(consumeLoginChallenge(a.cookie,a.state,secret,now+300_001),null);
  assert.equal(consumeLoginChallenge(a.cookie,a.state,secret,now-1),null);
  assert.equal(consumeLoginChallenge(a.cookie+'x',a.state,secret,now),null);
});
test('authenticated session and CSRF are signed, time-bounded and account-specific',()=>{
  const s=issueSession(121232343,secret,now);
  assert.equal(readSession(s,secret,now+1000),121232343);
  assert.equal(readSession(s,secret,now+12*60*60_000+1),null);
  assert.equal(readSession(s,secret,now-61_000),null);
  assert.equal(readSession(s.slice(0,-1)+(s.endsWith('a')?'b':'a'),secret,now),null);
  assert.equal(isValidCsrf(csrfForSession(s,secret),s,secret),true);
  assert.equal(isValidCsrf(csrfForSession(s,secret),issueSession(2,secret,now),secret),false);
});
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-telegram-oidc',alg:'RS256',use:'sig'};
function issueToken(claimOverrides:Record<string,unknown>={},signingKey=privateKey):string {
  const h=Buffer.from(JSON.stringify({typ:'JWT',alg:'RS256',kid:jwk.kid})).toString('base64url');
  const p=Buffer.from(JSON.stringify({
    iss:'https://oauth.telegram.org',aud:'123456',sub:'opaque-subject',
    id:121232343,iat:Math.floor(now/1000)-10,exp:Math.floor(now/1000)+3600,
    ...claimOverrides,
  })).toString('base64url');
  const s=sign('RSA-SHA256',Buffer.from(h+'.'+p),signingKey).toString('base64url');
  return h+'.'+p+'.'+s;
}
test('Telegram OIDC requires trusted RSA key, correct issuer, audience, expiry and signature',()=>{
  assert.equal(verifyTelegramIdToken(issueToken(),{keys:[jwk]},'123456',now),121232343);
  assert.throws(()=>verifyTelegramIdToken(issueToken({aud:'elsewhere'}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken({iss:'https://attacker.invalid'}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken({exp:Math.floor(now/1000)-1}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken({id:'1'}),{keys:[jwk]},'123456',now));
  assert.throws(()=>verifyTelegramIdToken(issueToken(),{keys:[]},'123456',now));
  const other=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>verifyTelegramIdToken(issueToken({},other.privateKey),{keys:[jwk]},'123456',now));
});
const dnsRow={
  product:'smart_dns' as const,state:'ACTIVE',starts_at:new Date(now-86400_000),
  expires_at:new Date(now+86400_000),
  quota_limit_bytes:String(10*1024*1024*1024),quota_used_bytes:String(4*1024*1024*1024),
  quota_state:'AVAILABLE',
};
test('DNS usage is NOT presented as accurate before real ingress metering is verified',()=>{
  const hidden=publicEntitlement(dnsRow,false,now);
  assert.equal(hidden.quotaLimitBytes,dnsRow.quota_limit_bytes);
  assert.equal(hidden.quotaUsedBytes,null);
  assert.equal(hidden.quotaRemainingBytes,null);
  assert.equal(hidden.meteringVerified,false);
  const measured=publicEntitlement(dnsRow,true,now);
  assert.equal(measured.quotaUsedBytes,dnsRow.quota_used_bytes);
  assert.equal(measured.quotaRemainingBytes,String(6*1024*1024*1024));
  assert.equal(measured.secondsRemaining,86400);
});
test('unactivated trial never shows a fabricated expiry or quota amount',()=>{
  const trial=publicEntitlement({...dnsRow,state:'PAID_PENDING_PROVISIONING',
    starts_at:null,expires_at:null,quota_used_bytes:'0'},false,now);
  assert.equal(trial.expiresAt,null);
  assert.equal(trial.secondsRemaining,null);
  assert.equal(trial.quotaUsedBytes,null);
});
