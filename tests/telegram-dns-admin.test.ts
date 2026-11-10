import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {
  dnsAdminOwner,normalizeDnsDomain,dnsAdminAdd,dnsAdminOracle,
  dnsAdminCancel,dnsAdminList,dnsAdminAction,dnsAdminReview,dnsAdminApply,dnsAdminKeep,DNS_ADMIN_PROMPT,
} from '../apps/service/src/dns-admin.ts';

test('public DNS hostname normalization never accepts URLs, wildcard or internal names',()=>{
  for(const [value,expected] of [
    ['ORACLE.COM','oracle.com'],[' Cloud.Oracle.Com. ','cloud.oracle.com'],
    ['graph.threads.net','graph.threads.net']
  ] as const)assert.equal(normalizeDnsDomain(value),expected);
  for(const bad of ['','localhost','localhost.local','evil.internal','example.invalid',
    '192.168.0.1','127.0.0.1','https://oracle.com','oracle.com:443','*.oracle.com',
    'or acle.com','oracle.com/path','foo.oracle.com\nIN A 1.2.3.4','oracle.com.evil.org:853',
    'xn--e1afmkfd.xn--p1ai','oracle..com','-oracle.com','oracle-.com','hello.test']){
    assert.equal(normalizeDnsDomain(bad),null,bad);
  }
});
test('DNS admin belongs to one trusted numeric private-chat ID',()=>{
  assert.equal(dnsAdminOwner({DNS_ADMIN_TELEGRAM_ID:'99887766'} as NodeJS.ProcessEnv),99887766);
  assert.equal(dnsAdminOwner({SUPPORT_TELEGRAM_OPERATOR_ID:'12345'} as NodeJS.ProcessEnv),12345);
  assert.equal(dnsAdminOwner({DNS_ADMIN_TELEGRAM_ID:'',SUPPORT_TELEGRAM_OPERATOR_ID:'12345'} as NodeJS.ProcessEnv),null);
  assert.equal(dnsAdminOwner({DNS_ADMIN_TELEGRAM_ID:'@owner'} as NodeJS.ProcessEnv),null);
});
test('domain operations are parameterized and remain pending, not active',async()=>{
  const calls:Array<{sql:string;args:unknown[]|undefined}>=[];
  const fake={
    query:async(sql:string,args?:unknown[])=>{
      calls.push({sql,args});
      if(sql.includes('INSERT')&&sql.includes('RETURNING'))
        return {rows:[{id:'8',domain:args?.[0],product:'custom',status:'PENDING'}]};
      if(sql.includes('SELECT'))return {rows:[{id:'8',domain:'oracle.com',product:'Oracle',status:'PENDING'}]};
      if(sql.includes('UPDATE'))return {rows:[{id:'8',domain:'oracle.com',product:'Oracle',status:'CANCELLED'}]};
      return {rowCount:1,rows:[]};
    },
  };
  const pg=fake as any;
  const add=await dnsAdminAdd(pg,99887766,'ORACLE.COM');
  assert.match(add.text,/В ОЧЕРЕДЬ ПРОВЕРКИ/);
  assert.doesNotMatch(add.text,/DNS включён/);
  assert.ok(add.reply_markup.inline_keyboard.flat().some(
    b=>b.callback_data==='dnsadmin:domain:8'));
  assert.deepEqual(calls[0].args,['oracle.com','custom',99887766]);
  assert.match(calls[0].sql,/ON CONFLICT \(domain\) DO UPDATE/);
  assert.match(calls[0].sql,/status IN \('CANCELLED','FAILED'\)/);
  const oracle=await dnsAdminOracle(pg,99887766);
  assert.match(oracle.text,/cloud\.oracle\.com/);
  assert.deepEqual(calls[1].args,['oracle.com',99887766]);
  assert.deepEqual(calls[2].args,['www.oracle.com',99887766]);
  assert.deepEqual(calls[3].args,['cloud.oracle.com',99887766]);
  const list=await dnsAdminList(pg);
  assert.match(list.text,/Ожидает проверки/);
  const cancel=await dnsAdminCancel(pg,99887766,'8');
  assert.match(cancel.text,/Заявка отменена/);
  assert.deepEqual(calls[calls.length-1].args,[8,99887766]);
  const denied=await dnsAdminAction(99887766,99887767,pg,'dnsadmin:list');
  assert.match(denied.text,/Доступ закрыт/);
  assert.equal(calls.length,6);
});
test('failed DB and invalid domain never pretend to apply DNS rules',async()=>{
  const noDb=await dnsAdminAdd(null,99887766,'oracle.com');
  assert.match(noDb.text,/Заявка не сохранена/);
  const rejected=await dnsAdminAdd(null,99887766,'https://oracle.com');
  assert.match(rejected.text,/Некорректный адрес/);
  assert.match((await dnsAdminList(null)).text,/База доменов недоступна/);
});

