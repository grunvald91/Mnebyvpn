import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';

test('Telegram notification outage leaves website ticket queued, readable and answerable by operator',async()=>{
  const dbUrl='postgresql://'+(process.env.PGUSER||'test')+':'+
    (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
    (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
  const pool=new Pool({connectionString:dbUrl,max:2});
  const socket=createServer();
  await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const addr=socket.address();
  if(!addr||typeof addr==='string')throw Error('No free port');
  const port=addr.port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const origin='http://127.0.0.1:'+port;
  const bridgeKey='c'.repeat(64);
  const child=spawn(process.execPath,[
    '--experimental-strip-types',
    '--import','./tests/fixtures/mock-telegram-outage.mjs',
    'apps/web/src/server.ts',
  ],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,WEB_PORT:String(port),MNEBYVPN_ENV:'offline-test',
      WEB_BASE_URL:origin,WEB_SESSION_SECRET:'a'.repeat(48),
      DATABASE_URL:dbUrl,TELEGRAM_TOKEN_BOT:'123456:'+'a'.repeat(35),
      SUPPORT_TELEGRAM_OPERATOR_ID:'111111',SUPPORT_BRIDGE_SECRET:bridgeKey,
      WEB_GUEST_TRIAL_ENABLED:'no',WEB_TELEGRAM_OIDC_ENABLED:'no'},
  });
  let stderr='',ticketId='';
  child.stderr?.on('data',(chunk:Buffer)=>stderr+=chunk.toString());
  const contact='outage_'+Date.now()+'@example.com';
  try{
    let started=false;
    for(let i=0;i<70;i++){
      try{
        if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(300)})).ok){
          started=true;break;
        }
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(started,'website did not start: '+stderr);
    const created=await fetch(origin+'/api/support',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({
        contact,message:'После оплаты VPN подключение не работает',website:'',
      }),
    });
    assert.equal(created.status,200,'customer should not see error after durable insert');
    assert.deepEqual(await created.json(),{queued:true,webTicket:true});
    const cookie=(created.headers.get('set-cookie')??'').split(';')[0];
    assert.match(cookie,/^mnebyvpn_support=/);
    const db=await pool.query(
      'SELECT id,delivery_state,answer FROM website_support_tickets WHERE contact=$1',
      [contact]);
    assert.equal(db.rowCount,1);
    ticketId=db.rows[0].id;
    assert.equal(db.rows[0].delivery_state,'PENDING');
    assert.equal(db.rows[0].answer,null);

    const stamp=String(Math.floor(Date.now()/1000));
    const inboxSignature=createHmac('sha256',bridgeKey)
      .update('MNEBYVPN-inbox-v1\n'+stamp).digest('hex');
    const inbox=await fetch(origin+'/api/support/operator-inbox',{
      headers:{'X-MNEBYVPN-Support-Ts':stamp,
        'X-MNEBYVPN-Support-Signature':inboxSignature},
    });
    assert.equal(inbox.status,200);
    const inboxData=await inbox.json() as any;
    assert.equal(inboxData.ticket?.id,ticketId);

    const message='Попробуйте обновить VPN-профиль и подключиться снова.';
    const signature=createHmac('sha256',bridgeKey)
      .update('MNEBYVPN-support\n'+ticketId+'\n'+message).digest('hex');
    const reply=await fetch(origin+'/api/support/operator-reply',{
      method:'POST',headers:{'Content-Type':'application/json',
        'X-MNEBYVPN-Support-Signature':signature},
      body:JSON.stringify({ticketId,message}),
    });
    assert.equal(reply.status,200);
    assert.deepEqual(await reply.json(),{saved:true});
    const ticket=await fetch(origin+'/api/support/ticket',{headers:{Cookie:cookie}});
    assert.equal(ticket.status,200);
    const state=await ticket.json() as any;
    assert.equal(state.status,'PENDING');
    assert.equal(state.answer,message);
  }finally{
    child.kill('SIGTERM');
    if(ticketId)await pool.query('DELETE FROM website_support_tickets WHERE id=$1',[ticketId]).catch(()=>{});
    await pool.end();
  }
});
