import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {claimGuestVpnTrial,guestVpnState,confirmedGuestEntitlement}
  from '../../packages/provisioning/src/web-guest-trials.ts';
import {subscriptionOwner} from '../../packages/provisioning/src/subscription-links.ts';

test('website guest: one browser grant, node ACK starts 24 hours, link expires without Telegram',async()=>{
  const pool=new Pool({
    host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
    user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
    database:process.env.PGDATABASE??'mnebyvpn_test',
  });
  const secret=randomBytes(32).toString('hex');
  const cookie=randomBytes(32).toString('base64url');
  const hash=createHash('sha256').update(cookie).digest('hex');
  let account:string|null=null,order:string|null=null,entitlement:string|null=null;
  try{
    assert.deepEqual(await guestVpnState(pool,cookie,secret),{status:'NONE'});
    assert.equal(await claimGuestVpnTrial(pool,cookie),'GRANTED');
    assert.equal(await claimGuestVpnTrial(pool,cookie),'PENDING');
    const {rows}=await pool.query(
      "SELECT g.account_id,t.order_id,e.id AS entitlement_id,e.state,e.starts_at,e.expires_at "+
      "FROM web_guest_claims g JOIN trial_grants t ON t.guest_claim_hash=g.token_sha256 "+
      "JOIN entitlements e ON e.source_order_id=t.order_id "+
      "WHERE g.token_sha256=$1",[hash]);
    assert.equal(rows.length,1);
    account=rows[0].account_id;order=rows[0].order_id;entitlement=rows[0].entitlement_id;
    assert.equal(rows[0].state,'PAID_PENDING_PROVISIONING');
    assert.equal(rows[0].starts_at,null);
    assert.equal(rows[0].expires_at,null);
    const owned=await pool.query('SELECT telegram_user_id FROM accounts WHERE id=$1',[account]);
    assert.equal(owned.rows[0].telegram_user_id,null);
    assert.equal((await guestVpnState(pool,cookie,secret)).status,'PENDING');
    assert.equal(await confirmedGuestEntitlement(pool,entitlement!),null);
    await pool.query(
      "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,fencing_token) "+
      "VALUES($1,'vpn',0,1)",[entitlement]);
    const first=await pool.query(
      "SELECT acknowledge_provisioning($1,'vpn',1,1,true) AS accepted",[entitlement]);
    assert.equal(first.rows[0].accepted,true);
    const halfway=await guestVpnState(pool,cookie,secret);
    assert.equal(halfway.status,'PENDING'); // revision 2 still requires real node ACK.
    await pool.query('UPDATE provisioning_state SET fencing_token=2 WHERE entitlement_id=$1',[entitlement]);
    const second=await pool.query(
      "SELECT acknowledge_provisioning($1,'vpn',2,2,true) AS accepted",[entitlement]);
    assert.equal(second.rows[0].accepted,true);
    const active=await guestVpnState(pool,cookie,secret);
    assert.equal(active.status,'ACTIVE');
    assert.match(active.subscriptionUrl!,/^https:\/\/cdn\.servgo\.ru:8443\/sub\/[A-Za-z0-9_-]{43}$/);
    const duplicate=await guestVpnState(pool,cookie,secret);
    assert.equal(active.subscriptionUrl,duplicate.subscriptionUrl);
    const access=await confirmedGuestEntitlement(pool,entitlement!);
    assert.equal(access?.entitlementId,entitlement);
    const bearer=active.subscriptionUrl!.split('/').at(-1)!;
    const subscriber=await subscriptionOwner(pool,bearer);
    assert.equal(subscriber?.telegramUserId,null);
    assert.equal(subscriber?.entitlementId,entitlement);
    assert.equal(await claimGuestVpnTrial(pool,cookie),'ALREADY_USED');
    await pool.query("UPDATE entitlements SET state='EXPIRED' WHERE id=$1",[entitlement]);
    assert.equal((await guestVpnState(pool,cookie,secret)).status,'EXPIRED');
    assert.equal(await subscriptionOwner(pool,bearer),null);
    assert.equal(await confirmedGuestEntitlement(pool,entitlement!),null);
  } finally{
    if(entitlement){
      await pool.query('DELETE FROM vpn_subscription_links WHERE entitlement_id=$1',[entitlement]);
      await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=$1',[entitlement]);
      await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlement]);
      await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]);
    }
    if(order){
      await pool.query('DELETE FROM trial_grants WHERE order_id=$1',[order]);
      await pool.query('DELETE FROM orders WHERE id=$1',[order]);
    }
    await pool.query('DELETE FROM web_guest_claims WHERE token_sha256=$1',[hash]);
    if(account)await pool.query('DELETE FROM accounts WHERE id=$1',[account]);
    await pool.end();
  }
});
