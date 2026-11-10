import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext} from 'node:vm';
import {deflateSync} from 'node:zlib';
import {homeWidgetPayload,homeWidgetHtml} from '../packages/telegram-ui/src/home-widget.ts';
test('primary menu reuses original avatar and fits Telegram 10.4 profile',()=>{
 const html=homeWidgetHtml();
 assert.ok(Buffer.byteLength(html,'utf8')<=32768);
 assert.ok(deflateSync(Buffer.from(html),{level:9}).length<=3800);
 assert.match(html,/data:image\/webp;base64,/);
 for(const item of ['vpn','trial','status','connect','renew','share','dns','help','support','site','dnsadmin'])
  assert.ok(html.includes('data-a="'+item+'"'),item);
 assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|<iframe|<input/);
 assert.doesNotThrow(()=>new Script(html.split('<script>')[1].split('</script>')[0]));
 const p=homeWidgetPayload(401,true,true);
 assert.equal(p.allow_queries,true);
 assert.equal(JSON.parse(p.chat_data).a,1);
 assert.equal(JSON.parse(p.chat_data).o,1);
 assert.deepEqual(p.reply_markup.inline_keyboard,
   [[{text:'☰ Открыть обычное меню',callback_data:'nav:menu:legacy'}]]);
 assert.match(p.caption,/новая функция недоступна/);
 assert.throws(()=>homeWidgetPayload(0,false,false),/Invalid chat/);
});
test('menu tiles request the original bot sections; external site uses Telegram link host',async()=>{
 const html=homeWidgetHtml(),script=html.split('<script>')[1].split('</script>')[0];
 const ids=['vpn','trial','status','connect','renew','share','dns','help','support','site','dnsadmin'];
 const elements=ids.map(key=>({disabled:false,key,onclick:null as null|(()=>void),
   getAttribute(k:string){return k==='data-a'?this.key:null}}));
 const byId:Record<string,any>={notice:{textContent:''},
   support:{textContent:'Поддержка'},admin:{hidden:true}};
 const requests:string[]=[],links:string[]=[];
 const widget={chatData:'{"v":1,"a":1,"o":1}',ready:()=>{},
   request:(k:string)=>{requests.push(k);return Promise.resolve({result:'OPENED'})},
   openLink:(s:string)=>{links.push(s)}};
 new Script(script).runInContext(createContext({TelegramWidget:widget,document:{
   getElementById:(key:string)=>byId[key],querySelectorAll:()=>elements,
 }}));
 assert.equal(byId.admin.hidden,false);
 assert.equal(byId.support.textContent,'📥 Входящие заявки');
 elements[0].onclick?.();
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(requests,['menu:vpn']);
 elements[9].onclick?.();
 assert.deepEqual(links,['https://mnebyvpn.site']);
});
