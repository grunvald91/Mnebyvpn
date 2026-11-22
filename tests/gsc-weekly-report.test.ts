import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  GSC_ALLOWED_PROPERTIES,GSC_ORIGIN,GSC_URL_PATHS,GSC_EXACT_PAGES_REGEX,minusDays,reportPeriods,
  combineDailyRows,pageMetrics,queryTopic,groupedQuerySamples,buildReport,identifySeoReviewItems,
  assertionForCredentials,getAccessToken,readSearchConsoleReport,
  formatTelegramReport,sendPrivateTelegramReport,validPrivateTelegramDestination,sendGscReportToExistingOwner,main,
} from '../scripts/gsc-weekly-report.ts';

const property='sc-domain:mnebyvpn.site';
const fakeQuery='ultra-private-example-search-token-should-not-be-printed';
const current={startDate:'2026-10-20',endDate:'2026-11-16'};
const previous={startDate:'2026-09-22',endDate:'2026-10-19'};
function fixture(){
  const inspections=Object.fromEntries(GSC_URL_PATHS.map(path=>[path,{
    inspectionResult:{indexStatusResult:{verdict:'PASS',coverageState:'Submitted and indexed'}}
  }]));
  return {
    property,current,previous,
    totalsCurrent:{rows:[{keys:['2026-11-12'],clicks:7,impressions:50,position:4},
                         {keys:['2026-11-13'],clicks:3,impressions:150,position:8}]},
    totalsPrevious:{rows:[{keys:['2026-10-15'],clicks:2,impressions:40,position:10}]},
    pagesCurrent:{rows:[{keys:[GSC_ORIGIN+'/gemini'],clicks:4,impressions:40,position:5}]},
    pagesPrevious:{rows:[{keys:[GSC_ORIGIN+'/gemini'],clicks:1,impressions:10,position:11}]},
    queryData:{rows:[{keys:['gemini '+fakeQuery],clicks:2,impressions:11},
                    {keys:['VPN 2026'],clicks:3,impressions:15},
                    {keys:[fakeQuery],clicks:1,impressions:5}]},
    inspections,
  };
}

test('28-day windows use Pacific Time and exclude the last three days',()=>{
  const p=reportPeriods(new Date('2026-11-19T12:00:00Z'));
  assert.equal(p.current.endDate,'2026-11-16');
  assert.equal(p.current.startDate,'2026-10-20');
  assert.equal(p.previous.endDate,'2026-10-19');
  assert.equal(p.previous.startDate,'2026-09-22');
  assert.equal(minusDays('2026-03-01',1),'2026-02-28');
  assert.equal(minusDays('2028-03-01',1),'2028-02-29');
  assert.throws(()=>minusDays('2026-02-30',3),/INVALID_DATE/);
});

test('metrics use weighted position and make missing page data explicit',()=>{
  const metrics=combineDailyRows(fixture().totalsCurrent.rows);
  assert.equal(metrics.clicks,10);
  assert.equal(metrics.impressions,200);
  assert.equal(metrics.ctr,.05);
  assert.equal(metrics.position,7);
  assert.equal(metrics.hasData,true);
  const absent=pageMetrics(fixture().pagesCurrent.rows,GSC_ORIGIN+'/chatgpt');
  assert.equal(absent.hasData,false);
  assert.equal(absent.position,null);
});

test('topic grouping handles AI names and never returns underlying query strings',()=>{
  assert.equal(queryTopic('Не работает Google Antigravity'),'Google Antigravity');
  assert.equal(queryTopic('Как открыть Gemini?'),'Gemini');
  assert.equal(queryTopic('claude code ошибка'),'Claude / Claude Code');
  assert.equal(queryTopic('chat gpt'),'ChatGPT');
  assert.equal(queryTopic('частный днс'),'Smart DNS');
  assert.equal(queryTopic('Телеграм прокси'),'Telegram');
  assert.equal(queryTopic('мой VPN'),'VPN');
  const groups=groupedQuerySamples(fixture().queryData.rows);
  assert.equal(groups.length,3);
  assert.ok(groups.some(x=>x.topic==='Gemini'));
  assert.ok(!JSON.stringify(groups).includes(fakeQuery));
});

