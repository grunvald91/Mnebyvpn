import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {registerOfflineSale,showOfflineSale} from '../../apps/service/src/manual-sales.ts';
import {issueOwnerOfflineSubscriptionLink} from '../../packages/provisioning/src/owner-offline-subscriptions.ts';
import {sealProxySecret} from '../../packages/web/src/telegram-proxy-bonus.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:3,connectionTimeoutMillis:1500,
});
after(async()=>pool.end());
test('offline 30-day bundle is atomic and never fakes PSP captures or sends to customers',async()=>{
  const op=887766,tag=randomUUID().replace(/-/g,'').slice(0,9);
  const handle='buyer_'+tag;
  try{
    const result=await registerOfflineSale(pool,op,op,'12345678','@'+handle+' 399');
    assert.match(result.text,/Личная продажа записана/);
    const id=/Заказ: ([0-9a-f-]{36})/.exec(result.text)?.[1];
    assert.ok(id);
    const order=await pool.query(
      'SELECT o.*,m.customer_label,m.receipt_reference,a.telegram_user_id '+
      'FROM orders o JOIN manual_sales m ON m.order_id=o.id '+
      'JOIN accounts a ON a.id=o.account_id WHERE o.id=$1',[id]);
    assert.equal(order.rowCount,1);
    assert.equal(order.rows[0].provider,'manual_sale');
    assert.equal(order.rows[0].state,'PAID');
    assert.equal(Number(order.rows[0].amount_minor),39900);
    assert.equal(order.rows[0].telegram_user_id,null);
    assert.equal(order.rows[0].receipt_reference,null);
    assert.equal(order.rows[0].customer_label,handle);
    const ents=await pool.query(
      'SELECT product,state,starts_at,expires_at,dns_query_quota_per_30d,revision '+
      'FROM entitlements WHERE source_order_id=$1 ORDER BY product',[id]);
    assert.equal(ents.rowCount,2);
    assert.deepEqual(ents.rows.map(x=>x.product),['smart_dns','vpn']);
    assert.ok(ents.rows.every(x=>x.state==='PAID_PENDING_PROVISIONING'));
    assert.equal(ents.rows[0].dns_query_quota_per_30d,'1000000');
    assert.equal(ents.rows[1].dns_query_quota_per_30d,null);
    // Each 3-device owner order reserves exactly three separate device seats,
    // but DOES NOT pretend they are independent signed AWG peers yet.
    const seats=await pool.query(
      "SELECT s.slot_number,s.state,s.peer_public_key,s.registered_at "+
      "FROM owner_vpn_device_seats s "+
      "JOIN entitlements e ON e.id=s.entitlement_id "+
      "WHERE e.source_order_id=$1 ORDER BY s.slot_number",[id]);
    assert.deepEqual(seats.rows.map(x=>Number(x.slot_number)),[1,2,3]);
    assert.ok(seats.rows.every(x=>x.state==='EMPTY'&&x.peer_public_key===null&&
      x.registered_at===null));
    assert.ok(ents.rows.every(x=>
      x.expires_at.getTime()-x.starts_at.getTime()===2592000_000));
    const outbox=await pool.query('SELECT count(*)::int n FROM reconcile_outbox WHERE entitlement_id IN '+
      '(SELECT id FROM entitlements WHERE source_order_id=$1)',[id]);
    assert.equal(outbox.rows[0].n,2);
    const credits=await pool.query('SELECT count(*)::int n FROM entitlement_credits WHERE order_id=$1',[id]);
    assert.equal(credits.rows[0].n,2);
    const psp=await pool.query('SELECT count(*)::int n FROM verified_payment_events WHERE order_id=$1',[id]);
    assert.equal(psp.rows[0].n,0);
    const dup=await registerOfflineSale(pool,op,op,'12345678','@'+handle+' 399');
    assert.match(dup.text,new RegExp(id));
    const blocked=await registerOfflineSale(pool,op,op,'87654321','@'+handle+' 399');
    assert.match(blocked.text,/уже существует/);
    const total=await pool.query('SELECT count(*)::int n FROM manual_sales WHERE customer_label=$1',[handle]);
    assert.equal(total.rows[0].n,1);
    const seatsOnReplay=await pool.query(
      'SELECT count(*)::int n FROM owner_vpn_device_seats s '+
      'JOIN entitlements e ON e.id=s.entitlement_id '+
      'WHERE e.source_order_id=$1',[id]);
    assert.equal(seatsOnReplay.rows[0].n,3,'replay must not duplicate reserved device seats');
    const seatGuard=await pool.connect();
    try{
      await seatGuard.query('BEGIN');
      await seatGuard.query('SAVEPOINT impossible_fourth_device');
      const vpnEntitlement=(await seatGuard.query(
        "SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",[id])).rows[0].id;
      await assert.rejects(seatGuard.query(
        "INSERT INTO owner_vpn_device_seats(entitlement_id,slot_number) VALUES($1,4)",
        [vpnEntitlement]),{code:'23514'});
      await seatGuard.query('ROLLBACK TO SAVEPOINT impossible_fourth_device');
      await seatGuard.query('ROLLBACK');
    }finally{seatGuard.release();}
    // Suspension is temporary and must not permit a second paid package.
    await pool.query("UPDATE entitlements SET state='SUSPENDED' WHERE source_order_id=$1 AND product='vpn'",[id]);
    const stillBlocked=await registerOfflineSale(pool,op,op,'87654322','@'+handle+' 399');
    assert.match(stillBlocked.text,/уже существует/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM manual_sales WHERE customer_label=$1',[handle])).rows[0].n,1);
    const view=await showOfflineSale(pool,op,op,id!,true,true,Buffer.alloc(32,7));
    assert.match(view.text,/VPN-ссылка ещё недоступна/);
    assert.doesNotMatch(view.text,/https:\/\/cdn\.servgo\.ru:8443\/sub\//);
  }finally{/* Shared PostgreSQL pool closes once after all fixtures. */}
});


test('owner offline VPN bearer is stable, scoped to ledger, ACK, revocation and expiration',async()=>{
  const op=887799,other=op+1;
  const key=randomBytes(32);
  const handle='audit_'+randomUUID().replace(/-/g,'').slice(0,9);
  const result=await registerOfflineSale(pool,op,op,'882299','@'+handle+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(result.text)?.[1];
  assert.ok(orderId,result.text);
  const ent=(await pool.query("SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",
    [orderId])).rows[0]?.id as string;
  assert.ok(ent);
  const issue=()=>issueOwnerOfflineSubscriptionLink(pool,op,orderId!,ent,key);
  assert.equal(await issue(),null,'no VPN bearer before node acknowledgement');
  assert.equal(await issueOwnerOfflineSubscriptionLink(pool,other,orderId!,ent,key),null);
  assert.equal(await issueOwnerOfflineSubscriptionLink(pool,op,orderId!,ent,Buffer.alloc(0)),null);
  const countsBefore=await pool.query('SELECT count(*)::int n FROM vpn_subscription_links WHERE entitlement_id=$1',[ent]);
  assert.equal(countsBefore.rows[0].n,0);
  // Test fixture simulates exactly the acknowledged active revision.
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[ent]);
  await pool.query("INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'vpn',1,clock_timestamp()) ON CONFLICT(entitlement_id,adapter) DO UPDATE "+
    "SET applied_revision=1,last_observed_at=clock_timestamp()",[ent]);
  const first=await issue();
  assert.ok(first?.link.startsWith('https://cdn.servgo.ru:8443/sub/'));
  for(let i=0;i<5;i++)assert.equal((await issue())?.link,first?.link);
  assert.equal(await issueOwnerOfflineSubscriptionLink(pool,other,orderId!,ent,key),null);
  const links=await pool.query('SELECT token_sha256,revoked_at FROM vpn_subscription_links WHERE entitlement_id=$1',[ent]);
  assert.equal(links.rowCount,1,'refresh must not accumulate live bearer tokens');
  const token=first!.link.split('/').at(-1)!;
  assert.equal(links.rows[0].token_sha256,
    createHash('sha256').update(token,'utf8').digest('hex'));
  const view=await showOfflineSale(pool,op,op,orderId!,true,false,key);
  assert.match(view.text,new RegExp(token));
  assert.equal((await showOfflineSale(pool,op,op,orderId!,true,false,key)).text,view.text);
  await pool.query("UPDATE vpn_subscription_links SET revoked_at=clock_timestamp() WHERE entitlement_id=$1",[ent]);
  assert.equal(await issue(),null,'explicit revocation is permanent for that URL');
  const revokedView=await showOfflineSale(pool,op,op,orderId!,true,false,key);
  assert.doesNotMatch(revokedView.text,new RegExp(token));
  const linksAfter=await pool.query('SELECT count(*)::int n FROM vpn_subscription_links WHERE entitlement_id=$1',[ent]);
  assert.equal(linksAfter.rows[0].n,1);
});


test('owner-only personal DoT: ACTIVE gate, one encrypted hostname, replay, revoke',async()=>{
  const op=891177,other=op+1,key=randomBytes(32);
  const handle='dot_'+randomUUID().replace(/-/g,'').slice(0,9);
  const result=await registerOfflineSale(pool,op,op,'88991177','@'+handle+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(result.text)?.[1];
  assert.ok(orderId,result.text);
  const ent=(await pool.query(
    "SELECT id FROM entitlements WHERE source_order_id=$1 AND product='smart_dns'",
    [orderId])).rows[0].id as string;
  const count=async()=>Number((await pool.query(
    'SELECT count(*) AS n FROM personal_dns_credentials WHERE entitlement_id=$1',
    [ent])).rows[0].n);

  // The owner-only switch must not issue a credential before worker activation.
  const pending=await showOfflineSale(pool,op,op,orderId!,true,true,key);
  assert.match(pending.text,/DNS-ссылка пока не доступна/);
  assert.equal(await count(),0);

  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[ent]);
  // A disabled flag may not issue even an otherwise ACTIVE DNS entitlement.
  const disabled=await showOfflineSale(pool,op,op,orderId!,true,false,key);
  assert.match(disabled.text,/DNS-ссылка пока не доступна/);
  assert.equal(await count(),0);
  const forbidden=await showOfflineSale(pool,other,op,orderId!,true,true,key);
  assert.match(forbidden.text,/Недостаточно прав/);
  assert.equal(await count(),0);

  // Mere ACTIVE in DB is insufficient: the DNS worker must have ACKed
  // the exact current revision first.
  const noAck=await showOfflineSale(pool,op,op,orderId!,true,true,key);
  assert.doesNotMatch(noAck.text,/[a-z0-9]{12}\.dns\.mnebyvpn\.site/);
  assert.equal(await count(),0);
  // Simulate successful reconciliation ONLY in disposable PostgreSQL.
  await pool.query("INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'smart_dns',1,clock_timestamp()) ON CONFLICT(entitlement_id,adapter) DO UPDATE "+
    "SET applied_revision=1,last_observed_at=clock_timestamp()",[ent]);
  const first=await showOfflineSale(pool,op,op,orderId!,true,true,key);
  const host=/([a-z0-9]{12}\.dns\.mnebyvpn\.site)/.exec(first.text)?.[1];
  assert.ok(host,first.text);
  const label=host.slice(0,12);
  const record=await pool.query(
    'SELECT token_sha256,query_limit_per_30d,revoked_at FROM personal_dns_credentials '+
    'WHERE entitlement_id=$1',[ent]);
  assert.equal(record.rowCount,1);
  assert.equal(record.rows[0].token_sha256,
    createHash('sha256').update(label,'ascii').digest('hex'));
  assert.equal(Number(record.rows[0].query_limit_per_30d),1000000);
  const material=await pool.query('SELECT dns_label_ciphertext FROM manual_sales WHERE order_id=$1',[orderId]);
  assert.ok(material.rows[0].dns_label_ciphertext);
  assert.ok(!String(material.rows[0].dns_label_ciphertext).includes(label));

  const responses=await Promise.all([
    showOfflineSale(pool,op,op,orderId!,true,true,key),
    showOfflineSale(pool,op,op,orderId!,true,true,key),
  ]);
  for(const item of responses)assert.match(item.text,new RegExp(host.replaceAll('.','\\.')));
  assert.equal(await count(),1,'refresh/parallel delivery must not create another DoT credential');

  const wrongKey=await showOfflineSale(pool,op,op,orderId!,true,true,randomBytes(32));
  assert.doesNotMatch(wrongKey.text,new RegExp(host.replaceAll('.','\\.')));
  assert.match(wrongKey.text,/DNS-ключ пока не выдан/);

  // Once revoked, pressing refresh must never reactivate or reveal the bearer.
  await pool.query('UPDATE personal_dns_credentials SET revoked_at=clock_timestamp() WHERE entitlement_id=$1',[ent]);
  const revoked=await showOfflineSale(pool,op,op,orderId!,true,true,key);
  assert.doesNotMatch(revoked.text,new RegExp(host.replaceAll('.','\\.')));
  assert.equal(await count(),1);
});


test('private owner sale exposes only the direct verified Telemt link, hides stale and revoked',async()=>{
  const op=891188,other=op+1,key='b'.repeat(64);
  const handle='mtp_'+randomUUID().replace(/-/g,'').slice(0,9);
  const result=await registerOfflineSale(pool,op,op,'88991188','@'+handle+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(result.text)?.[1];
  assert.ok(orderId,result.text);
  const entry=(await pool.query(
    "SELECT id,account_id FROM entitlements WHERE source_order_id=$1 AND product='smart_dns'",
    [orderId])).rows[0];
  assert.ok(entry);
  const ent=entry.id as string;
  const username='dns_'+randomBytes(12).toString('hex');
  const secret=randomBytes(16).toString('hex');
  const box=sealProxySecret(secret,key,ent,username);
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[ent]);
  await pool.query(
    "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'smart_dns',1,clock_timestamp()) ON CONFLICT(entitlement_id,adapter) "+
    "DO UPDATE SET applied_revision=1,last_observed_at=clock_timestamp()",[ent]);
  await pool.query(
    "INSERT INTO dns_mtproxy_bonus_credentials(entitlement_id,telemt_username,secret_box,"+
    "tls_domain,state,verified_at) VALUES($1,$2,$3,'xapi.ozon.ru','ACTIVE',clock_timestamp())",
    [ent,username,box]);

  const keys=[
    'MNEBYVPN_OFFLINE_MTPROXY_ISSUE_ENABLED',
    'MNEBYVPN_OFFLINE_MTPROXY_ROUTES_VERIFIED',
    'MNEBYVPN_OFFLINE_MTPROXY_REVOKER_VERIFIED',
    'MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON',
    'WEB_DNS_MT_PROXY_BONUS_KEY',
    'WEB_DNS_MT_PROXY_BONUS_ROUTES_JSON',
    'WEB_DNS_MT_PROXY_BONUS_ENABLED',
  ] as const;
  const backup=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    Object.assign(process.env,{
      MNEBYVPN_OFFLINE_MTPROXY_ISSUE_ENABLED:'yes',
      MNEBYVPN_OFFLINE_MTPROXY_ROUTES_VERIFIED:'yes',
      MNEBYVPN_OFFLINE_MTPROXY_REVOKER_VERIFIED:'yes',
      MNEBYVPN_OFFLINE_MTPROXY_ROUTES_JSON:
        '[{"route":"direct","host":"89.125.90.101","port":9446}]',
      WEB_DNS_MT_PROXY_BONUS_KEY:key,
    });
    delete process.env.WEB_DNS_MT_PROXY_BONUS_ENABLED;
    // No independent owner private link is visible in ordinary client flows.
    const forbidden=await showOfflineSale(pool,other,op,orderId!,true,false,null);
    assert.match(forbidden.text,/Недостаточно прав/);
    const view=await showOfflineSale(pool,op,op,orderId!,true,false,null);
    const url=/https:\/\/t\.me\/proxy\?[^\s]+/.exec(view.text)?.[0];
    assert.ok(url,view.text);
    const parsed=new URL(url);
    assert.equal(parsed.searchParams.get('server'),'89.125.90.101');
    assert.equal(parsed.searchParams.get('port'),'9446');
    assert.equal(parsed.searchParams.get('secret'),
      'ee'+secret+Buffer.from('xapi.ozon.ru').toString('hex'));
    assert.doesNotMatch(view.text,/188\.120\.254\.223/);
    assert.equal((await showOfflineSale(pool,op,op,orderId!,true,false,null)).text,view.text);

    // A valid-looking but incorrect decryption key MUST fail closed without
    // crashing the entire owner's sale card (VPN/DNS remain inspectable).
    process.env.WEB_DNS_MT_PROXY_BONUS_KEY='f'.repeat(64);
    const cryptoFailure=await showOfflineSale(pool,op,op,orderId!,true,false,null);
    assert.match(cryptoFailure.text,/Личная продажа/);
    assert.match(cryptoFailure.text,/Smart DNS:/);
    assert.match(cryptoFailure.text,/Telegram-прокси: ожидается подтверждение Telemt/);
    assert.doesNotMatch(cryptoFailure.text,/https:\/\/t\.me\/proxy\?/);
    process.env.WEB_DNS_MT_PROXY_BONUS_KEY=key;

    await pool.query(
      "UPDATE dns_mtproxy_bonus_credentials SET verified_at=clock_timestamp()-interval '6 minutes' "+
      "WHERE entitlement_id=$1",[ent]);
    assert.doesNotMatch((await showOfflineSale(pool,op,op,orderId!,true,false,null)).text,
      /https:\/\/t\.me\/proxy\?/);
    await pool.query(
      "UPDATE dns_mtproxy_bonus_credentials SET state='DISABLED',verified_at=NULL,"+
      "disabled_at=clock_timestamp() WHERE entitlement_id=$1",[ent]);
    assert.doesNotMatch((await showOfflineSale(pool,op,op,orderId!,true,false,null)).text,
      /https:\/\/t\.me\/proxy\?/);
  }finally{
    for(const k of keys){
      const v=backup[k];if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});


test('three owner device public keys register without AWG grants; no fourth, key reuse or cross-owner',async()=>{
  const owner=877341,other=877342;
  const label='seats_'+randomUUID().replaceAll('-','').slice(0,10);
  const r=await registerOfflineSale(pool,owner,owner,'1299760','@'+label+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(r.text)?.[1];
  assert.ok(orderId,r.text);
  const entitlement=(await pool.query(
    "SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",
    [orderId])).rows[0].id as string;
  const key=()=>randomBytes(32).toString('base64');
  const [a,b,c,d]=[key(),key(),key(),key()];
  const request=(actor:number,slot:number,k:string)=>pool.query(
    'SELECT public.owner_vpn_request_device_key($1::bigint,$2::uuid,$3::smallint,$4::text) AS result',
    [actor,orderId,slot,k]).then(x=>x.rows[0].result as string);
  assert.equal(await request(owner,1,a),'DENY_ACCESS','not even first key before VPN ACK');
  assert.equal(await request(other,1,a),'DENY_ACCESS');
  assert.equal(await request(owner,4,a),'DENY_INPUT');
  assert.equal(await request(owner,1,'not-a-key'),'DENY_INPUT');

  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[entitlement]);
  await pool.query(
    "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'vpn',1,clock_timestamp()) ON CONFLICT(entitlement_id,adapter) "+
    "DO UPDATE SET applied_revision=1,last_observed_at=clock_timestamp()",
    [entitlement]);
  const simultaneous=await Promise.all([request(owner,1,a),request(owner,1,a)]);
  assert.deepEqual(simultaneous.sort(),['ALREADY_REQUESTED','REQUESTED']);
  assert.equal(await request(owner,1,a),'ALREADY_REQUESTED');
  assert.equal(await request(owner,2,a),'DENY_KEY_IN_USE');
  assert.equal(await request(owner,2,b),'REQUESTED');
  assert.equal(await request(owner,3,c),'REQUESTED');
  assert.equal(await request(owner,3,d),'DENY_BOUND');
  assert.equal(await request(other,2,b),'DENY_ACCESS');
  const rows=(await pool.query(
    'SELECT slot_number,peer_public_key,state FROM owner_vpn_device_seats '+
    'WHERE entitlement_id=$1 ORDER BY slot_number',[entitlement])).rows;
  assert.deepEqual(rows.map(x=>Number(x.slot_number)),[1,2,3]);
  assert.deepEqual(rows.map(x=>x.peer_public_key),[a,b,c]);
  assert.ok(rows.every(x=>x.state==='REQUESTED'));
  assert.equal((await pool.query(
    'SELECT count(*)::int n FROM vpn_awg_peer_allocations WHERE entitlement_id=$1',
    [entitlement])).rows[0].n,0,'a REQUESTED seat is never a live AWG peer');
  assert.equal((await pool.query(
    'SELECT count(*)::int n FROM vpn_awg_command_outbox WHERE entitlement_id=$1',
    [entitlement])).rows[0].n,0,'no automatic signed AWG commands');

  await pool.query(
    "UPDATE owner_vpn_device_seats SET state='REVOKED',revoked_at=clock_timestamp() "+
    "WHERE entitlement_id=$1 AND slot_number=1",[entitlement]);
  assert.equal(await request(owner,1,a),'DENY_REVOKED');
  assert.equal(await request(owner,1,d),'DENY_REVOKED');
  await pool.query("UPDATE entitlements SET state='SUSPENDED' WHERE id=$1",[entitlement]);
  assert.equal(await request(owner,2,b),'DENY_ACCESS','suspended subscription denies access');
});


test('private three-peer intent per verified AWG node never issues live allocations',async()=>{
  const owner=895144,other=895145;
  const label='three_'+randomUUID().replaceAll('-','').slice(0,9);
  const sale=await registerOfflineSale(pool,owner,owner,'89514401','@'+label+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(sale.text)?.[1];
  assert.ok(orderId,sale.text);
  const entitlement=(await pool.query(
    "SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",
    [orderId])).rows[0].id as string;
  const nodeId='seat-'+randomUUID().replaceAll('-','').slice(0,8);
  const nodeHost=nodeId+'.example.net';
  const ask=(actor:number,slot:number,node:string)=>pool.query(
    'SELECT public.owner_vpn_reserve_awg_peer_slot($1::bigint,$2::uuid,$3::smallint,$4::text) AS result',
    [actor,orderId,slot,node]).then(x=>x.rows[0].result as string);
  const key=()=>randomBytes(32).toString('base64');
  const keys=[key(),key(),key()];
  assert.equal(await ask(owner,1,nodeId),'DENY_ACCESS','no access before VPN ACK');
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[entitlement]);
  await pool.query(
    "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'vpn',1,clock_timestamp()) ON CONFLICT(entitlement_id,adapter) "+
    "DO UPDATE SET applied_revision=1,last_observed_at=clock_timestamp()",
    [entitlement]);
  for(let i=0;i<3;i++){
    const inserted: import('pg').QueryResult<{result:string}>=await pool.query<{result:string}>(
      'SELECT public.owner_vpn_request_device_key($1::bigint,$2::uuid,$3::smallint,$4::text) AS result',
      [owner,orderId,i+1,keys[i]]);
    assert.equal(inserted.rows[0].result,'REQUESTED');
  }
  assert.equal(await ask(owner,1,nodeId),'DENY_NODE','unapproved node is not reservable');
  assert.equal(await ask(other,1,nodeId),'DENY_ACCESS');
  assert.equal(await ask(owner,4,nodeId),'DENY_INPUT');

  await pool.query(
    "INSERT INTO vpn_node_enrollment_inventory(node_id,endpoint_host,identity_public_spki) "+
    "VALUES($1,$2,$3)",[nodeId,nodeHost,randomBytes(44).toString('base64url')]);
  await pool.query(
    "UPDATE vpn_node_enrollment_inventory SET status='approved',approved_at=clock_timestamp() "+
    "WHERE node_id=$1",[nodeId]);
  await pool.query(
    "INSERT INTO vpn_node_enrollment_challenges(challenge_id,node_id,nonce_sha256,"+
    "issued_at,expires_at,consumed_at) VALUES($1,$2,$3,"+
    "clock_timestamp()-interval '1 second',clock_timestamp()+interval '2 minutes',clock_timestamp())",
    [randomUUID(),nodeId,randomBytes(32).toString('hex')]);
  await pool.query(
    "UPDATE vpn_node_enrollment_inventory SET status='enrolled',enrolled_at=clock_timestamp() "+
    "WHERE node_id=$1",[nodeId]);
  await pool.query(
    "INSERT INTO vpn_awg_node_pools(node_id,endpoint_host,server_public_key,subnet_cidr,"+
    "state,external_e2e_proof_sha256,verified_at) "+
    "VALUES($1,$2,$3,'10.73.247.0/24','staged',$4,clock_timestamp())",
    [nodeId,nodeHost,key(),randomBytes(32).toString('hex')]);
  assert.equal(await ask(owner,1,nodeId),'DENY_NODE','staged node must not qualify');
  await pool.query("UPDATE vpn_awg_node_pools SET state='verified' WHERE node_id=$1",[nodeId]);

  const first=await Promise.all([ask(owner,1,nodeId),ask(owner,2,nodeId),ask(owner,3,nodeId)]);
  assert.deepEqual(first,['RESERVED','RESERVED','RESERVED']);
  assert.equal(await ask(owner,1,nodeId),'RESERVED','same slot is idempotent');
  const reservations=(await pool.query(
    'SELECT slot_number,peer_public_key,state FROM owner_vpn_awg_peer_reservations '+
    'WHERE node_id=$1 AND entitlement_id=$2 ORDER BY slot_number',
    [nodeId,entitlement])).rows;
  assert.deepEqual(reservations.map(r=>Number(r.slot_number)),[1,2,3]);
  assert.deepEqual(reservations.map(r=>r.peer_public_key),keys);
  assert.ok(reservations.every(r=>r.state==='RESERVED'));
  assert.equal((await pool.query(
    'SELECT count(*)::int n FROM vpn_awg_peer_allocations WHERE entitlement_id=$1',
    [entitlement])).rows[0].n,0,'no legacy AWG peer issued');
  assert.equal((await pool.query(
    'SELECT count(*)::int n FROM vpn_awg_command_outbox WHERE entitlement_id=$1',
    [entitlement])).rows[0].n,0,'no signed AWG command sent');

  await pool.query(
    "UPDATE owner_vpn_device_seats SET state='REVOKED',revoked_at=clock_timestamp() "+
    "WHERE entitlement_id=$1 AND slot_number=1",[entitlement]);
  assert.equal(await ask(owner,1,nodeId),'DENY_ACCESS','revoked key cannot get new authorization');
  await pool.query("UPDATE vpn_node_enrollment_inventory SET status='revoked' WHERE node_id=$1",[nodeId]);
  assert.equal(await ask(owner,2,nodeId),'DENY_NODE','revoked node cannot receive new reservations');
  await pool.query("UPDATE entitlements SET state='SUSPENDED' WHERE id=$1",[entitlement]);
  assert.equal(await ask(owner,2,nodeId),'DENY_ACCESS','suspension blocks reservations');
});
