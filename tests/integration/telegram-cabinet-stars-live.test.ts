import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseStarsPayload} from '../../packages/billing/src/stars.ts';
import {planWidgetKey} from '../../packages/telegram-ui/src/widget-104.ts';

test('production cabinet: Stars invoice, checked payment, durable settlement and Prodamus website option',async()=>{
  const url='postgresql://'+(process.env.PGUSER||'test')+':'+
    (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
    (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
  const pool=new Pool({connectionString:url});
  const planId='vpn_'+randomUUID().replaceAll('-','').slice(0,16);
  const user=4198221122;
  const webhook='cabinet_test_secret_for_stars';
  const digest=createHash('sha256').update(webhook).digest('hex');
  const starsSecret='MNEBYVPN_test_stars_payload_secret_1234567890123';
  const listen=createServer();
  await new Promise<void>(r=>listen.listen(0,'127.0.0.1',r));
  const address=listen.address();
  if(!address||typeof address==='string')throw Error('No available port');
  const port=address.port;
  await new Promise<void>(r=>listen.close(()=>r()));
  const child=spawn(process.execPath,['--experimental-strip-types','apps/service/src/telegram-cabinet-server.ts'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:['ignore','ignore','pipe'],
    env:{...process.env,MNEBYVPN_ENV:'production',BOT_PUBLIC_INFO_ONLY:'no',
      DATABASE_URL:url,BOT_PORT:String(port),TELEGRAM_WEBHOOK_SECRET_SHA256:digest,
      STARS_PAYLOAD_SECRET:starsSecret,TELEGRAM_TOKEN_BOT:''},
  });
  let stderr='';
  child.stderr?.on('data',(b:Buffer)=>stderr+=b.toString());
  const post=async(body:unknown)=>{
    const resp=await fetch('http://127.0.0.1:'+port+'/webhooks/telegram',{
      method:'POST',headers:{'Content-Type':'application/json',
        'X-Telegram-Bot-Api-Secret-Token':webhook},
      body:JSON.stringify(body),
    });
    return {resp,data:await resp.text()};
  };
  const button=(update_id:number,data:string)=>({
    update_id,callback_query:{id:'cb-'+update_id,from:{id:user},
      message:{chat:{id:user,type:'private'},message_id:42},data},
  });
  try{
    await pool.query(
      `INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,stars,enabled)
       VALUES($1,'vpn','VPN Stars testing',2592000,9900,17,true)`,[planId]);
    for(let i=0;i<60;i++){
      try{
        if((await fetch('http://127.0.0.1:'+port+'/readyz',{
          signal:AbortSignal.timeout(300)})).status===200)break;
      }catch{}
      if(i===59)throw Error('Bot not ready: '+stderr);
      await new Promise(r=>setTimeout(r,100));
    }
    // This is the ACTUAL production cabinet path behind the screenshot's
    // "🌐 VPN и тарифы" button, not the parallel legacy bot-navigation path.
    const home=await post({update_id:80999,message:{chat:{id:user,type:'private'},
      from:{id:user},text:'/start'}});
    assert.equal(JSON.parse(home.data).reply_markup.inline_keyboard[0][0].callback_data,'nav:vpn');
    const menu=await post(button(81001,'nav:vpn'));
    assert.equal(menu.resp.status,200);
    const shown=JSON.parse(menu.data);
    assert.equal(shown.method,'sendWidget');
    assert.equal(shown.chat_id,user);
    assert.equal(shown.allow_queries,true);
    assert.match(shown.html,/TelegramWidget/);
    assert.match(shown.html,/data:image\\/webp;base64/);
    const state=JSON.parse(shown.chat_data);
    assert.ok(state.p.some((p:(string|number)[])=>p[1]===17&&p[4]===
      planWidgetKey({planId,product:'vpn',title:'VPN Stars testing',stars:17,
        rubMinor:9900,durationSeconds:2592000,dnsQuotaBytes:null})));
    const buttons=shown.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some((b:any)=>b.callback_data==='buy:stars:'+planId));
    assert.ok(buttons.some((b:any)=>b.callback_data==='nav:vpn:list'));
    const fromWidget=await post({update_id:81009,widget_query:{
      id:'wq-81009',from:{id:user},chat:{id:user,type:'private'},message_id:543,
      type:{type:'data'},data:'buy:'+state.p.find((p:(string|number)[])=>p[1]===17)[4],
    }});
    const fallback=JSON.parse(fromWidget.data);
    assert.equal(fallback.method,'answerWidgetQuery');
    assert.equal(fallback.data,'USE_BUTTONS'); // tokenless backend, real invoice below the bubble
    const crossChat=await post({update_id:81010,widget_query:{
      id:'wq-81010',from:{id:user+1},chat:{id:user,type:'private'},message_id:543,
      type:{type:'data'},data:'buy:'+state.p.find((p:(string|number)[])=>p[1]===17)[4],
    }});
    assert.equal(JSON.parse(crossChat.data).data,'NOT_ALLOWED');
    const oldList=await post(button(81011,'nav:vpn:list'));
    assert.equal(JSON.parse(oldList.data).method,'editMessageText');
    assert.ok(JSON.parse(oldList.data).reply_markup.inline_keyboard.flat()
      .some((b:any)=>b.url==='https://mnebyvpn.site/?product=vpn&days=30'));

    const first=await post(button(81002,'buy:stars:'+planId));
    assert.equal(first.resp.status,200);
    const invoice=JSON.parse(first.data);
    assert.equal(invoice.method,'sendInvoice');
    assert.equal(invoice.currency,'XTR');
    assert.deepEqual(invoice.prices,[{label:'VPN Stars testing',amount:17}]);
    const orderId=parseStarsPayload(invoice.payload,starsSecret);
    assert.ok(orderId);

    const repeat=await post(button(81002,'buy:stars:'+planId));
    assert.equal(repeat.resp.status,200);
    const duplicateResponse=JSON.parse(repeat.data);
    assert.equal(duplicateResponse.method,'sendMessage');
    assert.match(duplicateResponse.text,/уже запрашивался/);
    const dispatch=await pool.query(
      'SELECT state FROM telegram_invoice_dispatch WHERE order_id=$1',[orderId]);
    assert.equal(dispatch.rowCount,1);
    assert.equal(dispatch.rows[0].state,'UNKNOWN');

    const incorrect=await post({update_id:81003,pre_checkout_query:{
      id:'pre-bad',from:{id:user},currency:'XTR',total_amount:99,
      invoice_payload:invoice.payload}});
    assert.equal(JSON.parse(incorrect.data).ok,false);
    const valid=await post({update_id:81004,pre_checkout_query:{
      id:'pre-ok',from:{id:user},currency:'XTR',total_amount:17,
      invoice_payload:invoice.payload}});
    assert.equal(valid.resp.status,200);
    assert.equal(JSON.parse(valid.data).ok,true);
    const paid={update_id:81005,message:{chat:{id:user,type:'private'},
      from:{id:user},successful_payment:{currency:'XTR',total_amount:17,
        invoice_payload:invoice.payload,telegram_payment_charge_id:'live-test-charge-'+orderId}}};
    const captured=await post(paid);
    assert.equal(captured.resp.status,200);
    assert.match(JSON.parse(captured.data).text,/Оплата Stars подтверждена/);
    const row=await pool.query('SELECT state FROM orders WHERE id=$1',[orderId]);
    assert.equal(row.rows[0].state,'PAID');
    const count=await pool.query(
      'SELECT count(*)::int AS n FROM entitlements WHERE source_order_id=$1',[orderId]);
    assert.equal(count.rows[0].n,1);
    const duplicate=await post({...paid,update_id:81006});
    assert.equal(duplicate.resp.status,200);
    assert.equal(duplicate.data,'');
    const after=await pool.query(
      'SELECT count(*)::int AS n FROM entitlements WHERE source_order_id=$1',[orderId]);
    assert.equal(after.rows[0].n,1);
    const refund={update_id:81007,message:{chat:{id:user,type:'private'},
      refunded_payment:{currency:'XTR',total_amount:17,invoice_payload:invoice.payload,
        telegram_payment_charge_id:'live-test-charge-'+orderId}}};
    const foreign=await post({...refund,message:{...refund.message,chat:{id:user+1,type:'private'}}});
    assert.equal(foreign.resp.status,503);
    assert.equal((await pool.query('SELECT state FROM orders WHERE id=$1',[orderId])).rows[0].state,'PAID');
    const refunded=await post(refund);
    assert.equal(refunded.resp.status,200);
    assert.equal(JSON.parse(refunded.data).chat_id,user);
    assert.equal((await pool.query('SELECT state FROM orders WHERE id=$1',[orderId])).rows[0].state,'REFUNDED');
    assert.equal((await pool.query('SELECT state FROM entitlements WHERE source_order_id=$1',[orderId])).rows[0].state,'REFUNDED');
    assert.equal((await post({...refund,update_id:81008})).data,'');

  }finally{
    child.kill('SIGTERM');
    // The shared disposable CI database is reused by later integration files.
    // An extra published plan would consume a catalog LIMIT slot and break
    // unrelated pricing tests. Retain its immutable order terms but unpublish.
    await pool.query('UPDATE billing_plans SET enabled=false WHERE id=$1',[planId])
      .catch(()=>{});
    await pool.end();
  }
});