test('report differentiates Google inspection verdicts from absence of impressions',()=>{
  const input=fixture();
  input.inspections['/chatgpt']=null as any;
  const report=buildReport(input);
  assert.ok(report.includes('| 10 | 200 |')===false); // formatted rows may have different spacing
  assert.ok(report.includes('Предыдущий период'));
  assert.ok(report.includes('Показы ранее'));
  assert.ok(report.includes('нет данных'));
  assert.ok(report.includes('**не делаем вывода об индексации**'));
  assert.ok(report.includes('Google Antigravity')||report.includes('/google-antigravity'));
  assert.ok(!report.includes(fakeQuery));
  const compact=formatTelegramReport(input);
  assert.ok(compact.includes('/gemini'));
  assert.ok(compact.includes('индекс: не проверено'));
  assert.ok(!compact.includes(fakeQuery));
  assert.ok(compact.length<=3800);
  assert.throws(()=>buildReport({...input,property:'sc-domain:another.example'}),/PROPERTY_NOT_ALLOWED/);
});

test('private report explains actual query-to-canonical-page evidence, never public metrics',()=>{
  const input={...fixture(),pageQueryCurrent:{rows:[
    {keys:[GSC_ORIGIN+'/gemini','как открыть gemini'],clicks:1,impressions:24,position:7.5},
    {keys:[GSC_ORIGIN+'/vpn','впн не запускается'],clicks:0,impressions:17,position:11.3},
    {keys:[GSC_ORIGIN+'/payment/success','секрет покупки'],clicks:0,impressions:999},
  ]}};
  const privateReport=formatTelegramReport(input);
  assert.match(privateReport,/«как открыть gemini» → \/gemini/);
  assert.match(privateReport,/24 показов, 1 кликов/);
  assert.match(privateReport,/«впн не запускается» → \/vpn/);
  assert.ok(!privateReport.includes('секрет покупки'));
  assert.ok(privateReport.length<=3800);
  const local=buildReport(input);
  assert.match(local,/## Реальные запросы → канонические страницы/);
  assert.match(local,/как открыть gemini/);
  assert.ok(!local.includes('секрет покупки'));
});

test('new SEO pages report preliminary last three Pacific dates separately from finalized data',()=>{
  const input={...fixture(),fresh:{
    startDate:'2026-11-17',endDate:'2026-11-19',
    totals:{rows:[{keys:['2026-11-19'],clicks:1,impressions:12,position:7}]},
    pages:{rows:[{keys:[GSC_ORIGIN+'/gemini'],clicks:1,impressions:12}]},
    queries:{rows:[{keys:['gemini '+fakeQuery],clicks:1,impressions:12}]},
  }};
  const report=buildReport(input);
  assert.ok(report.includes('Новые данные: предварительная статистика'));
  assert.ok(report.includes('2026-11-17 — 2026-11-19'));
  assert.ok(report.includes('Google может пересчитать'));
  assert.ok(!report.includes(fakeQuery));
  const tg=formatTelegramReport(input);
  assert.ok(tg.includes('Новейшие 3 дня (предварительно'));
  assert.ok(tg.includes('Показы: 12'));
  assert.ok(!tg.includes(fakeQuery));
  const without={...input,fresh:{...input.fresh,totals:{rows:[]},queries:{rows:[]}}};
  assert.ok(formatTelegramReport(without).includes('данные отсутствуют'));
});
test('SEO review flags explain the observed data and never invent ranking causes',()=>{
  const input=fixture();
  input.pagesCurrent.rows[0].clicks=0;
  input.pagesCurrent.rows[0].impressions=160;
  input.pagesPrevious.rows[0].impressions=400;
  input.inspections['/gemini'].inspectionResult.indexStatusResult.verdict='FAIL';
  const notes=identifySeoReviewItems(input);
  assert.ok(notes.some(s=>s.includes('/gemini')&&s.includes('Google URL Inspection')));
  assert.ok(notes.some(s=>s.includes('/gemini')&&s.includes('более чем на 50%')&&s.includes('400 → 160')));
  assert.ok(notes.some(s=>s.includes('/gemini')&&s.includes('CTR ниже 1%')));
  const compact=formatTelegramReport(input);
  assert.ok(compact.includes('Проверить:'));
  assert.ok(compact.includes('400 → 160'));
  assert.ok(!compact.includes(fakeQuery));
  const full=buildReport(input);
  assert.ok(full.includes('Правила: снижение показов'));
  assert.ok(full.includes('CTR ниже 1%'));
  assert.ok(!/гарантирует (?:рост|позиции)/i.test(full));
});

test('JWT assertion signs with the read-only scope and no credential in payload',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const credentials=JSON.stringify({
    type:'service_account',client_email:'bot@seo-report.iam.gserviceaccount.com',
    private_key:privateKey.export({format:'pem',type:'pkcs8'}).toString(),
    token_uri:'https://oauth2.googleapis.com/token',
  });
  const assertion=assertionForCredentials(credentials,1700000000);
  const [header,claims,signature]=assertion.split('.');
  assert.equal(JSON.parse(Buffer.from(header,'base64url').toString()).alg,'RS256');
  const data=JSON.parse(Buffer.from(claims,'base64url').toString());
  assert.equal(data.scope,'https://www.googleapis.com/auth/webmasters.readonly');
  assert.equal(data.exp-data.iat,3600);
  assert.ok(!JSON.stringify(data).includes('BEGIN PRIVATE KEY'));
  assert.ok(verify('RSA-SHA256',Buffer.from(header+'.'+claims),publicKey,Buffer.from(signature,'base64url')));
  assert.throws(()=>assertionForCredentials(credentials.replace('service_account','user')),/INVALID_GSC_CREDENTIAL_FORMAT/);
});

