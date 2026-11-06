import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
const webhookSecret='unit_test_telegram_webhook_secure_2026';
const digest=createHash('sha256').update(webhookSecret).digest('hex');
let server:ChildProcess;
let port=0,stderr='';
const base=()=> 'http://127.0.0.1:'+port;
before(async()=>{
  const portProbe=createServer();
  await new Promise<void>(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
  const sock=portProbe.address();
  if(!sock||typeof sock==='string')throw new Error('No port');
  port=sock.port;
  await new Promise<void>(resolve=>portProbe.close(()=>resolve()));
  server=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-brochure-server.ts'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'yes',
      BOT_PORT:String(port),TELEGRAM_WEBHOOK_SECRET_SHA256:digest},
  });
  server.stderr?.on('data',(b:Buffer)=>{stderr+=b.toString().slice(0,1000);});
  for(let i=0;i<50;i++){
    try { if((await fetch(base()+'/healthz',{signal:AbortSignal.timeout(250)})).ok)return; }catch{}
    if(server.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Telegram server did not start: '+stderr);
});
after(()=>{server?.kill('SIGTERM');});
async function post(body:unknown,secret=webhookSecret){
  return fetch(base()+'/webhooks/telegram',{
    method:'POST',headers:{
      'Content-Type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':secret,
    },
    body:JSON.stringify(body),
  });
}
test('webhook rejects a missing or forged Telegram secret',async()=>{
  const noSecret=await fetch(base()+'/webhooks/telegram',{
    method:'POST',headers:{'Content-Type':'application/json'},body:'{}',
  });
  assert.equal(noSecret.status,401);
  assert.equal((await post({update_id:1},'spoofed')).status,401);
  assert.equal((await post({update_id:1})).status,200);
});
test('Telegram /start is answered with one webhook sendMessage API method, no Bot token',async()=>{
  const result=await post({
    update_id:2,message:{chat:{id:1234567,type:'private'},
      from:{id:1234567},text:'/start'},
  });
  assert.equal(result.status,200);
  const answer=await result.json() as any;
  assert.equal(answer.method,'sendMessage');
  assert.equal(answer.chat_id,1234567);
  assert.match(answer.text,/ещё не запущены/);
  assert.equal(answer.reply_markup.inline_keyboard[0][0].url,'https://mnebyvpn.site');
  assert.equal(answer.token,undefined);
});
test('Telegram callback and checkout are answered without granting access',async()=>{
  const callback=await post({update_id:3,callback_query:{
    id:'callback-test',from:{id:123},data:'info:vpn',
    message:{chat:{id:123,type:'private'}},
  }});
  const cb=await callback.json() as any;
  assert.equal(cb.method,'answerCallbackQuery');
  assert.match(cb.text,/ещё не запущен/);
  const precheckout=await post({update_id:4,pre_checkout_query:{id:'checkout-test'}});
  const answer=await precheckout.json() as any;
  assert.equal(answer.method,'answerPreCheckoutQuery');
  assert.equal(answer.ok,false);
});
test('real payment or refund updates never get acknowledged without durable billing',async()=>{
  const charged=await post({update_id:5,message:{
    chat:{type:'private',id:123},from:{id:123},
    successful_payment:{total_amount:99,currency:'XTR'},
  }});
  assert.equal(charged.status,503);
  assert.equal((await fetch(base()+'/readyz')).status,503);
});
test('nonprivate messages and malformed bodies do not get personal responses',async()=>{
  const channel=await post({update_id:6,message:{
    chat:{type:'supergroup',id:-100},from:{id:123},text:'/start',
  }});
  assert.equal(channel.status,200);
  assert.equal(await channel.text(),'');
  assert.equal((await post({not_an_update:1})).status,503);
});
