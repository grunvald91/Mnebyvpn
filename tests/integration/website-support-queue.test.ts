import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';

test('website accepts a queued support request without a runtime Telegram token and restricts access by opaque cookie',async()=>{
  const dbUrl='postgresql://'+(process.env.PGUSER||'test')+':'+
    (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
    (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
  const pool=new Pool({connectionString:dbUrl,max:2});
  const socket=createServer();
  await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const address=socket.address();
  if(!address||typeof address==='string')throw Error('No free TCP port');
  const port=address.port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,
    ['--experimental-strip-types','apps/web/src/server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,WEB_PORT:String(port),MNEBYVPN_ENV:'offline-test',
      WEB_BASE_URL:origin,WEB_SESSION_SECRET:'a'.repeat(48),
      DATABASE_URL:dbUrl,TELEGRAM_TOKEN_BOT:'',
      SUPPORT_TELEGRAM_OPERATOR_ID:'111111',
      WEB_GUEST_TRIAL_ENABLED:'no',WEB_TELEGRAM_OIDC_ENABLED:'no'},
  });
  let errors='';
  child.stderr?.on('data',chunk=>errors+=chunk.toString());
  const contact='queued_'+Date.now()+'@example.com';
  let ticketId='';
  try{
    let ready=false;
    for(let i=0;i<65;i++){
      try{if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(250)})).ok){
        ready=true;break;
      }}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,'web did not start: '+errors);
    const status=await fetch(origin+'/api/support/status');
    assert.deepEqual(await status.json(),{available:true});
    const create=await fetch(origin+'/api/support',{
      method:'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({contact,message:'Нужна помощь с VPN-подключением',website:''}),
    });
    assert.equal(create.status,200,'website queued support response');
    const response=await create.json() as any;
    assert.equal(response.queued,true);
    assert.equal(response.delivered,undefined,'never claim Telegram delivery');
    const cookie=(create.headers.get('set-cookie')||'').split(';')[0];
    assert.match(cookie,/^mnebyvpn_support=/);
    const rows=await pool.query(
      'SELECT id,delivery_state,answer FROM website_support_tickets WHERE contact=$1',
      [contact]);
    assert.equal(rows.rowCount,1);
    ticketId=rows.rows[0].id;
    assert.equal(rows.rows[0].delivery_state,'PENDING');
    assert.equal(rows.rows[0].answer,null);
    const privateTicket=await fetch(origin+'/api/support/ticket',{headers:{Cookie:cookie}});
    const initial=await privateTicket.json() as any;
    assert.equal(initial.status,'PENDING');
    assert.equal(initial.answer,null);
    const unowned=await fetch(origin+'/api/support/ticket');
    assert.deepEqual(await unowned.json(),{status:'NONE'});
    const answer='Подключите новый профиль и проверьте интернет.';
    await pool.query(
      'UPDATE website_support_tickets SET answer=$2,answered_at=now() WHERE id=$1',
      [ticketId,answer]);
    const returned=await fetch(origin+'/api/support/ticket',{headers:{Cookie:cookie}});
    const final=await returned.json() as any;
    assert.equal(final.answer,answer);
  }finally{
    child.kill('SIGTERM');
    if(ticketId)await pool.query('DELETE FROM website_support_tickets WHERE id=$1',[ticketId]).catch(()=>{});
    await pool.end();
  }
});