test('Search Console API reads one approved property and eight static URLs only',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const creds=JSON.stringify({type:'service_account',
    client_email:'bot@test.iam.gserviceaccount.com',
    private_key:privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    token_uri:'https://oauth2.googleapis.com/token'});
  const calls:{url:string;body?:any}[]=[];
  const mocked=async(url:string|URL,init?:RequestInit):Promise<Response>=>{
    const target=String(url);
    const body=init?.body&&typeof init.body==='string'&&init.headers &&
      String((init.headers as Record<string,string>)['Content-Type']).includes('json')?
      JSON.parse(init.body):undefined;
    calls.push({url:target,body});
    const ok=(data:any)=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
    if(target==='https://oauth2.googleapis.com/token')return ok({access_token:'test-token'});
    if(target.includes('/sites/')&&!target.includes('searchAnalytics'))return ok({siteUrl:property,permissionLevel:'siteFullUser'});
    if(target.includes('searchAnalytics')){
      if(body.dimensions[0]==='query'||body.dimensions[0]==='page'){
        // Not a loose domain-wide contains filter: only approved canonical URLs.
        assert.deepEqual(body.dimensionFilterGroups,[{
          filters:[{dimension:'page',operator:'includingRegex',expression:GSC_EXACT_PAGES_REGEX}]
        }]);
        if(body.dimensions.length===2){
          assert.deepEqual(body.dimensions,['page','query']);
          assert.equal(body.rowLimit,2000);
          return ok({rows:[{keys:[GSC_ORIGIN+'/gemini','как использовать gemini'],
            clicks:1,impressions:13,position:6.2}]});
        }
        assert.ok(body.dimensions[0]==='page'?body.rowLimit===100:
          body.rowLimit===1000||body.rowLimit===300);
        if(body.dimensions[0]==='query')return ok({rows:[{keys:['gemini'],clicks:1,impressions:2}]});
        return ok({rows:[]});
      }
      return ok({rows:[]});
    }
    if(target.includes('urlInspection')){
      assert.ok(GSC_URL_PATHS.some(p=>body.inspectionUrl===GSC_ORIGIN+p));
      return ok({inspectionResult:{indexStatusResult:{verdict:'PASS'}}});
    }
    throw Error('UNEXPECTED_TEST_URL');
  };
  const report=await readSearchConsoleReport(property,creds,mocked,new Date('2026-11-19T12:00:00Z'));
  assert.equal(calls.length,19); // OAuth, permission, nine analytics queries, eight inspections.
  assert.equal(report.current.endDate,'2026-11-16');
  assert.equal(report.inspections['/gemini']?.inspectionResult?.indexStatusResult?.verdict,'PASS');
  assert.equal(calls.filter(x=>x.url.includes('searchAnalytics')).length,9);
  assert.equal(report.pageQueryCurrent?.rows?.length,1);
  assert.equal(report.pageQueryCurrent?.rows?.[0]?.keys?.[0],GSC_ORIGIN+'/gemini');
  assert.equal(calls.filter(x=>x.body?.dataState==='all').length,3);
  assert.equal(report.fresh?.startDate,'2026-11-17');
  assert.equal(report.fresh?.endDate,'2026-11-19');
  assert.ok(calls.every(x=>!x.url.includes('another.example')));
  await assert.rejects(readSearchConsoleReport('sc-domain:another.example',creds,mocked),/PROPERTY_NOT_ALLOWED/);
});

