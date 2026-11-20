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
    const allow=await db.query(`
      SELECT count(*)::integer AS public_exec
      FROM pg_catalog.pg_proc p,
           pg_catalog.aclexplode(coalesce(p.proacl,
             pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.oid='public.vpn_awg_enforce_address_pool()'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE'`);
    assert.equal(allow.rows[0].public_exec,0);
  }finally{
    await db.end();
  }
});
