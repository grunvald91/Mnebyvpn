import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';

test('website support tickets are private, operator replies are signed, and duplicate replies are rejected',async()=>{
  const dbUrl='postgresql://'+(process.env.PGUSER||'test')+':'+
    (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
    (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
  const pool=new Pool({connectionString:dbUrl,max:2});
  const socket=createServer();
  await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const address=socket.address();
  if(!address||typeof address==='string')throw Error('No test port');
  const port=address.port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const origin='http://127.0.0.1:'+port;
  const botToken='123456:'+('t'.repeat(36));
  const id=randomUUID(),opaque=randomBytes(32).toString('base64url');
  const sha=createHash('sha256').update(opaque).digest('hex');
  let stderr='';
  const child=spawn(process.execPath,['--experimental-strip-types','apps/web/src/server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,WEB_PORT:String(port),MNEBYVPN_ENV:'offline-test',
      WEB_BASE_URL:origin,WEB_SESSION_SECRET:'a'.repeat(48),
      DATABASE_URL:dbUrl,TELEGRAM_TOKEN_BOT:botToken,
      SUPPORT_TELEGRAM_OPERATOR_ID:'111111',WEB_GUEST_TRIAL_ENABLED:'no',
      WEB_TELEGRAM_OIDC_ENABLED:'no'},
  });
  child.stderr?.on('data',(data:Buffer)=>stderr+=data.toString());
  try{
    await pool.query(
      'INSERT INTO website_support_tickets (id,token_sha256,contact,question,delivery_state) VALUES ($1,$2,$3,$4,$5)',
      [id,sha,'@client_name','Проверка поддержки сайта','DELIVERED']);
    let ready=false;
    for(let i=0;i<70;i++){
      try{
        const r=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(300)});
        if(r.ok){ready=true;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,'website did not start: '+stderr);
    const status=await fetch(origin+'/api/support/status');
    assert.deepEqual(await status.json(),{available:true});
    const empty=await fetch(origin+'/api/support/ticket');
    assert.deepEqual(await empty.json(),{status:'NONE'});
    const cookie='mnebyvpn_support='+id+'.'+opaque;
    const ticket=await fetch(origin+'/api/support/ticket',{headers:{Cookie:cookie}});
    assert.deepEqual(await ticket.json(),{status:'DELIVERED',answer:null,answeredAt:null});
    const noAccess=await fetch(origin+'/api/support/ticket',{
      headers:{Cookie:'mnebyvpn_support='+id+'.'+randomBytes(32).toString('base64url')}});
    assert.deepEqual(await noAccess.json(),{status:'NONE'});
    const payload={ticketId:id,message:'Ваш вопрос решён. Проверьте новый профиль.'};
    const wrong=await fetch(origin+'/api/support/operator-reply',{
      method:'POST',headers:{'Content-Type':'application/json',
        'X-MNEBYVPN-Support-Signature':'f'.repeat(64)},body:JSON.stringify(payload)});
    assert.equal(wrong.status,403);
    const signature=createHmac('sha256',botToken).update(
      'MNEBYVPN-support\n'+id+'\n'+payload.message).digest('hex');
    const post=()=>fetch(origin+'/api/support/operator-reply',{
      method:'POST',headers:{'Content-Type':'application/json',
        'X-MNEBYVPN-Support-Signature':signature},body:JSON.stringify(payload)});
    const accepted=await post();
    assert.equal(accepted.status,200);
    assert.deepEqual(await accepted.json(),{saved:true});
    assert.equal((await post()).status,409);
    const answered=await fetch(origin+'/api/support/ticket',{headers:{Cookie:cookie}});
    const info=await answered.json() as any;
    assert.equal(info.answer,payload.message);
    assert.equal(info.status,'DELIVERED');
    assert.equal(typeof info.answeredAt,'string');
    const foreignOrigin=await fetch(origin+'/api/support',{
      method:'POST',headers:{Origin:'https://not-mnebyvpn.invalid','Content-Type':'application/json'},
      body:JSON.stringify({contact:'@client_name',message:'Проверить поддержку сайта'})});
    assert.equal(foreignOrigin.status,403);
  }finally{
    child.kill('SIGTERM');
    await pool.query('DELETE FROM website_support_tickets WHERE id=$1',[id]).catch(()=>{});
    await pool.end();
  }
});
