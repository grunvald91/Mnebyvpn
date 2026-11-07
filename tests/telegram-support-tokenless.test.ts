import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';

test('main webhook bot relays private support requests and operator replies without a Bot API token',async()=>{
  const operator=11112222,user=33334444;
  const secret='webhook_secret_for_test_only';
  const digest=createHash('sha256').update(secret).digest('hex');
  const server=createServer();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr=server.address();
  if(!addr||typeof addr==='string')throw Error('No test port');
  const port=addr.port;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  let stderr='';
  const child=spawn(process.execPath,['--experimental-strip-types',
    'apps/service/src/telegram-cabinet-server.ts'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    stdio:['ignore','ignore','pipe'],
    env:{...process.env,MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'no',
      BOT_PORT:String(port),DATABASE_URL:'',TELEGRAM_TOKEN_BOT:'',
      SUPPORT_TELEGRAM_OPERATOR_ID:String(operator),
      TELEGRAM_WEBHOOK_SECRET_SHA256:digest},
  });
  child.stderr?.on('data',chunk=>stderr+=chunk.toString());
  const origin='http://127.0.0.1:'+port;
  const update=async(data:object)=>fetch(origin+'/webhooks/telegram',{
    method:'POST',headers:{'Content-Type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':secret},
    body:JSON.stringify(data),
  });
  try{
    let ready=false;
    for(let i=0;i<60;i++){
      try{if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(250)})).ok){
        ready=true;break;
      }}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,'Bot did not start: '+stderr);
    const prompted=await update({update_id:1900,callback_query:{
      id:'ask-support',from:{id:user},
      message:{chat:{id:user,type:'private'},message_id:11},
      data:'nav:support'}});
    const prompt=await prompted.json() as any;
    assert.equal(prompt.reply_markup.force_reply,true);
    const question='Не могу подключить VPN на Android';
    const request=await update({update_id:1901,message:{
      chat:{id:user,type:'private'},from:{id:user},text:question,
      reply_to_message:{from:{is_bot:true},text:prompt.text}}});
    const notice=await request.json() as any;
    assert.equal(notice.method,'sendMessage');
    assert.equal(notice.chat_id,operator);
    assert.match(notice.text,/ID Telegram: 33334444/);
    assert.match(notice.text,/Не могу подключить VPN/);
    assert.doesNotMatch(notice.text,/отправлено|доставлено/);
    const replyButton=notice.reply_markup.inline_keyboard.flat()
      .find((b:any)=>b.text.includes('Ответить'));
    assert.equal(replyButton.callback_data,'support:reply:bot:'+user);
    const askReply=await update({update_id:1906,callback_query:{
      id:'answer-support',from:{id:operator},
      message:{chat:{id:operator,type:'private'},message_id:12},
      data:replyButton.callback_data}});
    const replyPrompt=await askReply.json() as any;
    assert.equal(replyPrompt.method,'sendMessage');
    assert.equal(replyPrompt.reply_markup.force_reply,true);
    assert.match(replyPrompt.text,/ID Telegram: 33334444/);
    const answer='Проверьте импорт нового профиля в клиент.';
    const replied=await update({update_id:1902,message:{
      chat:{id:operator,type:'private'},from:{id:operator},text:answer,
      reply_to_message:{from:{is_bot:true},text:replyPrompt.text}}});
    const response=await replied.json() as any;
    assert.equal(response.method,'sendMessage');
    assert.equal(response.chat_id,user);
    assert.match(response.text,/Поддержка MNEBYVPN/);
    assert.match(response.text,/Проверьте импорт нового профиля/);
    assert.ok(response.reply_markup.inline_keyboard.flat().some(
      (b:any)=>b.callback_data==='nav:support'));
    const spoof=await update({update_id:1903,message:{
      chat:{id:user,type:'private'},from:{id:user},text:answer,
      reply_to_message:{from:{is_bot:true},text:notice.text}}});
    const invalid=await spoof.json() as any;
    assert.notEqual(invalid.chat_id,user+1);
    assert.notEqual(invalid.text,response.text);
    const menu=await update({update_id:1905,message:{
      chat:{id:operator,type:'private'},from:{id:operator},text:'/start'}});
    const ordinary=await menu.json() as any;
    assert.match(ordinary.text,/MNEBYVPN/);
    const inboxButton=ordinary.reply_markup.inline_keyboard.flat()
      .find((b:any)=>b.text.includes('Входящие'));
    assert.equal(inboxButton.callback_data,'support:page:0');
    const inbox=await update({update_id:1904,callback_query:{
      id:'open-inbox',from:{id:operator},
      message:{chat:{id:operator,type:'private'},message_id:13},
      data:inboxButton.callback_data}});
    const inboxView=await inbox.json() as any;
    assert.equal(inboxView.method,'editMessageText');
    assert.match(inboxView.text,/Внутренний канал обращений сайта ещё не настроен/);
    const stranger=await update({update_id:1907,callback_query:{
      id:'fake-inbox',from:{id:user},
      message:{chat:{id:user,type:'private'},message_id:14},
      data:'support:page:0'}});
    assert.doesNotMatch((await stranger.json() as any).text,/Заявка:/);
  }finally{
    child.kill('SIGTERM');
  }
});
