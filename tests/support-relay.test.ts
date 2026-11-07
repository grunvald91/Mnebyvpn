import assert from 'node:assert/strict';
import test from 'node:test';
import {
  operatorReplyTarget,operatorWebsiteReply,supportConfig,supportLimiter,telegramSupportSend,validSupportContact,validSupportText,
} from '../packages/support/src/telegram-relay.ts';

test('support has no separate chat ID and only enables one configured bot operator',()=>{
  const token='123456:'+('a'.repeat(35));
  assert.equal(supportConfig({}),null);
  assert.equal(supportConfig({SUPPORT_TELEGRAM_CHAT_ID:'-100456'}),null);
  assert.deepEqual(supportConfig({TELEGRAM_TOKEN_BOT:'bad',SUPPORT_TELEGRAM_OPERATOR_ID:'12345'}),
    {botToken:'',operatorId:12345});
  assert.equal(supportConfig({TELEGRAM_TOKEN_BOT:token}),null);
  assert.deepEqual(supportConfig({SUPPORT_TELEGRAM_OPERATOR_ID:'12345'}),
    {botToken:'',operatorId:12345});
  assert.equal(supportConfig({
    TELEGRAM_TOKEN_BOT:token,SUPPORT_TELEGRAM_OPERATOR_ID:'bad',
  }),null);
  assert.deepEqual(supportConfig({
    TELEGRAM_TOKEN_BOT:token,SUPPORT_TELEGRAM_OPERATOR_ID:'12345',
  }),{botToken:token,operatorId:12345});
});
test('validate support text and callback contact without accepting controls',()=>{
  assert.equal(validSupportText('не работает'),true);
  assert.equal(validSupportText('мало'),false);
  assert.equal(validSupportText('abc\u0000def'),false);
  assert.equal(validSupportText('x'.repeat(1501)),false);
  assert.equal(validSupportContact('@mnebyvpn_user'),true);
  assert.equal(validSupportContact('hello@example.com'),true);
  assert.equal(validSupportContact('not-a-contact'),false);
  assert.equal(validSupportContact('bad\ncontact'),false);
});
test('only a private reply by the configured operator to this bot notification can target a client',()=>{
  const operatorId=111111;
  const customerId=222222;
  const notice='✉️ MNEBYVPN — обращение из бота\nID Telegram: '+customerId+
    '\n\nВопрос:\nПомогите подключить VPN';
  const original={
    chat:{id:operatorId,type:'private'},
    from:{id:operatorId},
    reply_to_message:{from:{id:9999,is_bot:true},text:notice},
    text:'Переустановите профиль в приложении',
  };
  assert.deepEqual(operatorReplyTarget(original,operatorId),
    {userId:customerId,answer:'Переустановите профиль в приложении'});
  assert.equal(operatorReplyTarget({...original,from:{id:98765}},operatorId),null);
  assert.equal(operatorReplyTarget({...original,chat:{id:-222,type:'supergroup'}},operatorId),null);
  assert.equal(operatorReplyTarget({...original,reply_to_message:{
    from:{id:9999,is_bot:false},text:notice}},operatorId),null);
  assert.equal(operatorReplyTarget({...original,text:'x'.repeat(1501)},operatorId),null);
  assert.equal(operatorReplyTarget({...original,text:''},operatorId),null);
  assert.equal(operatorReplyTarget({...original,reply_to_message:{
    from:{id:9999,is_bot:true},text:'✉️ MNEBYVPN — обращение с сайта'}},operatorId),null);
  assert.equal(operatorReplyTarget({...original,reply_to_message:{
    from:{id:9999,is_bot:true},text:notice.replace(String(customerId),String(operatorId))}},operatorId),null);
});
test('website ticket replies require private operator identity and a valid bot ticket notice',()=>{
  const id=10001,ticketId='01234567-89ab-4abc-8def-0123456789ab';
  const notice='✉️ MNEBYVPN — обращение с сайта\nЗаявка: '+ticketId+
    '\nКонтакт: user@example.com\n\nСообщение: Помогите подключить';
  const msg={chat:{id,type:'private'},from:{id},reply_to_message:{
    from:{is_bot:true},text:notice},text:'Проверьте настройки приложения'};
  assert.deepEqual(operatorWebsiteReply(msg,id),
    {ticketId,answer:'Проверьте настройки приложения'});
  assert.equal(operatorWebsiteReply({...msg,from:{id:id+1}},id),null);
  assert.equal(operatorWebsiteReply({...msg,chat:{id:-1,type:'supergroup'}},id),null);
  assert.equal(operatorWebsiteReply({...msg,text:'x'.repeat(1501)},id),null);
  assert.equal(operatorWebsiteReply({...msg,reply_to_message:{
    from:{is_bot:false},text:notice}},id),null);
});
test('support limiter permits three messages per window, then reopens',()=>{
  const allowed=supportLimiter(3,10_000);
  assert.equal(allowed('a',1),true);
  assert.equal(allowed('a',2),true);
  assert.equal(allowed('a',3),true);
  assert.equal(allowed('a',4),false);
  assert.equal(allowed('b',4),true);
  assert.equal(allowed('a',10_001),true);
});
test('confirm Telegram Bot API ok before reporting delivery',async()=>{
  const config={botToken:'123456:'+('b'.repeat(35)),operatorId:123};
  const oldFetch=globalThis.fetch;
  let lastPayload:unknown=null;
  try{
    globalThis.fetch=async (_url,init)=>{
      lastPayload=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ok:true}),{status:200});
    };
    await telegramSupportSend(config,'Проверочное обращение');
    assert.deepEqual(lastPayload,{chat_id:123,text:'Проверочное обращение',
      link_preview_options:{is_disabled:true}});
    const keyboard={inline_keyboard:[
      [{text:'✍️ Ответить',callback_data:'support:reply:bot:999123'}],
      [{text:'📥 Входящие',callback_data:'support:page:0'}],
    ]};
    await telegramSupportSend(config,'Вопрос клиента',789,keyboard);
    assert.deepEqual(lastPayload,{chat_id:789,text:'Вопрос клиента',
      link_preview_options:{is_disabled:true},reply_markup:keyboard});
    globalThis.fetch=async()=>new Response(JSON.stringify({ok:false}),{status:200});
    await assert.rejects(telegramSupportSend(config,'Проверочное обращение'));
    globalThis.fetch=async()=>new Response('Unavailable',{status:503});
    await assert.rejects(telegramSupportSend(config,'Проверочное обращение'));
  }finally{globalThis.fetch=oldFetch;}
});
