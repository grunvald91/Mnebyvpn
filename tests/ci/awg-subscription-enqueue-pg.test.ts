/** Only RU188 signed worker may enqueue previously paid/released FI AWG access.
 * Executed in disposable CI Postgres, never against customer database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';

const ROLE='fi_auto_enqueue_ci';
const KEY=Buffer.from(Array.from({length:32},(_,i)=>i+1)).toString('base64');

test('FI auto-enrollment DB gateway enforces one subscription owner without table INSERT',async()=>{
  if(process.env.PGDATABASE!=='mnebyvpn_test')
    throw Error('Refuse non-disposable database');
  const db=new Client();
  await db.connect();
  let tx=false;
  try{
    await db.query('BEGIN');tx=true;
    await db.query('CREATE ROLE '+ROLE+' NOLOGIN NOINHERIT');
    await db.query('GRANT USAGE ON SCHEMA public TO '+ROLE);
    await db.query(
      'GRANT EXECUTE ON FUNCTION public.awg_controller_enqueue_fi_subscription(uuid,text,bigint) TO '+ROLE);
    const privilege=await db.query(
      "SELECT has_table_privilege($1,'public.vpn_awg_device_requests','INSERT') AS can_insert",
      [ROLE]);
    assert.equal(privilege.rows[0]?.can_insert,false);
    await db.query('SET LOCAL ROLE '+ROLE);
    const absent=await db.query(
      'SELECT public.awg_controller_enqueue_fi_subscription($1::uuid,$2::text,$3::bigint) AS queued',
      ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',KEY,11]);
    assert.equal(absent.rows[0]?.queued,false);
    await db.query('SAVEPOINT cannot_direct_insert');
    await assert.rejects(db.query(
      "INSERT INTO public.vpn_awg_device_requests(entitlement_id,peer_public_key,billing_revision) VALUES('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',$1,11)",
      [KEY]),/permission denied/);
    await db.query('ROLLBACK TO SAVEPOINT cannot_direct_insert');
    await db.query('RESET ROLE');
  }finally{
    if(tx)await db.query('ROLLBACK');
    await db.end();
  }
});
