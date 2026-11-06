import test from 'node:test';
import assert from 'node:assert/strict';
import {formatVpnExpiryReminder,TelegramBotReminderSender,
  type VpnExpiryReminder} from '../packages/notifications/src/vpn-expiry.ts';

const job:VpnExpiryReminder={
  entitlementId:'aaabbbcc-1111-4111-8111-aaaaaaaaaaaa',
  telegramUserId:'123123123',daysBefore:3,
  expiresAt:new Date('2026-11-10T12:15:00.000Z'),
  expiresAtExact:'2026-11-10 12:15:00+00',attempt:1,
};
test('both reminders show MNEBYVPN and actual Moscow deadline, with renewal CTA',async()=>{
  assert.match(formatVpnExpiryReminder(job),/около 3 дней/);
  assert.match(formatVpnExpiryReminder(job),/15:15/);
  assert.match(formatVpnExpiryReminder({...job,daysBefore:1}),/около 1 дня/);
  let sendCount=0;
  const fake=async(url:unknown,options?:RequestInit)=>{
    sendCount++;
    assert.equal(url,'https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyzABCDE/sendMessage');
    assert.equal(options?.redirect,'error');
    const data=JSON.parse(options?.body as string);
    assert.equal(data.chat_id,job.telegramUserId);
    assert.match(data.text,/MNEBYVPN/);
    assert.equal(data.reply_markup.inline_keyboard[0][0].callback_data,'nav:renew');
    return {ok:true,status:200,json:async()=>({ok:true})} as Response;
  };
  const sender=new TelegramBotReminderSender(
    '123456:abcdefghijklmnopqrstuvwxyzABCDE',fake as typeof fetch);
  assert.deepEqual(await sender.send(job),{status:'sent'});
  assert.equal(sendCount,1);
});
test('Telegram 429 schedules backoff, blocked private chats never retry forever',async()=>{
  const fake429=async()=>({ok:false,status:429,
    json:async()=>({ok:false,parameters:{retry_after:37}})}) as Response;
  const sender=new TelegramBotReminderSender(
    '123456:abcdefghijklmnopqrstuvwxyzABCDE',fake429 as typeof fetch);
  assert.deepEqual(await sender.send(job),{status:'retry',retryAfterSeconds:37});
  const blocked=new TelegramBotReminderSender(
    '123456:abcdefghijklmnopqrstuvwxyzABCDE',
    (async()=>({ok:false,status:403}) as Response) as typeof fetch);
  assert.deepEqual(await blocked.send(job),{status:'blocked'});
  assert.throws(()=>new TelegramBotReminderSender('fake-token'));
});
