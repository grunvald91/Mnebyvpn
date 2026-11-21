import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseSaleInput,offlineSalePrompt,offlineSaleMenu,registerOfflineSale,
  listOfflineSales,showOfflineSale} from '../apps/service/src/manual-sales.ts';

test('offline sale requires explicit actual amount; @username is only a label',()=>{
  assert.deepEqual(parseSaleInput('@OlgaB0307Ang 399'),
    {customerLabel:'olgab0307ang',amountMinor:39900,receiptReference:null});
  assert.deepEqual(parseSaleInput('Tani_3333u 350 TAXCHECK_1234'),
    {customerLabel:'tani_3333u',amountMinor:35000,receiptReference:'TAXCHECK_1234'});
  for(const s of ['@abc 399','@wrong! 399','@valid_name 0',
    '@valid_name -1','@valid_name 399.99','@valid_name 100001',
    '@valid_name 399 2026-11-21 MORE','@valid_name 399 ;DROP',
    '@valid_name','@valid_name 399'+'x'.repeat(200)]){
    assert.equal(parseSaleInput(s),null,s);
  }
  assert.match(offlineSalePrompt().text,/фактически_получено/);
  assert.match(offlineSaleMenu().text,/от первого подключения/);
});
test('non-owner, unknown owner and hostile request cannot create any sale or reveal links',async()=>{
  let calls=0;
  const db={connect:async()=>{calls++;throw Error('forbidden')},
    query:async()=>{calls++;throw Error('forbidden')}} as any;
  for(const owner of [null,99]){
    assert.match((await registerOfflineSale(db,100,owner,'23','@OlgaB0307Ang 399')).text,/Недостаточно прав/);
    assert.match((await listOfflineSales(db,100,owner,0)).text,/Недостаточно прав/);
    assert.match((await showOfflineSale(db,100,owner,randomUUID(),true,true,Buffer.alloc(32))).text,/Недостаточно прав/);
  }
  assert.match((await registerOfflineSale(db,100,100,'bad-key','@OlgaB0307Ang 399')).text,/Некорректный/);
  assert.equal(calls,0);
});
test('a repeated update does not insert a second order',async()=>{
  const queries:string[]=[];let commits=0;
  const orderId=randomUUID();
  const c={query:async(sql:string,args?:any[])=>{
    queries.push(sql);
    if(sql.startsWith('SELECT m.order_id'))return {rowCount:1,rows:[{
      order_id:orderId,customer_label:'tani_3333u',
      declared_amount_minor:'39900',receipt_reference:null,
    }]};
    if(sql==='COMMIT')commits++;
    return {rows:[],rowCount:0};
  },release:()=>{}} as any;
  const db={connect:async()=>c} as any;
  const result=await registerOfflineSale(db,100,100,'12345','@Tani_3333u 399');
  assert.match(result.text,/Операция уже учтена/);
  assert.match(result.text,new RegExp(orderId));
  assert.equal(commits,1);
  assert.ok(!queries.some(s=>s.startsWith('INSERT')));
});
test('a duplicate active label cannot provision two subscriptions',async()=>{
  const queries:string[]=[];let rollbacks=0;
  const c={query:async(sql:string)=>{
    queries.push(sql);
    if(sql.startsWith('SELECT m.order_id'))return {rowCount:0,rows:[]};
    if(sql.startsWith('SELECT 1 FROM manual_sales'))return {rowCount:1,rows:[{one:1}]};
    if(sql==='ROLLBACK')rollbacks++;
    return {rowCount:0,rows:[]};
  },release:()=>{}} as any;
  const result=await registerOfflineSale({connect:async()=>c} as any,
    100,100,'42','@Tani_3333u 399');
  assert.match(result.text,/уже существует/);
  assert.equal(rollbacks,1);
  assert.ok(!queries.some(s=>s.startsWith('INSERT')));
});
