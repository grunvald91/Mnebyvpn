/**
 * Disposable PG only. Node ACKs below use local synthetic Ed25519 keys;
 * there is no SSH, AWG interface, subscription delivery or production host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign}
  from 'node:crypto';
import {Pool} from 'pg';
import {registerOfflineSale}
  from '../../apps/service/src/manual-sales.ts';
import {awgSlotLeasePayload,awgSlotReceiptPayload,
  type AwgSlotLeaseV2,type AwgSlotReceiptV2}
  from '../../packages/provisioning/src/awg-device-lease-v2.ts';
import {stageOwnerAwgSlotGrant,stageOwnerAwgSlotRevoke,
  claimOwnerAwgSlotCommand,acknowledgeOwnerAwgSlotCommand}
  from '../../packages/provisioning/src/awg-slot-v2-outbox.ts';

const NODE='fi-test-01' as const;
const HOST='fi.mnebyvpn.site';
const pool=new Pool({
  host:'127.0.0.1',port:5432,user:'test',password:'test',
  database:'mnebyvpn_test',max:3,connectionTimeoutMillis:3000,
});
const pubKey=()=>randomBytes(32).toString('base64');

test('owner three V2 slots: bill-gated stage -> signed ACK x3 -> one-slot revoke',async()=>{
  assert.equal(process.env.PGDATABASE,'mnebyvpn_test',
    'Refuse non-disposable PostgreSQL');
  const controller=generateKeyPairSync('ed25519');
  const node=generateKeyPairSync('ed25519');
  const nodeSpki=node.publicKey.export({format:'der',type:'spki'}).toString('base64url');
  const owner=882913;
  const label='v2_'+randomUUID().replaceAll('-','').slice(0,13);
  const sale=await registerOfflineSale(pool,owner,owner,
    String(Date.now()),'@'+label+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(sale.text)?.[1];
  assert.ok(orderId,sale.text);
  const entitlement=(await pool.query(
    "SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",
    [orderId])).rows[0]?.id as string;
  assert.ok(entitlement);
  const signedReceipt=(command:AwgSlotLeaseV2):AwgSlotReceiptV2=>{
    const payload={
      nodeId:command.nodeId,op:command.op,
      entitlementId:command.entitlementId,slotNumber:command.slotNumber,
      revision:command.revision,
      commandSha256:createHash('sha256').update(awgSlotLeasePayload(command))
        .digest('hex'),
      appliedAt:new Date().toISOString(),nonce:randomBytes(32).toString('hex'),
    };
    return {...payload,signature:sign(null,awgSlotReceiptPayload(payload),
      node.privateKey).toString('base64url')};
  };
  const request=(slot:number,key:string)=>pool.query<{result:string}>(
    'SELECT public.owner_vpn_request_device_key('+
    '$1::bigint,$2::uuid,$3::smallint,$4::text) AS result',
    [owner,orderId,slot,key]).then(r=>r.rows[0].result);
  const setGate=(enabled:boolean)=>pool.query(
    "UPDATE vpn_release_flags SET enabled=$1 WHERE feature='owner_awg_slot_v2'",
    [enabled]);
  try{
    await pool.query(
      "UPDATE entitlements SET state='ACTIVE' WHERE id=$1",
      [entitlement]);
    await pool.query(
      'INSERT INTO provisioning_state('+
      'entitlement_id,adapter,applied_revision,last_observed_at) '+
      "VALUES($1,'vpn',1,clock_timestamp()) "+
      'ON CONFLICT(entitlement_id,adapter) DO UPDATE '+
      'SET applied_revision=1,last_observed_at=clock_timestamp()',
      [entitlement]);

    const keys=[pubKey(),pubKey(),pubKey()];
    for(let i=0;i<3;i++)
      assert.equal(await request(i+1,keys[i]),'REQUESTED');

    // Test-only exact FI enrollment with a consumed nonce. No host contacted.
    await pool.query(
      'INSERT INTO vpn_node_enrollment_inventory('+
      'node_id,endpoint_host,identity_public_spki) VALUES($1,$2,$3)',
      [NODE,HOST,nodeSpki]);
    await pool.query(
      "UPDATE vpn_node_enrollment_inventory SET status='approved',"+
      'approved_at=clock_timestamp() WHERE node_id=$1',
      [NODE]);
    await pool.query(
      'INSERT INTO vpn_node_enrollment_challenges('+
      'challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at) '+
      'VALUES($1,$2,$3,clock_timestamp()-interval \'1 second\','+
      "clock_timestamp()+interval '2 minutes',clock_timestamp())",
      [randomUUID(),NODE,randomBytes(32).toString('hex')]);
    await pool.query(
      "UPDATE vpn_node_enrollment_inventory SET status='enrolled',"+
      'enrolled_at=clock_timestamp() WHERE node_id=$1',[NODE]);
    await pool.query(
      'INSERT INTO vpn_awg_node_pools('+
      'node_id,endpoint_host,server_public_key,subnet_cidr,state,'+
      'external_e2e_proof_sha256,verified_at) '+
      "VALUES($1,$2,$3,'10.73.91.0/24','verified',$4,clock_timestamp())",
      [NODE,HOST,pubKey(),'a'.repeat(64)]);

    const stage=(slot:1|2|3,expectedRevision:number)=>stageOwnerAwgSlotGrant(
      pool,{operatorTelegramId:owner,orderId:orderId!,
        nodeId:NODE,slotNumber:slot,expectedRevision},
      controller.privateKey);
    assert.equal((await pool.query(
      "SELECT enabled FROM vpn_release_flags WHERE feature='owner_awg_slot_v2'"
    )).rows[0].enabled,false,'private release gate must start disabled');
    await assert.rejects(stage(1,0),/V2 release or current manual sale not approved/);
    assert.equal((await pool.query(
      'SELECT count(*)::int n FROM owner_vpn_awg_slot_allocations '+
      'WHERE entitlement_id=$1',[entitlement])).rows[0].n,0);
    await setGate(true);
    const staged=await Promise.all([stage(1,0),stage(2,0),stage(3,0)]);
    assert.ok(staged.every(s=>s.staged===true&&s.published===false));
    assert.deepEqual(staged.map(s=>s.command.slotNumber),[1,2,3]);
    const addresses=staged.map(s=>s.command.clientIpv4);
    assert.equal(new Set(addresses).size,3);
    assert.deepEqual(addresses.slice().sort(),
      ['10.73.91.2','10.73.91.3','10.73.91.4']);
    await assert.rejects(stage(1,0),/Stale or revoked V2 device seat/);
    const oldCount=(await pool.query(
      'SELECT count(*)::int n FROM vpn_awg_command_outbox WHERE entitlement_id=$1',
      [entitlement])).rows[0].n;
    assert.equal(oldCount,0,'V1 outbox must stay untouched');

    const claimed=[];
    for(let i=0;i<3;i++){
      const item=await claimOwnerAwgSlotCommand(pool,controller.privateKey);
      assert.ok(item,'Expected each queued V2 command');
      claimed.push(item);
    }
    assert.equal(await claimOwnerAwgSlotCommand(pool,controller.privateKey),null);
    for(const item of claimed){
      if(item.command.slotNumber===1){
        await assert.rejects(acknowledgeOwnerAwgSlotCommand(pool,{
          outboxId:item.outboxId,
          receipt:{...signedReceipt(item.command),slotNumber:2},
        },controller.privateKey),/Invalid slot-bound node ACK signature/);
      }
      const receipt=signedReceipt(item.command);
      assert.deepEqual(await acknowledgeOwnerAwgSlotCommand(pool,{
        outboxId:item.outboxId,receipt},controller.privateKey),
        {acknowledged:true,published:false});
      await assert.rejects(acknowledgeOwnerAwgSlotCommand(pool,{
        outboxId:item.outboxId,receipt},controller.privateKey),
        /Unknown or unclaimed V2 signed command/);
    }
    const applied=(await pool.query(
      'SELECT slot_number,state,applied_at FROM owner_vpn_awg_slot_allocations '+
      'WHERE node_id=$1 AND entitlement_id=$2 ORDER BY slot_number',
      [NODE,entitlement])).rows;
    assert.deepEqual(applied.map(x=>x.state),['applied','applied','applied']);
    assert.ok(applied.every(x=>x.applied_at instanceof Date));
    assert.equal((await pool.query(
      'SELECT count(*)::int n FROM owner_vpn_awg_slot_command_outbox '+
      "WHERE entitlement_id=$1 AND state='applied'",
      [entitlement])).rows[0].n,3);

    // A revoked seat must still be revocable when billing/release gate is OFF.
    await setGate(false);
    await pool.query("UPDATE entitlements SET state='SUSPENDED' WHERE id=$1",
      [entitlement]);
    const revoked=await stageOwnerAwgSlotRevoke(pool,{
      nodeId:NODE,entitlementId:entitlement,slotNumber:2,expectedRevision:1,
    },controller.privateKey);
    assert.equal(revoked.command.op,'revoke');
    assert.equal(revoked.command.slotNumber,2);
    const claimedRevocation=await claimOwnerAwgSlotCommand(
      pool,controller.privateKey);
    assert.ok(claimedRevocation);
    assert.equal(claimedRevocation.command.slotNumber,2);
    assert.equal(claimedRevocation.command.op,'revoke');
    await acknowledgeOwnerAwgSlotCommand(pool,{
      outboxId:claimedRevocation.outboxId,
      receipt:signedReceipt(claimedRevocation.command),
    },controller.privateKey);
    const after=(await pool.query(
      'SELECT slot_number,state,revision,expires_at,applied_at '+
      'FROM owner_vpn_awg_slot_allocations WHERE entitlement_id=$1 '+
      'ORDER BY slot_number',[entitlement])).rows;
    assert.deepEqual(after.map(x=>x.state),['applied','revoked','applied']);
    assert.deepEqual(after.map(x=>x.revision),[1,2,1]);
    assert.equal(after[1].expires_at,null);
    assert.ok(after[1].applied_at instanceof Date);
    await assert.rejects(stageOwnerAwgSlotRevoke(pool,{
      nodeId:NODE,entitlementId:entitlement,slotNumber:2,expectedRevision:1,
    },controller.privateKey),/Stale or missing V2 revocation target/);
    assert.equal((await pool.query(
      'SELECT count(*)::int n FROM vpn_awg_peer_allocations '+
      'WHERE entitlement_id=$1',[entitlement])).rows[0].n,0);
    assert.equal((await pool.query(
      'SELECT count(*)::int n FROM vpn_subscription_links '+
      'WHERE entitlement_id=$1',[entitlement])).rows[0].n,0);
  }finally{
    await setGate(false).catch(()=>{});
    await pool.end();
  }
});