test('Telegram delivery accepts existing bot IDs but rejects groups and channels',async()=>{
  const legacy='123456:abcdefghijklmnopqrstuvwxyzABCDEFGH';
  const current='123456789012345:abcdefghijklmnopqrstuvwxyzABCDEFGH';
  assert.equal(validPrivateTelegramDestination(legacy,'123456789'),true);
  assert.equal(validPrivateTelegramDestination(current,'123456789'),true);
  assert.equal(validPrivateTelegramDestination(legacy,'-1001234567890'),false);
  assert.equal(validPrivateTelegramDestination(legacy,'0'),false);
  assert.equal(validPrivateTelegramDestination(legacy,'9007199254740992'),false);
  let called=false;
  await assert.rejects(sendPrivateTelegramReport('test',legacy,'-1001234567890',async()=>{
    called=true;
    return new Response(JSON.stringify({ok:true}),{status:200});
  }),/GSC_TELEGRAM_CONFIG_INVALID/);
  assert.equal(called,false,'Never send private analytics to a group');
});

test('GitHub report fails before Google network access without an existing bot token',async()=>{
  const keys=['GITHUB_ACTIONS','GSC_SERVICE_ACCOUNT_JSON','GSC_TELEGRAM_BOT_TOKEN',
    'GSC_TELEGRAM_CHAT_ID','GSC_SITE_URL'] as const;
  const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    process.env.GITHUB_ACTIONS='true';
    process.env.GSC_SERVICE_ACCOUNT_JSON='not-json';
    process.env.GSC_TELEGRAM_BOT_TOKEN='';
    process.env.GSC_TELEGRAM_CHAT_ID='-1001234567890';
    await assert.rejects(main(),/GSC_PRIVATE_DELIVERY_NOT_CONFIGURED/);
  }finally{
    for(const key of keys){
      if(original[key]===undefined)delete process.env[key];
      else process.env[key]=original[key];
    }
  }
});

test('GSC report uses signed existing owner relay instead of copying the Telegram user ID',async()=>{
  const existingToken='123456:abcdefghijklmnopqrstuvwxyzABCDEFGH';
  const summary=formatTelegramReport(fixture());
  let called=0;
  const clock=1800000000000;
  const mock=async(url:string|URL,init?:RequestInit)=>{
    called++;
    assert.equal(String(url),'https://mnebyvpn.site/api/internal/gsc-report');
    assert.equal(init?.method,'POST');
    assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body));
    assert.equal(body.text,summary);
    assert.ok(!JSON.stringify(init).includes(existingToken),'Never send the bot token');
    assert.ok(!JSON.stringify(init).includes('123456789'),'Never send operator ID');
    const headers=init?.headers as Record<string,string>;
    assert.match(headers['X-Mnebyvpn-Gsc-Ts'],/^[0-9]{10}$/);
    assert.match(headers['X-Mnebyvpn-Gsc-Signature'],/^[a-f0-9]{64}$/);
    return new Response(JSON.stringify({delivered:true}),{status:200});
  };
  await sendGscReportToExistingOwner(summary,existingToken,mock,clock);
  assert.equal(called,1);
  const notDelivered=async()=>new Response(JSON.stringify({delivered:false}),{status:200});
  await assert.rejects(sendGscReportToExistingOwner(summary,existingToken,notDelivered,clock),
    /GSC_OWNER_RELAY_DELIVERY_UNCONFIRMED/);
});

