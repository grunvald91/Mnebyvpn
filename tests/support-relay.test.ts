import assert from 'node:assert/strict';
import test from 'node:test';
import {
  supportConfig,supportLimiter,telegramSupportSend,validSupportContact,validSupportText,
} from '../packages/support/src/telegram-relay.ts';

test('support has no separate chat ID and only enables one configured bot operator',()=>{
  const token='123456:'+('a'.repeat(35));
  assert.equal(supportConfig({}),null);
  assert.equal(supportConfig({SUPPORT_TELEGRAM_CHAT_ID:'-100456'}),null);
  assert.throws(()=>supportConfig({TELEGRAM_TOKEN_BOT:'bad',SUPPORT_TELEGRAM_OPERATOR_ID:'12345'}));
  assert.throws(()=>supportConfig({TELEGRAM_TOKEN_BOT:token}));
  assert.throws(()=>supportConfig({SUPPORT_TELEGRAM_OPERATOR_ID:'12345'}));
  assert.throws(()=>supportConfig({
    TELEGRAM_TOKEN_BOT:token,SUPPORT_TELEGRAM_OPERATOR_ID:'bad',
  }));
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
    globalThis.fetch=async()=>new Response(JSON.stringify({ok:false}),{status:200});
    await assert.rejects(telegramSupportSend(config,'Проверочное обращение'));
    globalThis.fetch=async()=>new Response('Unavailable',{status:503});
    await assert.rejects(telegramSupportSend(config,'Проверочное обращение'));
  }finally{globalThis.fetch=oldFetch;}
});
