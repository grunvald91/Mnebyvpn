import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';

async function freePort(){
  const s=createServer();
  await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve));
  const address=s.address();
  if(!address||typeof address==='string')throw Error('No test TCP port');
  await new Promise<void>(resolve=>s.close(()=>resolve()));
  return address.port;
}
async function ready(origin:string,stderr:()=>string){
  for(let i=0;i<70;i++){
    try{
      const response=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(300)});
      if(response.ok)return;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Service failed to start: '+stderr());
}

test('different web and bot databases share only signed localhost support inbox/replies; no Bot API secret',async()=>{
  const dbUrl='postgresql://'+(process.env.PGUSER||'test')+':'+
    (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
    (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
  const pool=new Pool({connectionString:dbUrl,max:2});
  const [webPort,botPort]=await Promise.all([freePort(),freePort()]);
  const base='http://127.0.0.1:'+webPort,botBase='http://127.0.0.1:'+botPort;
  const owner=444441111,customer=555551111;
  const bridgeSecret='c'.repeat(64);
  const secret='private_test_only_webhook_key';
  const digest=createHash('sha256').update(secret).digest('hex');
  const cwd=fileURLToPath(new URL('../../',import.meta.url));
  const errors:string[]=[];
  const spawnApp=(p:string,env:Record<string,string>)=>{
    const child=spawn(process.execPath,['--experimental-strip-types',p],{
      cwd,stdio:['ignore','ignore','pipe'],env:{...process.env,...env},
    });
    child.stderr?.on('data',chunk=>errors.push(chunk.toString()));
    return child;
  };
  const web=spawnApp('apps/web/src/server.ts',{
    WEB_PORT:String(webPort),WEB_BASE_URL:base,MNEBYVPN_ENV:'offline-test',
    WEB_SESSION_SECRET:'p'.repeat(48),DATABASE_URL:dbUrl,
    TELEGRAM_TOKEN_BOT:'',SUPPORT_TELEGRAM_OPERATOR_ID:String(owner),
    SUPPORT_BRIDGE_SECRET:bridgeSecret,WEB_GUEST_TRIAL_ENABLED:'no',
    WEB_TELEGRAM_OIDC_ENABLED:'no',
  });
  let bot:ChildProcess|null=null;
  let ticketId='',secondTicketId='';
  const update=(body:object)=>fetch(botBase+'/webhooks/telegram',{
    method:'POST',headers:{'Content-Type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(body),
  });
  try{
    await ready(base,()=>errors.join('\n'));
    bot=spawnApp('apps/service/src/telegram-cabinet-server.ts',{
      BOT_PORT:String(botPort),MNEBYVPN_ENV:'production',
      BOT_PUBLIC_INFO_ONLY:'no',DATABASE_URL:'',TELEGRAM_TOKEN_BOT:'',
      TELEGRAM_WEBHOOK_SECRET_SHA256:digest,
      SUPPORT_TELEGRAM_OPERATOR_ID:String(owner),
      SUPPORT_BRIDGE_SECRET:bridgeSecret,
      SUPPORT_WEBSITE_PORT:String(webPort),
    });
    await ready(botBase,()=>errors.join('\n'));
    assert.deepEqual(await (await fetch(base+'/api/support/status')).json(),
      {available:true});

    const contact='bridge_'+Date.now()+'@example.com';
    const create=await fetch(base+'/api/support',{
      method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({contact,message:'После оплаты VPN не подключается',website:''}),
    });
    assert.equal(create.status,200);
    assert.deepEqual(await create.json(),{queued:true,webTicket:true});
    const browserCookie=(create.headers.get('set-cookie')??'').split(';')[0];
    assert.match(browserCookie,/^mnebyvpn_support=/);
    const stored=await pool.query(
      'SELECT id,delivery_state FROM website_support_tickets WHERE contact=$1',[contact]);
    assert.equal(stored.rowCount,1);
    ticketId=stored.rows[0].id;
    assert.equal(stored.rows[0].delivery_state,'PENDING');

    const secondContact='second_'+Date.now()+'@example.com';
    const secondCreate=await fetch(base+'/api/support',{
      method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({contact:secondContact,
        message:'Вторая заявка для проверки кнопки Далее',website:''}),
    });
    assert.equal(secondCreate.status,200);
    const secondRow=await pool.query(
      'SELECT id FROM website_support_tickets WHERE contact=$1',[secondContact]);
    assert.equal(secondRow.rowCount,1);
    secondTicketId=secondRow.rows[0].id;

    const unsigned=await fetch(base+'/api/support/operator-inbox');
    assert.equal(unsigned.status,403);
    const now=String(Math.floor(Date.now()/1000));
    const forged=await fetch(base+'/api/support/operator-inbox',{headers:{
      'X-MNEBYVPN-Support-Ts':now,'X-MNEBYVPN-Support-Signature':'0'.repeat(64),
    }});
    assert.equal(forged.status,403);
    const stale=String(Math.floor(Date.now()/1000)-65);
    const staleSignature=createHmac('sha256',bridgeSecret)
      .update('MNEBYVPN-inbox-v1\n'+stale).digest('hex');
    assert.equal((await fetch(base+'/api/support/operator-inbox',{headers:{
      'X-MNEBYVPN-Support-Ts':stale,
      'X-MNEBYVPN-Support-Signature':staleSignature,
    }})).status,403);

    const ownerMenu=await update({update_id:4309,message:{
      from:{id:owner},chat:{id:owner,type:'private'},text:'/start',
    }});
    const home=await ownerMenu.json() as any;
    const entry=home.reply_markup.inline_keyboard.flat().find(
      (button:any)=>button.text.includes('Входящие'));
    assert.equal(entry.callback_data,'support:page:0');
    const inbox=await update({update_id:4311,callback_query:{
      id:'owner-inbox',from:{id:owner},
      message:{chat:{id:owner,type:'private'},message_id:101},
      data:entry.callback_data,
    }});
    assert.equal(inbox.status,200);
    const notice=await inbox.json() as any;
    assert.equal(notice.method,'editMessageText');
    assert.equal(notice.chat_id,owner);
    assert.match(notice.text,new RegExp('Заявка: '+ticketId));
    assert.match(notice.text,/После оплаты VPN/);
    const nextButton=notice.reply_markup.inline_keyboard.flat()
      .find((button:any)=>button.text.includes('Далее'));
    assert.equal(nextButton.callback_data,'support:page:1');
    const secondPage=await update({update_id:4330,callback_query:{
      id:'next-ticket',from:{id:owner},
      message:{chat:{id:owner,type:'private'},message_id:101},
      data:nextButton.callback_data,
    }});
    const secondCard=await secondPage.json() as any;
    assert.equal(secondCard.method,'editMessageText');
    assert.match(secondCard.text,new RegExp('Заявка: '+secondTicketId));
    assert.match(secondCard.text,/Вторая заявка/);
    const previous=secondCard.reply_markup.inline_keyboard.flat()
      .find((button:any)=>button.text.includes('Назад'));
    assert.equal(previous.callback_data,'support:page:0');

    // A signature for page 0 cannot be reused to read later pages.
    const reused=createHmac('sha256',bridgeSecret)
      .update('MNEBYVPN-inbox-v1\\n'+now).digest('hex');
    const notAuthorized=await fetch(base+'/api/support/operator-inbox?offset=1',{
      headers:{'X-MNEBYVPN-Support-Ts':now,
        'X-MNEBYVPN-Support-Signature':reused}});
    assert.equal(notAuthorized.status,403);
    const correct=createHmac('sha256',bridgeSecret)
      .update('MNEBYVPN-inbox-v2\\n'+now+'\\n1').digest('hex');
    const authorized=await fetch(base+'/api/support/operator-inbox?offset=1',{
      headers:{'X-MNEBYVPN-Support-Ts':now,
        'X-MNEBYVPN-Support-Signature':correct}});
    assert.equal(authorized.status,200);
    assert.equal((await authorized.json() as any).ticket.id,secondTicketId);

    const firstPage=await update({update_id:4331,callback_query:{
      id:'previous-ticket',from:{id:owner},
      message:{chat:{id:owner,type:'private'},message_id:101},
      data:previous.callback_data,
    }});
    assert.match((await firstPage.json() as any).text,new RegExp('Заявка: '+ticketId));
    const answerButton=notice.reply_markup.inline_keyboard.flat()
      .find((button:any)=>button.text.includes('Ответить'));
    assert.equal(answerButton.callback_data,'support:reply:site:'+ticketId);

    const replyPromptResponse=await update({update_id:4315,callback_query:{
      id:'reply-to-guest',from:{id:owner},
      message:{chat:{id:owner,type:'private'},message_id:101},
      data:answerButton.callback_data,
    }});
    const replyPrompt=await replyPromptResponse.json() as any;
    assert.equal(replyPrompt.method,'sendMessage');
    assert.equal(replyPrompt.chat_id,owner);
    assert.equal(replyPrompt.reply_markup.force_reply,true);
    assert.match(replyPrompt.text,new RegExp('Заявка: '+ticketId));

    const answer='Проверьте новый VPN-профиль, затем повторите подключение.';
    const reply=await update({update_id:4312,message:{
      from:{id:owner},chat:{id:owner,type:'private'},text:answer,
      reply_to_message:{from:{is_bot:true},text:replyPrompt.text},
    }});
    assert.equal(reply.status,200);
    const result=await reply.json() as any;
    assert.equal(result.chat_id,owner);
    assert.match(result.text,/Ответ сохранён/);

    const browser=await fetch(base+'/api/support/ticket',
      {headers:{Cookie:browserCookie}});
    const ticket=await browser.json() as any;
    assert.equal(ticket.answer,answer);
    assert.equal(ticket.status,'PENDING');
    assert.deepEqual(await (await fetch(base+'/api/support/ticket')).json(),
      {status:'NONE'});

    const invalidOperator=await update({update_id:4313,message:{
      from:{id:customer},chat:{id:customer,type:'private'},text:'Не мой ответ',
      reply_to_message:{from:{is_bot:true},text:notice.text},
    }});
    assert.equal(invalidOperator.status,200);
    const body=await invalidOperator.json() as any;
    assert.notEqual(body?.text,'✅ Ответ сохранён. Посетитель увидит его на сайте.');

    const repeat=await update({update_id:4314,message:{
      from:{id:owner},chat:{id:owner,type:'private'},text:answer,
      reply_to_message:{from:{is_bot:true},text:replyPrompt.text},
    }});
    assert.match((await repeat.json() as any).text,/уже ответили|закрыто/);
  }finally{
    web.kill('SIGTERM');
    bot?.kill('SIGTERM');
    for(const id of [ticketId,secondTicketId].filter(Boolean))
      await pool.query('DELETE FROM website_support_tickets WHERE id=$1',[id]).catch(()=>{});
    await pool.end();
  }
});