test('Telegram transport sends privately and never echoes credentials on error',async()=>{
  let stored:any;
  const token='123456:abcdefghijklmnopqrstuvwxyzABCDEFGH';
  const mock=async(_url:string|URL,init?:RequestInit)=>{
    assert.equal(init?.redirect,'error','Must not follow Bot API redirects containing a token');
    stored=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ok:true}),{status:200});
  };
  await sendPrivateTelegramReport('Внутренний SEO-отчёт',token,'123456789',mock);
  assert.equal(stored.chat_id,'123456789');
  assert.equal(stored.text,'Внутренний SEO-отчёт');
  assert.equal(stored.disable_web_page_preview,true);
  await assert.rejects(sendPrivateTelegramReport('x','malformed','123456789',mock),/GSC_TELEGRAM_CONFIG_INVALID/);
  const failing=async()=>new Response(JSON.stringify({ok:false,description:'secret'}),{status:403});
  await assert.rejects(sendPrivateTelegramReport('x',token,'123456789',failing),error=>{
    assert.equal((error as Error).message,'GSC_TELEGRAM_HTTP_403');
    assert.ok(!(error as Error).message.includes(token));
    return true;
  });
  assert.deepEqual(GSC_ALLOWED_PROPERTIES,['sc-domain:mnebyvpn.site','https://mnebyvpn.site/']);
});

test('Google Search Analytics RE2 page filter matches the eight canonical URLs only',()=>{
  const regexp=new RegExp(GSC_EXACT_PAGES_REGEX);
  assert.ok(GSC_EXACT_PAGES_REGEX.startsWith('^https://'));
  assert.equal(GSC_EXACT_PAGES_REGEX.charCodeAt(GSC_EXACT_PAGES_REGEX.length-1),36);
  for(const path of GSC_URL_PATHS)assert.ok(regexp.test(GSC_ORIGIN+path),path);
  for(const value of [
    GSC_ORIGIN+'/privacy',
    GSC_ORIGIN+'/vpn/',
    GSC_ORIGIN+'/vpn/other',
    GSC_ORIGIN+'/payment/success',
    GSC_ORIGIN+'/gemini?token=abc',
    'https://mnebyvpnXsite/vpn',
    'http://mnebyvpn.site/vpn',
    'https://sub.mnebyvpn.site/chatgpt',
  ])assert.equal(regexp.test(value),false,value);
});

test('weekly GitHub report auto-attempts with existing secrets and never prints private values',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/gsc-weekly-private-report.yml',import.meta.url),'utf8');
  assert.match(workflow,/cron: '37 5 \* \* 1'/);
  assert.match(workflow,/push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow,/GSC_JSON_PRESENT: \$\{\{ secrets\.GSC_SERVICE_ACCOUNT_JSON != '' \}\}/);
  assert.match(workflow,/BOT_TOKEN_PRESENT: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN != '' \|\| secrets\.TELEGRAM_TOKEN_BOT != '' \}\}/);
  assert.ok(!workflow.includes('OPERATOR_ID_PRESENT'));
  assert.ok(!workflow.includes('SUPPORT_TELEGRAM_OPERATOR_ID'));
  assert.match(workflow,/if: steps\.preflight\.outputs\.ready == 'yes'/);
  assert.match(workflow,/GSC_TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \|\| secrets\.TELEGRAM_TOKEN_BOT \}\}/);
  assert.ok(!workflow.includes('GSC_TELEGRAM_CHAT_ID:'));
  assert.ok(!workflow.includes('GSC_REPORT_ENABLED'));
  assert.ok(!workflow.includes('GSC_TELEGRAM_BOT_TOKEN: ${{ secrets.GSC_TELEGRAM_BOT_TOKEN }}'));
  assert.ok(!/echo[^\n]*(GSC_SERVICE_ACCOUNT_JSON|TELEGRAM_BOT_TOKEN|SUPPORT_TELEGRAM_OPERATOR_ID).*\$\{\{/m.test(workflow));
});
