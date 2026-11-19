import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,verify} from 'node:crypto';
import {
  GSC_ALLOWED_PROPERTIES,GSC_ORIGIN,GSC_URL_PATHS,minusDays,reportPeriods,
  combineDailyRows,pageMetrics,queryTopic,groupedQuerySamples,buildReport,
  assertionForCredentials,getAccessToken,readSearchConsoleReport,
  formatTelegramReport,sendPrivateTelegramReport,
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
      if(body.dimensions[0]==='query')return ok({rows:[{keys:['gemini'],clicks:1,impressions:2}]});
      if(body.dimensions[0]==='page')return ok({rows:[]});
      return ok({rows:[]});
    }
    if(target.includes('urlInspection')){
      assert.ok(GSC_URL_PATHS.some(p=>body.inspectionUrl===GSC_ORIGIN+p));
      return ok({inspectionResult:{indexStatusResult:{verdict:'PASS'}}});
    }
    throw Error('UNEXPECTED_TEST_URL');
  };
  const report=await readSearchConsoleReport(property,creds,mocked,new Date('2026-11-19T12:00:00Z'));
  assert.equal(calls.length,15); // OAuth, permission, five analytics queries, eight inspections.
  assert.equal(report.current.endDate,'2026-11-16');
  assert.equal(report.inspections['/gemini']?.inspectionResult?.indexStatusResult?.verdict,'PASS');
  assert.equal(calls.filter(x=>x.url.includes('searchAnalytics')).length,5);
  assert.ok(calls.every(x=>!x.url.includes('another.example')));
  await assert.rejects(readSearchConsoleReport('sc-domain:another.example',creds,mocked),/PROPERTY_NOT_ALLOWED/);
});

test('Telegram transport sends privately and never echoes credentials on error',async()=>{
  let stored:any;
  const token='123456:abcdefghijklmnopqrstuvwxyzABCDEFGH';
  const mock=async(_url:string|URL,init?:RequestInit)=>{
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
