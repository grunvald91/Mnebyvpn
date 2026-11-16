import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {Pool} from 'pg';
import {
  beginNodeEnrollment,completeNodeEnrollment,enrollmentChallengeMessage,
  enrollmentControllerChallengeMessage,
} from '../../packages/provisioning/src/node-enrollment.ts';

test('operator-approved node enrollment uses signed challenges and atomic one-time PG nonce',async()=>{
  const pool=new Pool({
    host:process.env.PGHOST||'localhost',
    port:Number(process.env.PGPORT||5432),
    user:process.env.PGUSER||'test',
    password:process.env.PGPASSWORD||'test',
    database:process.env.PGDATABASE||'mnebyvpn_test',
  });
  const suffix=randomUUID().slice(0,8);
  const nodeId='nl-node-'+suffix;
  const host=nodeId+'.example.net';
  const nodePair=generateKeyPairSync('ed25519');
  const controllerPair=generateKeyPairSync('ed25519');
  const publicSpki=nodePair.publicKey.export({format:'der',type:'spki'})
    .toString('base64url');
  const request={nodeId,endpointHost:host,publicSpki};
  try{
    await pool.query(
      'INSERT INTO vpn_node_enrollment_inventory('+
      'node_id,endpoint_host,identity_public_spki,status,approved_at) '+
      "VALUES($1,$2,$3,'planned',NULL)",
      [nodeId,host,publicSpki]);
    await assert.rejects(beginNodeEnrollment(pool,request,controllerPair.privateKey),
      /not independently approved/);
    await pool.query(
      "UPDATE vpn_node_enrollment_inventory SET status='approved',approved_at=clock_timestamp() "+
      'WHERE node_id=$1',[nodeId]);
    await assert.rejects(beginNodeEnrollment(pool,{...request,endpointHost:'fake.example.net'},
      controllerPair.privateKey),/not independently approved/);
    await assert.rejects(beginNodeEnrollment(pool,
      {...request,publicSpki:controllerPair.publicKey.export({format:'der',type:'spki'}).toString('base64url')},
      controllerPair.privateKey),/not independently approved/);
    const challenge=await beginNodeEnrollment(pool,request,controllerPair.privateKey);
    const validControllerSignature=verify(
      null,enrollmentControllerChallengeMessage(challenge),controllerPair.publicKey,
      Buffer.from(challenge.controllerSignature,'base64url'));
    assert.equal(validControllerSignature,true);
    assert.ok(challenge.expiresAt.getTime()>Date.now());
    await assert.rejects(beginNodeEnrollment(pool,request,controllerPair.privateKey),
      /already active/);
    const proof={
      nodeId,endpointHost:host,publicSpki,
      challengeId:challenge.challengeId,nonce:challenge.nonce,
      signature:'',
    };
    proof.signature=sign(null,enrollmentChallengeMessage(proof),nodePair.privateKey)
      .toString('base64url');
    await assert.rejects(completeNodeEnrollment(pool,{...proof,nonce:'0'.repeat(43)}),
      /Invalid node possession proof/);
    assert.deepEqual(await completeNodeEnrollment(pool,proof),
      {nodeId,state:'testing'});
    const enrolled=await pool.query(
      'SELECT status,enrolled_at FROM vpn_node_enrollment_inventory WHERE node_id=$1',[nodeId]);
    assert.equal(enrolled.rows[0].status,'enrolled');
    assert.ok(enrolled.rows[0].enrolled_at instanceof Date);
    await assert.rejects(completeNodeEnrollment(pool,proof),/reused challenge/);
    await assert.rejects(beginNodeEnrollment(pool,request,controllerPair.privateKey),
      /not independently approved/);
    await assert.rejects(pool.query(
      'UPDATE vpn_node_enrollment_inventory SET identity_public_spki=$1 WHERE node_id=$2',
      [controllerPair.publicKey.export({format:'der',type:'spki'}).toString('base64url'),nodeId]),
    /immutable/);
    // A signed enrollment is NOT the same as a public VPN profile.
    const published=await pool.query(
      'SELECT count(*)::int AS total FROM vpn_additional_nodes WHERE node_id=$1',[nodeId]);
    assert.equal(published.rows[0].total,0);
  }finally{
    await pool.query(
      'DELETE FROM vpn_node_enrollment_challenges WHERE node_id=$1',[nodeId]).catch(()=>{});
    await pool.query(
      'DELETE FROM vpn_node_enrollment_inventory WHERE node_id=$1',[nodeId]).catch(()=>{});
    await pool.end();
  }
});

test('expired challenge is unredeemable despite valid node signature',async()=>{
  const pool=new Pool({
    host:process.env.PGHOST||'localhost',
    port:Number(process.env.PGPORT||5432),
    user:process.env.PGUSER||'test',
    password:process.env.PGPASSWORD||'test',
    database:process.env.PGDATABASE||'mnebyvpn_test',
  });
  const suffix=randomUUID().slice(0,8),nodeId='de-node-'+suffix;
  const host=nodeId+'.example.net';
  const nodePair=generateKeyPairSync('ed25519');
  const controllerPair=generateKeyPairSync('ed25519');
  const publicSpki=nodePair.publicKey.export({format:'der',type:'spki'})
    .toString('base64url');
  try{
    await pool.query(
      'INSERT INTO vpn_node_enrollment_inventory('+
      'node_id,endpoint_host,identity_public_spki,status,approved_at) '+
      "VALUES($1,$2,$3,'approved',clock_timestamp())",
      [nodeId,host,publicSpki]);
    const challenge=await beginNodeEnrollment(pool,
      {nodeId,endpointHost:host,publicSpki},controllerPair.privateKey);
    const proof={
      nodeId,endpointHost:host,publicSpki,
      nonce:challenge.nonce,challengeId:challenge.challengeId,signature:'',
    };
    proof.signature=sign(null,enrollmentChallengeMessage(proof),nodePair.privateKey)
      .toString('base64url');
    await pool.query(
      'UPDATE vpn_node_enrollment_challenges '+
      "SET issued_at=clock_timestamp()-interval '10 minutes',"+
      "expires_at=clock_timestamp()-interval '6 minutes' "+
      'WHERE challenge_id=$1',[challenge.challengeId]);
    await assert.rejects(completeNodeEnrollment(pool,proof),/expired/);
    const result=await pool.query(
      'SELECT status FROM vpn_node_enrollment_inventory WHERE node_id=$1',[nodeId]);
    assert.equal(result.rows[0].status,'approved');
  }finally{
    await pool.query('DELETE FROM vpn_node_enrollment_challenges WHERE node_id=$1',[nodeId])
      .catch(()=>{});
    await pool.query('DELETE FROM vpn_node_enrollment_inventory WHERE node_id=$1',[nodeId])
      .catch(()=>{});
    await pool.end();
  }
});
