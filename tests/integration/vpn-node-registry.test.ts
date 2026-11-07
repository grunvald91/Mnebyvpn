import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgVpnNodeRegistry} from '../../packages/nodes/src/pg-registry.ts';

test('multi-node inventory stays dormant until separately approved and healthy',async()=>{
  const pool=new Pool({
    host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
    user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
    database:process.env.PGDATABASE??'mnebyvpn_test',max:4,
  });
  const registry=new PgVpnNodeRegistry(pool);
  const nodeId=randomUUID(),account=randomUUID(),order=randomUUID();
  const entitlement=randomUUID(),second=randomUUID();
  const request={capability:'vless-ws-tls'};
  try{
    await registry.registerPlanned({
      id:nodeId,code:'test-node-'+nodeId.slice(0,8),
      countryCode:'DE',kind:'normal',
      capabilities:['vless-ws-tls'],maxClients:1,
    });
    assert.equal(await registry.recordProbe(nodeId,true),true);
    assert.deepEqual(await registry.candidates(request),[]);
    await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    await pool.query(
      "INSERT INTO orders(id,account_id,product,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn',0,'RUB','PAID'),($3,$2,'vpn',0,'RUB','PAID')",
      [order,account,randomUUID()]).then(async result=>{
        // Both orders are discovered below, to avoid fixed global fixtures.
        assert.equal(result.rowCount,2);
      });
    const orders=await pool.query(
      'SELECT id FROM orders WHERE account_id=$1 ORDER BY id',[account]);
    await pool.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,expires_at) "+
      "VALUES($1,$3,$4,'vpn','ACTIVE',1,now()+interval '1 hour'),"+
      "($2,$3,$5,'vpn','ACTIVE',1,now()+interval '1 hour')",
      [entitlement,second,account,orders.rows[0].id,orders.rows[1].id]);
    assert.equal(await registry.reserve(entitlement,nodeId,request),'unavailable');
    // Operator attestation simulated only in disposable test DB.
    await pool.query(
      "UPDATE vpn_nodes SET state='verified',verified_at=clock_timestamp(),"+
      "verification_report_sha256=repeat('a',64),"+
      "operator_approved_at=clock_timestamp(),enabled_for_new=true WHERE id=$1",
      [nodeId]);
    assert.equal((await registry.candidates(request)).length,1);
    assert.equal(await registry.reserve(entitlement,nodeId,request),'reserved');
    assert.equal(await registry.reserve(entitlement,nodeId,request),'already');
    assert.equal(await registry.reserve(second,nodeId,request),'unavailable',
      'capacity 1 must block a second entitlement');
    const rows=await pool.query(
      'SELECT state,applied_revision FROM vpn_node_assignments WHERE node_id=$1',[nodeId]);
    assert.equal(rows.rows.length,1);
    assert.equal(rows.rows[0].state,'pending');
    assert.equal(Number(rows.rows[0].applied_revision),0);
    assert.equal(await registry.recordProbe(nodeId,false),true);
    assert.equal((await registry.candidates(request)).length,0);
  }finally{
    await pool.query('DELETE FROM vpn_node_assignments WHERE node_id=$1',[nodeId]).catch(()=>{});
    await pool.query('DELETE FROM entitlements WHERE account_id=$1',[account]).catch(()=>{});
    await pool.query('DELETE FROM orders WHERE account_id=$1',[account]).catch(()=>{});
    await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
    await pool.query('DELETE FROM vpn_nodes WHERE id=$1',[nodeId]).catch(()=>{});
    await pool.end();
  }
});
