import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
let child:ChildProcess;
let port=0,errors='';
const secret='test_fake_webhook_secret_not_public';
const digest=createHash('sha256').update(secret).digest('hex');
const host=()=>`http://127.0.0.1:${port}`;
before(async()=>{
 const net=createServer();
 await new Promise<void>(res=>net.listen(0,'127.0.0.1',res));
 const addr=net.address();
 if(!addr||typeof addr==='string')throw Error('No port');
 port=addr.port;
 await new Promise<void>(res=>net.close(()=>res()));
 child=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-cabinet-server.ts'],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore','ignore','pipe'],
  env:{...process.env,DATABASE_URL:'',MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'no',
   BOT_PORT:String(port),TELEGRAM_WEBHOOK_SECRET_SHA256:digest,
   SUPPORT_TELEGRAM_BOT_TOKEN:'',SUPPORT_TELEGRAM_CHAT_ID:'',
   SUPPORT_TELEGRAM_OPERATOR_ID:''},
 });
 child.stderr?.on('data',b=>errors+=b.toString());
 for(let i=0;i<60;i++){
  try{if((await fetch(host()+'/healthz',{signal:AbortSignal.timeout(250)})).ok)return;}catch{}
  await new Promise(res=>setTimeout(res,100));
 }
 throw Error('Server failed: '+errors);
});
after(()=>child?.kill('SIGTERM'));
const update=(body:unknown,token=secret)=>fetch(host()+'/webhooks/telegram',{
 method:'POST',headers:{'Content-Type':'application/json',
  'X-Telegram-Bot-Api-Secret-Token':token},body:JSON.stringify(body),
});
const user=3388994411;
test('unsigned requests cannot control any Telegram identity',async()=>{
 const resp=await fetch(host()+'/webhooks/telegram',{method:'POST',
 headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(resp.status,401);
 assert.equal((await update({update_id:1},'fake')).status,401);
});
test('/start shows primary Telegram VPN, trial, status and optional site',async()=>{
 const r=await update({update_id:2,message:{chat:{id:user,type:'private'},
 from:{id:user},text:'/start'}});
 assert.equal(r.status,200);
 const data=await r.json() as any;
 assert.equal(data.method,'sendMessage');
 assert.equal(data.chat_id,user);
 assert.match(data.text,/24 часа/);
 const buttons=data.reply_markup.inline_keyboard.flat();
 for(const val of ['nav:vpn','nav:trial','nav:status','nav:renew','nav:share'])
  assert.ok(buttons.some((b:any)=>b.callback_data===val));
 assert.ok(buttons.some((b:any)=>b.url==='https://mnebyvpn.site'));
});
test('support button and /support use ForceReply, without false delivery when relay is off',async()=>{
 const button=await update({update_id:200,callback_query:{id:'support-200',from:{id:user},
  message:{chat:{id:user,type:'private'},message_id:920},data:'nav:support'}});
 const prompted=await button.json() as any;
 assert.equal(prompted.method,'sendMessage');
 assert.equal(prompted.reply_markup.force_reply,true);
 assert.match(prompted.text,/MnebyVPN/);
 const command=await update({update_id:201,message:{chat:{id:user,type:'private'},
  from:{id:user},text:'/support'}});
 assert.equal((await command.json() as any).reply_markup.force_reply,true);
 const failed=await update({update_id:202,message:{chat:{id:user,type:'private'},
  from:{id:user},text:'/support Проблема с подключением к VPN'}});
 const response=await failed.json() as any;
 assert.match(response.text,/Канал поддержки ещё настраивается/);
 assert.doesNotMatch(response.text,/Обращение отправлено/);
 const reply=await update({update_id:203,message:{chat:{id:user,type:'private'},
  from:{id:user},text:'Помогите подключить VPN на телефон',
  reply_to_message:{from:{is_bot:true},text:'✉️ MnebyVPN — напишите вопрос в поддержку.'}}});
 assert.match((await reply.json() as any).text,/Канал поддержки ещё настраивается/);
});
test('VPN callback edits Telegram message instead of redirect to website',async()=>{
 const r=await update({update_id:3,callback_query:{id:'callback3',from:{id:user},
  message:{chat:{id:user,type:'private'},message_id:990},data:'nav:vpn'}});
 const result=await r.json() as any;
 assert.equal(result.method,'editMessageText');
 assert.equal(result.message_id,990);
 assert.ok(!result.reply_markup.inline_keyboard.some((row:any)=>row.some((b:any)=>b.url?.includes('mnebyvpn.site'))));
 assert.match(result.text,/Система подписок временно недоступна/);
});
test('failure to connect to DB does not pretend trial entitlement is active',async()=>{
 const resp=await update({update_id:4,callback_query:{id:'4',from:{id:user},
  message:{chat:{id:user,type:'private'},message_id:991},data:'trial:vpn'}});
 const result=await resp.json() as any;
 assert.equal(result.method,'editMessageText');
 assert.match(result.text,/Данные не изменены/);
});
test('private ownership and payments stay protected',async()=>{
 const spoof=await update({update_id:5,callback_query:{id:'5',from:{id:user},
 message:{chat:{id:user+1,type:'private'},message_id:123},data:'trial:vpn'}});
 assert.equal(await spoof.text(),'');
 const paid=await update({update_id:6,message:{chat:{id:user,type:'private'},
 from:{id:user},successful_payment:{currency:'XTR',total_amount:100}}});
 assert.equal(paid.status,503);
 const pc=await update({update_id:7,pre_checkout_query:{id:'checkout-test'}});
 assert.equal((await pc.json() as any).ok,false);
});
