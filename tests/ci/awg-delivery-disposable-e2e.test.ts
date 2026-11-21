/**
 * End-to-end disposable DB integration of controller AWG delivery:
 * stage grant -> durable outbox -> pinned SSH argument validation -> claimed
 * command -> Ed25519 node ACK -> DB applied -> CAS revoke -> ACK -> replay
 * rejection. Runs AS ROOT only on a disposable GitHub Actions runner with
 * DISPOSABLE PostgreSQL and synthetic Ed25519 identities.
 *
 * The SSH "runner" and node receipt are deliberately simulated. This is not
 * evidence that a real FI217 AWG peer was applied; live customer rollout
 * remains separately gated. Never run against RU188 or a production DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign,verify}
  from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {
  beginNodeEnrollment,completeNodeEnrollment,enrollmentChallengeMessage,
} from '../../packages/provisioning/src/node-enrollment.ts';
import {awgControllerPayload,stageAwgGrant,stageAwgRevoke,
  type SignedAwgLease} from '../../packages/provisioning/src/awg-controller-grants.ts';
import {acknowledgeAwgCommand,nodeAwgReceiptPayload,
  type NodeAwgReceipt} from '../../packages/provisioning/src/awg-controller-outbox.ts';
import {deliverNextAwgCommand} from '../../packages/provisioning/src/awg-trusted-ssh-delivery.ts';

const FI='fi-test-01';
const HOST='fi.mnebyvpn.site';
const GATE="vpn_awg_clients";

test('disposable FI217 controller outbox -> verified node receipt -> CAS revoke',async()=>{
  assert.equal(process.getuid?.(),0,'Must run as root only on disposable CI');
  assert.equal(process.env.PGDATABASE??'mnebyvpn_test','mnebyvpn_test',
    'Never run AWG integration on a live controller database');
  // Hardcoded loopback disposable CI database. Never consume a potentially
  // inherited PGHOST/DATABASE_URL targeting a production controller.
  const db=new Pool({
    host:'127.0.0.1',port:5432,user:'test',password:'test',
    database:'mnebyvpn_test',max:2,connectionTimeoutMillis:2500,
  });
  const root=mkdtempSync(join(tmpdir(),'mnebyvpn-awg-e2e-'));
  const controller=generateKeyPairSync('ed25519');
  const node=generateKeyPairSync('ed25519');
  const pub=node.publicKey.export({format:'der',type:'spki'}).toString('base64url');
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
  const peer=randomBytes(32).toString('base64');
  const server=randomBytes(32).toString('base64');
  const now=()=>new Date();
  const sshKey=join(root,'ephemeral-controller-ssh');
  const hostPin=join(root,'ephemeral-known-hosts');
  writeFileSync(sshKey,'synthetic-ssh-identity\n',{mode:0o600});
  writeFileSync(hostPin,'fi.mnebyvpn.site ssh-ed25519 synthetic-pin\n',{mode:0o600});
  const receipts:NodeAwgReceipt[]=[];
  const seen:SignedAwgLease[]=[];
  const runner=(executable:string,args:string[],options:{input:string})=>{
    assert.equal(executable,'/usr/bin/ssh');
    assert(args.includes('HostKeyAlias=fi.mnebyvpn.site'));
    assert(args.includes('StrictHostKeyChecking=yes'));
    assert(args.includes('PasswordAuthentication=no'));
    assert(args.includes('BatchMode=yes'));
    assert(args.includes('root@217.11.167.91'));
    assert(args.some(x=>x.includes('--mode apply')),'Real delivery arguments required');
    const signed=JSON.parse(options.input) as SignedAwgLease;
    assert.equal(signed.nodeId,FI);
    assert.equal(signed.entitlementId,entitlement);
    assert.equal(verify(null,awgControllerPayload(signed),
      controller.publicKey,Buffer.from(signed.signature,'base64url')),true);
    seen.push(signed);
    const unsigned={
      nodeId:FI,op:signed.op,entitlementId:entitlement,
      revision:signed.revision,
      commandSha256:createHash('sha256').update(awgControllerPayload(signed)).digest('hex'),
      appliedAt:new Date().toISOString(),nonce:randomBytes(32).toString('hex'),
    };
    const receipt={
      ...unsigned,
      signature:sign(null,nodeAwgReceiptPayload(unsigned),node.privateKey)
        .toString('base64url'),
    };
    receipts.push(receipt);
    // This is a synchronous, local transport simulator, NOT an FI217 service
    // application. No SSH connection, AWG peer, or subscription is created.
    return {status:0,stdout:JSON.stringify({
      node_receipt:receipt,active:true,signed_command_verified:true,
    }),stderr:'',error:undefined};
  };
  try{
    const current=await db.query("SELECT enabled FROM vpn_release_flags WHERE feature=$1",[GATE]);
    assert.equal(current.rowCount,1,'AWG release gate missing');
    assert.equal(current.rows[0].enabled,false,
      'Test DB must start with client release OFF');

    await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    await db.query(
      "INSERT INTO orders(id,account_id,product,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn',0,'RUB','PAID')",[order,account]);
    await db.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,"+
      "revision,starts_at,expires_at) "+
      "VALUES($1,$2,$3,'vpn','ACTIVE',11,$4,$5)",
      [entitlement,account,order,new Date(Date.now()-3600_000),
       new Date(Date.now()+48*3600_000)],
    );

    await db.query(
      'INSERT INTO vpn_node_enrollment_inventory('+
      'node_id,endpoint_host,identity_public_spki) VALUES ($1,$2,$3)',
      [FI,HOST,pub],
    );
    await db.query(
      "UPDATE vpn_node_enrollment_inventory SET status='approved',"+
      "approved_at=clock_timestamp() WHERE node_id=$1",[FI]);
    const challenge=await beginNodeEnrollment(db,{
      nodeId:FI,endpointHost:HOST,publicSpki:pub,
    },controller.privateKey);
    const proof={
      nodeId:FI,endpointHost:HOST,publicSpki:pub,
      challengeId:challenge.challengeId,nonce:challenge.nonce,signature:'',
    };
    proof.signature=sign(null,enrollmentChallengeMessage(proof),
      node.privateKey).toString('base64url');
    assert.deepEqual(await completeNodeEnrollment(db,proof),
      {nodeId:FI,state:'testing'});
    await db.query(
      'INSERT INTO vpn_awg_node_pools('+
      'node_id,endpoint_host,server_public_key,subnet_cidr,state,'+
      'external_e2e_proof_sha256,verified_at) '+
      "VALUES($1,$2,$3,'10.73.91.0/24','verified',$4,clock_timestamp())",
      [FI,HOST,server,'a'.repeat(64)],
    );
    const input={
      nodeId:FI,entitlementId:entitlement,
      peerPublicKey:peer,expectedBillingRevision:11,
    };

    // Gate must reject even legitimate paid entitlement while unpublished.
    await assert.rejects(stageAwgGrant(db,input,controller.privateKey,now()),
      /release is not enabled/);
    const before=await db.query(
      'SELECT count(*)::int AS n FROM vpn_awg_peer_allocations WHERE node_id=$1',
      [FI]);
    assert.equal(before.rows[0].n,0);
    await db.query('UPDATE vpn_release_flags SET enabled=true WHERE feature=$1',[GATE]);

    // A separate reserved owner IP exists before a normal FI subscriber
    // grant. Legacy IPAM must skip it instead of selecting .2 again.
    const reservedOwnerIp='10.73.91.2/32';
    await db.query(
      'INSERT INTO vpn_awg_ipv4_claims('+
      'node_id,client_ipv4,entitlement_id,device_slot,peer_public_key,source) '+
      "VALUES($1,$2::inet,$3,1,$4,'owner_slot')",
      [FI,reservedOwnerIp,randomUUID(),randomBytes(32).toString('base64')],
    );
    const staged=await stageAwgGrant(db,input,controller.privateKey,now());
    assert.equal(staged.command.clientIpv4,'10.73.91.3',
      'legacy controller must skip IP already claimed by an owner seat');
    assert.equal(staged.staged,true);
    assert.equal(staged.published,false);
    assert.equal(staged.command.op,'grant');
    assert.equal(staged.command.revision,1);
    const grant=await deliverNextAwgCommand(
      db,controller.privateKey,
      {sshIdentityFile:sshKey,pinnedKnownHostsFile:hostPin},
      now(),runner,
    );
    assert.equal(grant.status,'acknowledged');
    assert.equal(receipts.length,1);
    assert.equal(seen[0].op,'grant');
    const grantDb=await db.query(
      'SELECT o.state AS outbox_state,o.node_receipt_sha256,'+
      'p.state AS allocation_state,p.applied_at '+
      'FROM vpn_awg_command_outbox o JOIN vpn_awg_peer_allocations p '+
      'ON p.node_id=o.node_id AND p.entitlement_id=o.entitlement_id '+
      'WHERE o.node_id=$1 AND o.entitlement_id=$2 AND o.revision=1',[FI,entitlement]);
    assert.equal(grantDb.rows[0].outbox_state,'applied');
    assert.equal(grantDb.rows[0].allocation_state,'applied');
    assert(grantDb.rows[0].applied_at instanceof Date);
    assert.match(grantDb.rows[0].node_receipt_sha256,/^[a-f0-9]{64}$/);

    // Revoke must still be deliverable when release gate was switched off.
    await db.query('UPDATE vpn_release_flags SET enabled=false WHERE feature=$1',[GATE]);
    await assert.rejects(stageAwgRevoke(db,{
      nodeId:FI,entitlementId:entitlement,expectedAllocationRevision:1,
      expectedAllocationState:'staged',
    },controller.privateKey,now()),/Stale offline revocation candidate/);
    const revoked=await stageAwgRevoke(db,{
      nodeId:FI,entitlementId:entitlement,expectedAllocationRevision:1,
      expectedAllocationState:'applied',
    },controller.privateKey,now());
    assert.equal(revoked.staged,true);
    assert.equal(revoked.published,false);
    assert.equal(revoked.command.op,'revoke');
    assert.equal(revoked.command.revision,2);

    const revoke=await deliverNextAwgCommand(
      db,controller.privateKey,
      {sshIdentityFile:sshKey,pinnedKnownHostsFile:hostPin},
      now(),runner,
    );
    assert.equal(revoke.status,'acknowledged');
    assert.deepEqual(seen.map(x=>x.op),['grant','revoke']);
    const after=await db.query(
      'SELECT p.revision,p.state,p.expires_at,p.applied_at,'+
      '(SELECT count(*)::int FROM vpn_awg_command_outbox o '+
      " WHERE o.node_id=p.node_id AND o.entitlement_id=p.entitlement_id"+
      " AND o.state='applied') AS applied_commands "+
      'FROM vpn_awg_peer_allocations p '+
      'WHERE p.node_id=$1 AND p.entitlement_id=$2',[FI,entitlement]);
    assert.equal(after.rows[0].revision,2);
    assert.equal(after.rows[0].state,'revoked');
    assert.equal(after.rows[0].expires_at,null);
    assert(after.rows[0].applied_at instanceof Date);
    assert.equal(after.rows[0].applied_commands,2);

    await assert.rejects(acknowledgeAwgCommand(db,{
      outboxId:(grant as {outboxId:string}).outboxId,receipt:receipts[0],
    }),/Receipt does not match claimed command/);
    const published=await db.query(
      'SELECT count(*)::int AS n FROM vpn_additional_node_receipts '+
      'WHERE entitlement_id=$1',[entitlement]);
    assert.equal(published.rows[0].n,0);
    const stillOff=await db.query(
      'SELECT enabled FROM vpn_release_flags WHERE feature=$1',[GATE]);
    assert.equal(stillOff.rows[0].enabled,false);
    console.log('FI_AWG_DISPOSABLE_DB_E2E=grant_ack_revoke_ack_replay_blocked;'+
      'REAL_FI_SSH=false;REAL_PEERS_MODIFIED=false;CUSTOMER_RELEASE=false');
  }finally{
    // Safety cleanup only in the explicitly disposable, throwaway CI database.
    await db.query('UPDATE vpn_release_flags SET enabled=false WHERE feature=$1',[GATE])
      .catch(()=>{});
    await db.end();
    rmSync(root,{recursive:true,force:true});
  }
});
