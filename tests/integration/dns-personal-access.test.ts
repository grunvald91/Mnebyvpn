import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {
  authorizePersonalDnsQuery,dnsTokenFromSni,
  issuePersonalDnsAccess,personalDnsAccessStatuses,revokePersonalDnsAccess,
} from '../../packages/dns-access/src/personal.ts';

const db=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:12,connectionTimeoutMillis:5000,
});
after(async()=>db.end());

async function verifiedDnsOrder():Promise<{
  account:string,entitlement:string,order:string,capture:string,
}>{
  const account=randomUUID(),order=randomUUID(),capture=randomUUID();
  await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await db.query(
    "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency) "+
    "VALUES($1,$2,'smart_dns','mock',2000,'RUB')",[order,account]);
  const result=await db.query(
    "SELECT settle_verified_payment($1,'mock',$2,$3,$4,2000,'RUB',3600,4096) AS s",
    [order,randomUUID(),capture,'b'.repeat(64)]);
  assert.equal(result.rows[0].s,'APPLIED');
  const ent=(await db.query(
    'SELECT id,revision FROM entitlements WHERE source_order_id=$1',[order])).rows[0];
  return {account,entitlement:ent.id as string,order,capture};
}
async function activatedDnsOrder(){
  const item=await verifiedDnsOrder();
  await db.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[item.entitlement]);
  await db.query(
    "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'smart_dns',1,clock_timestamp())",[item.entitlement]);
  return item;
}

test('paid-only DNS token is distinct per account and all daily counters are isolated',async()=>{
  const a=await activatedDnsOrder(),b=await activatedDnsOrder();
  const la=await issuePersonalDnsAccess(db,a.account,a.entitlement);
  const lb=await issuePersonalDnsAccess(db,b.account,b.entitlement);
  assert.ok(la&&la!=='ALREADY_ISSUED');
  assert.ok(lb&&lb!=='ALREADY_ISSUED');
  assert.notEqual(la.hostname,lb.hostname);
  assert.equal(await issuePersonalDnsAccess(db,b.account,a.entitlement),null);
  const ta=dnsTokenFromSni(la.hostname),tb=dnsTokenFromSni(lb.hostname);
  assert.ok(ta&&tb);
  assert.equal(await authorizePersonalDnsQuery(db,'u'+'0'.repeat(48)),false);
  const results=await Promise.all(
    Array.from({length:30},()=>authorizePersonalDnsQuery(db,ta)));
  assert.equal(results.filter(Boolean).length,30);
  assert.equal(await authorizePersonalDnsQuery(db,tb),true);
  const sa=await personalDnsAccessStatuses(db,a.account);
  const sb=await personalDnsAccessStatuses(db,b.account);
  assert.equal(sa.find(s=>s.entitlementId===a.entitlement)?.authorizedQueries,'30');
  assert.equal(sb.find(s=>s.entitlementId===b.entitlement)?.authorizedQueries,'1');

  // Existing key stays stable across page refreshes until explicit rotation.
  assert.equal(await issuePersonalDnsAccess(db,a.account,a.entitlement),'ALREADY_ISSUED');
  const rotated=await issuePersonalDnsAccess(db,a.account,a.entitlement,true);
  assert.ok(rotated&&rotated!=='ALREADY_ISSUED');
  assert.equal(await authorizePersonalDnsQuery(db,ta),false);
  assert.equal(await authorizePersonalDnsQuery(db,dnsTokenFromSni(rotated.hostname)!),true);
  assert.equal((await personalDnsAccessStatuses(db,a.account))[0].authorizedQueries,'1');

  assert.equal(await revokePersonalDnsAccess(db,b.account,a.entitlement),null);
  assert.equal(await revokePersonalDnsAccess(db,a.account,a.entitlement),'REVOKED');
  assert.equal(await authorizePersonalDnsQuery(db,dnsTokenFromSni(rotated.hostname)!),false);
  assert.equal(await revokePersonalDnsAccess(db,a.account,a.entitlement),'ALREADY_REVOKED');
});

test('DNS tokens cannot be issued before trusted provision ACK or after expiry',async()=>{
  const paid=await verifiedDnsOrder();
  assert.equal(await issuePersonalDnsAccess(db,paid.account,paid.entitlement),null);
  await db.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[paid.entitlement]);
  assert.equal(await issuePersonalDnsAccess(db,paid.account,paid.entitlement),null);
  await db.query(
    "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'smart_dns',1,clock_timestamp())",[paid.entitlement]);
  const link=await issuePersonalDnsAccess(db,paid.account,paid.entitlement);
  assert.ok(link&&link!=='ALREADY_ISSUED');
  const token=dnsTokenFromSni(link.hostname)!;
  assert.equal(await authorizePersonalDnsQuery(db,token),true);
  await db.query("UPDATE entitlements SET starts_at=clock_timestamp()-interval '2 days',"+
    " expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[paid.entitlement]);
  assert.equal(await authorizePersonalDnsQuery(db,token),false);
  assert.equal(await issuePersonalDnsAccess(db,paid.account,paid.entitlement,true),null);
});

test('verified refund permanently kills the shared DNS credential',async()=>{
  const paid=await activatedDnsOrder();
  const issued=await issuePersonalDnsAccess(db,paid.account,paid.entitlement);
  assert.ok(issued&&issued!=='ALREADY_ISSUED');
  const token=dnsTokenFromSni(issued.hostname)!;
  assert.equal(await authorizePersonalDnsQuery(db,token),true);
  const result=await db.query(
    "SELECT apply_verified_refund($1,'mock',$2,$3,$4) AS status",
    [paid.order,randomUUID(),paid.capture,'c'.repeat(64)]);
  assert.equal(result.rows[0].status,'APPLIED');
  assert.equal(await authorizePersonalDnsQuery(db,token),false);
  const l=await db.query(
    'SELECT revoked_at FROM dns_subscription_links WHERE entitlement_id=$1',
    [paid.entitlement]);
  assert.ok(l.rows[0].revoked_at!==null);
});