let child:ChildProcess;
let port=0;
const admin=993311001;
const visitor=883311002;
const secret='test_only_private_telegram_webhook';
const digest=createHash('sha256').update(secret).digest('hex');
const host=()=>`http://127.0.0.1:${port}`;
before(async()=>{
  const listener=createServer();
  await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const address=listener.address();
  if(!address||typeof address==='string')throw Error('No port');
  port=address.port;
  await new Promise<void>(resolve=>listener.close(()=>resolve()));
  child=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-cabinet-server.ts'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,DATABASE_URL:'',MNEBYVPN_ENV:'production',
      BOT_PUBLIC_INFO_ONLY:'no',BOT_PORT:String(port),
      TELEGRAM_WEBHOOK_SECRET_SHA256:digest,
      TELEGRAM_TOKEN_BOT:'',SUPPORT_TELEGRAM_OPERATOR_ID:'',
      DNS_ADMIN_TELEGRAM_ID:String(admin)},
  });
  let errors='';
  child.stderr?.on('data',b=>errors+=b.toString());
  for(let i=0;i<60;i++){
    try{if((await fetch(host()+'/healthz',{signal:AbortSignal.timeout(250)})).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Bot startup failed: '+errors);
});
after(()=>child?.kill('SIGTERM'));
const request=(body:unknown,token=secret)=>fetch(host()+'/webhooks/telegram',{
  method:'POST',
  headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':token},
  body:JSON.stringify(body),
});
const callback=(id:number,updateId:number,data:string)=>({
  update_id:updateId,
  callback_query:{id:'admin-test-'+updateId,from:{id},
    message:{chat:{id,type:'private'},message_id:100+updateId},data},
});
test('owner sees DNS admin button, visitor does not',async()=>{
  for(const [userId,expected] of [[admin,true],[visitor,false]] as const){
    const r=await request({update_id:1000+userId,message:{
      from:{id:userId},chat:{id:userId,type:'private'},text:'/start'}});
    assert.equal(r.status,200);
    const j=await r.json() as any;
    const buttons=j.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.some((b:any)=>b.callback_data==='dnsadmin:menu'),expected);
  }
});
test('visitor cannot call owner callback even if they guess its ID',async()=>{
  const r=await request(callback(visitor,102,'dnsadmin:list'));
  const j=await r.json() as any;
  assert.equal(j.method,'answerCallbackQuery');
  assert.equal(j.show_alert,true);
  assert.match(j.text,/Недоступно/);
});
test('owner can open panel, get force-reply prompt and add a pending request',async()=>{
  const menu=await (await request(callback(admin,103,'dnsadmin:menu'))).json() as any;
  assert.equal(menu.method,'editMessageText');
  assert.match(menu.text,/управление доменами/);
  const prompt=await (await request(callback(admin,104,'dnsadmin:add'))).json() as any;
  assert.equal(prompt.method,'sendMessage');
  assert.equal(prompt.reply_markup.force_reply,true);
  assert.match(prompt.text,/Сохранение создаст ЗАЯВКУ/);
  const reply=await (await request({update_id:105,message:{
    from:{id:admin},chat:{id:admin,type:'private'},text:'oracle.com',
    reply_to_message:{from:{is_bot:true},text:DNS_ADMIN_PROMPT+'\nВведите имя'}}})).json() as any;
  assert.equal(reply.method,'sendMessage');
  assert.match(reply.text,/Заявка не сохранена/);
  assert.match((await (await request(callback(admin,106,'dnsadmin:list'))).json() as any).text,
    /База доменов недоступна/);
});
test('unsigned updates do not gain owner access',async()=>{
  assert.equal((await request(callback(admin,107,'dnsadmin:oracle'),'not-the-secret')).status,401);
});

test('two-step route deployment confirms only owner and never immediately claims ACTIVE',async()=>{
  const changes:string[]=[];
  const pg={query:async(sql:string,args?:unknown[])=>{
    changes.push(sql);
    if(sql.includes('SELECT'))return {rows:[{id:'42',domain:'oracle.com',product:'Oracle',status:'PENDING'}]};
    if(sql.includes('UPDATE')&&sql.includes('APPLY_REQUESTED'))
      return {rows:[{id:'42',domain:'oracle.com',product:'Oracle',status:'APPLY_REQUESTED'}]};
    if(sql.includes('UPDATE')&&sql.includes('CONFIRM_REQUESTED'))
      return {rows:[{id:'42',domain:'oracle.com',product:'Oracle',status:'CONFIRM_REQUESTED'}]};
    return {rows:[]};
  }} as any;
  const owner=333444555;
  const review=await dnsAdminReview(pg,'apply','42');
  assert.match(review.text,/60-минутный/);
  assert.equal(review.reply_markup.inline_keyboard[0][0].callback_data,'dnsadmin:yes-apply:42');
  const queued=await dnsAdminAction(owner,owner,pg,'dnsadmin:yes-apply:42');
  assert.match(queued.text,/Запрос на тест записан/);
  assert.doesNotMatch(queued.text,/уже активен/i);
  assert.ok(changes.some(x=>x.includes("status='APPLY_REQUESTED'")));
  const outsider=await dnsAdminAction(owner,owner+1,pg,'dnsadmin:yes-apply:42');
  assert.match(outsider.text,/Доступ закрыт/);
  assert.equal(changes.length,2);
  assert.match((await dnsAdminApply(null,owner,'42')).text,/База доменов недоступна/);
  assert.match((await dnsAdminKeep(null,owner,'42')).text,/База доменов недоступна/);
});
test('confirmation and rollback controls appear only for temporary or live routes',async()=>{
  const pg={
    query:async(sql:string,args?:unknown[])=>{
      if(sql.includes('SELECT'))return {rows:[{id:'4',domain:'cloud.oracle.com',
        product:'Oracle',status:'CANARY',canary_expires_at:new Date('2026-11-10T12:00:00Z')}]};
      return {rows:[]};
    }
  } as any;
  assert.match((await dnsAdminList({query:async()=>({rows:[{id:'4',domain:'cloud.oracle.com',product:'Oracle',status:'PROBING'}]})} as any)).text,/Проверяется сервер/);
  const card=await dnsAdminAction(22,22,pg,'dnsadmin:domain:4');
  assert.match(card.text,/Тест 60 минут/);
  const items=card.reply_markup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(items.includes('dnsadmin:keep:4'));
  assert.ok(items.includes('dnsadmin:cancel:4'));
  const cancelReview=await dnsAdminReview(pg,'cancel','4');
  assert.equal(cancelReview.reply_markup.inline_keyboard[0][0].callback_data,'dnsadmin:yes-cancel:4');
});
