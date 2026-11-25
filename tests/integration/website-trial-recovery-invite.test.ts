import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {sendLegacyTrialInvite,trialInviteSignature,validTrialInviteSignature} from '../../packages/web/src/legacy-trial-invite.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',database:process.env.PGDATABASE??'mnebyvpn_test'});
after(()=>pool.end());
const secret='test-only-invitation-secret-123456789';
test('owner invite only for known empty account, sends once without granting trial',async()=>{
 const account=randomUUID(),email='legacy-'+account.slice(0,8)+'@example.org';
 await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,email]);
 let n=0;const send=async()=>{n++;return true;};
 assert.equal(await sendLegacyTrialInvite(pool,'missing@example.org',secret,send),'NOT_ELIGIBLE');
 assert.equal(await sendLegacyTrialInvite(pool,email,secret,send),'SENT');
 assert.equal(await sendLegacyTrialInvite(pool,email,secret,send),'ALREADY_SENT');
 assert.equal(n,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE account_id=$1',[account])).rows[0].n,0);
});
test('recovery invite signature binds exact operator, recipient and freshness',()=>{
 const now=Date.now(),stamp=String(Math.floor(now/1000)),email='test@example.org',sig=trialInviteSignature(secret,stamp,123,email);
 assert.equal(validTrialInviteSignature(secret,stamp,sig,123,email,now),true);
 assert.equal(validTrialInviteSignature(secret,stamp,sig,124,email,now),false);
 assert.equal(validTrialInviteSignature(secret,stamp,sig,123,'other@example.org',now),false);
 assert.equal(validTrialInviteSignature(secret,stamp,sig,123,email,now+120000),false);
});
