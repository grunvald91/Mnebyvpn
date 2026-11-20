import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';

test('FI pool trigger uses canonical pinned definer and private execution',async()=>{
  if(process.env.PGDATABASE!=='mnebyvpn_test')
    throw Error('Refuse non-disposable database');
  const db=new Client();
  await db.connect();
  try{
    const result=await db.query(`
      SELECT p.prosecdef,p.proconfig,p.proacl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='vpn_awg_enforce_address_pool'
      AND p.pronargs=0`);
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0].prosecdef,true);
    assert(result.rows[0].proconfig.includes('search_path=pg_catalog, public'));
    const allow=await db.query(
      "SELECT has_function_privilege('public','public.vpn_awg_enforce_address_pool()','EXECUTE') AS granted");
    assert.equal(allow.rows[0].granted,false);
  }finally{
    await db.end();
  }
});
