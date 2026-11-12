import test from 'node:test';
import assert from 'node:assert/strict';
import type {Socket} from 'node:net';
import type {Pool} from 'pg';
import {identifyPaidDnsFromAcceptedSocket} from
  '../packages/dns-ingress/src/socket-ipv6-identity.ts';

const asSocket=(localAddress:string,destroyed=false)=>
  ({localAddress,destroyed}) as Socket;

test('shared IPv4, mapped IPv4 and missing destination never call identity DB',async()=>{
  let calls=0;
  const db={
    query:async()=>{calls++;return {rows:[{entitlement_id:'fake',entitlement_revision:'1'}]};},
  } as unknown as Pick<Pool,'query'>;
  for(const address of ['127.0.0.1','203.0.113.1',
    '::ffff:127.0.0.1','0:0:0:0:0:ffff:127.0.0.1','invalid']) {
    assert.equal(await identifyPaidDnsFromAcceptedSocket(asSocket(address),db),null);
  }
  assert.equal(await identifyPaidDnsFromAcceptedSocket(asSocket('::1',true),db),null);
  assert.equal(calls,0);
});

test('only a DB-confirmed accepted IPv6 destination becomes a trusted identity',async()=>{
  let calls=0;
  const db={
    query:async(text:string,params:unknown[])=>{
      calls++;
      assert.match(text,/dns_ingress_identify_destination_ipv6/);
      assert.deepEqual(params,['2001:db8::a']);
      return {rows:[{entitlement_id:'11111111-1111-4111-8111-111111111111',
                     entitlement_revision:'7'}]};
    },
  } as unknown as Pick<Pool,'query'>;
  const result=await identifyPaidDnsFromAcceptedSocket(
    asSocket('2001:db8::a'),db);
  assert.deepEqual(result,{
    entitlementId:'11111111-1111-4111-8111-111111111111',revision:'7'});
  assert.equal(calls,1);
});

test('unknown destination, db denial and hung identity check fail closed',async()=>{
  const deny={query:async()=>({rows:[]})} as unknown as Pick<Pool,'query'>;
  assert.equal(await identifyPaidDnsFromAcceptedSocket(asSocket('::1'),deny),null);
  const broken={query:async()=>{throw Error('db unavailable');}} as unknown as Pick<Pool,'query'>;
  assert.equal(await identifyPaidDnsFromAcceptedSocket(asSocket('::1'),broken),null);
  const never={query:()=>new Promise(()=>{})} as unknown as Pick<Pool,'query'>;
  assert.equal(await identifyPaidDnsFromAcceptedSocket(asSocket('::1'),never,50),null);
});
