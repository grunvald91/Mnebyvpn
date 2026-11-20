/**
 * Read-only MNEBYVPN Search Console report.
 * Requires the service account to have read access to the verified property.
 * Does NOT write Search Console settings, mutate the site or reveal search terms.
 * No third-party dependencies; Node.js 22.16+.
 *
 * Documentation:
 * https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 * https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
 * https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
 */
import {sign} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const GSC_ORIGIN='https://mnebyvpn.site';
export const GSC_ALLOWED_PROPERTIES=Object.freeze([
  'sc-domain:mnebyvpn.site','https://mnebyvpn.site/',
]);
export const GSC_URL_PATHS=Object.freeze([
  '/', '/vpn', '/smart-dns', '/chatgpt', '/claude',
  '/gemini', '/google-antigravity', '/telegram-proxy',
]);
const TOKEN_URL='https://oauth2.googleapis.com/token';
const SCOPE='https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE='https://www.googleapis.com';
const INSPECTION_URL='https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

type GscRow={keys?:string[];clicks?:number;impressions?:number;ctr?:number;position?:number};
type GscResponse={rows?:GscRow[]};
type GscIndexResult={inspectionResult?:{indexStatusResult?:{
  verdict?:string;coverageState?:string;indexingState?:string;lastCrawlTime?:string;
}}};
type AuthCredentials={type?:string;client_email?:string;private_key?:string;token_uri?:string};
type SearchMetrics={clicks:number;impressions:number;ctr:number|null;position:number|null;hasData:boolean};
export type GscReportInput={
  property:string;current:{startDate:string;endDate:string};previous:{startDate:string;endDate:string};
  totalsCurrent:GscResponse;totalsPrevious:GscResponse;pagesCurrent:GscResponse;
  pagesPrevious:GscResponse;queryData:GscResponse;
  inspections:Record<string,GscIndexResult|null>;
};

export function minusDays(isoDate:string,days:number):string{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)||!Number.isInteger(days))throw Error('INVALID_DATE');
  const date=new Date(isoDate+'T12:00:00Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==isoDate)throw Error('INVALID_DATE');
  date.setUTCDate(date.getUTCDate()-days);
  return date.toISOString().slice(0,10);
}

export function reportPeriods(now=new Date()):{
  current:{startDate:string;endDate:string};previous:{startDate:string;endDate:string}
}{
  // Search Console dates are in Pacific Time. Avoid preliminary/incomplete days.
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(now).map(p=>[p.type,p.value]));
  const pacificDate=`${parts.year}-${parts.month}-${parts.day}`;
  const endDate=minusDays(pacificDate,3);
  const startDate=minusDays(endDate,27);
  const previousEnd=minusDays(startDate,1);
  return {
    current:{startDate,endDate},
    previous:{startDate:minusDays(previousEnd,27),endDate:previousEnd},
  };
}

function number(value:unknown):number{
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
}
export function combineDailyRows(rows:GscRow[]=[]):SearchMetrics{
  let clicks=0,impressions=0,weightedPosition=0,hasData=false;
  for(const row of rows){
    if(!row||typeof row!=='object')continue;
    hasData=true;
    const count=number(row.impressions);
    clicks+=number(row.clicks);
    impressions+=count;
    weightedPosition+=count*number(row.position);
  }
  return {
    clicks,impressions,
    ctr:impressions>0?clicks/impressions:null,
    position:impressions>0?weightedPosition/impressions:null,
    hasData,
  };
}

export function pageMetrics(rows:GscRow[]=[],url:string):SearchMetrics{
  const row=rows.find(row=>row.keys?.[0]===url);
  if(!row)return {clicks:0,impressions:0,ctr:null,position:null,hasData:false};
  const clicks=number(row.clicks),impressions=number(row.impressions);
  return {
    clicks,impressions,ctr:impressions>0?clicks/impressions:null,
    position:impressions>0?number(row.position):null,hasData:true,
  };
}

export const QUERY_TOPICS=Object.freeze([
  {name:'Google Antigravity',pattern:/antigravity|антигравит|антигравит[ий]/i},
  {name:'Gemini',pattern:/gemini|джемини|гемини/i},
  {name:'Claude / Claude Code',pattern:/claude|клод|клоуд/i},
  {name:'ChatGPT',pattern:/chat\s?gpt|чат\s?гпт|openai/i},
  {name:'Smart DNS',pattern:/smart\s?dns|dns|днс|частный\s?днс/i},
  {name:'Telegram',pattern:/telegram|телеграм|mtproto/i},
  {name:'VPN',pattern:/\bvpn\b|впн/i},
]);
export function queryTopic(query:string):string{
  for(const topic of QUERY_TOPICS)if(topic.pattern.test(query))return topic.name;
  return 'Прочие запросы';
}
export function groupedQuerySamples(rows:GscRow[]=[]):{topic:string;clicks:number;impressions:number}[]{
  const grouped=new Map<string,{topic:string;clicks:number;impressions:number}>();
  for(const row of rows){
    if(typeof row.keys?.[0]!=='string')continue;
    const topic=queryTopic(row.keys[0]);
    const target=grouped.get(topic)??{topic,clicks:0,impressions:0};
    target.clicks+=number(row.clicks);
    target.impressions+=number(row.impressions);
    grouped.set(topic,target);
  }
  return [...grouped.values()].sort((a,b)=>b.impressions-a.impressions||a.topic.localeCompare(b.topic,'ru'));
}


/**
 * Simple review flags, not proof of a search-ranking cause or a guaranteed
 * improvement. Every threshold is transparent and based on actual GSC rows.
 */
export function identifySeoReviewItems(input:GscReportInput):string[]{
  const notes:string[]=[];
  for(const path of GSC_URL_PATHS){
    const current=pageMetrics(input.pagesCurrent.rows,GSC_ORIGIN+path);
    const previous=pageMetrics(input.pagesPrevious.rows,GSC_ORIGIN+path);
    const status=input.inspections[path]?.inspectionResult?.indexStatusResult;
    if(!status){
      notes.push(path+': URL Inspection не вернул статус — индексация не установлена.');
    }else if(status.verdict!=='PASS'){
      notes.push(path+': Google URL Inspection: '+safeCell(status.verdict??'UNKNOWN')+
        ', состояние: '+safeCell(status.coverageState??'не указано')+
        '. Проверить причину в Search Console.');
    }
    if(previous.hasData&&previous.impressions>=40&&
      current.hasData&&current.impressions*2<previous.impressions){
      notes.push(path+': показы снизились более чем на 50% ('+
        Math.round(previous.impressions)+' → '+Math.round(current.impressions)+
        ' за одинаковые 28-дневные интервалы). Проверить динамику запроса и конкуренцию.');
    }
    if(current.hasData&&current.impressions>=100&&
      current.ctr!==null&&current.ctr<0.01){
      notes.push(path+': CTR ниже 1% при '+Math.round(current.impressions)+
        ' показах. Проверить соответствие заголовка поисковым запросам; это не диагноз.');
    }
  }
  return notes;
}

function fmtNumber(n:number):string{return Math.round(n).toLocaleString('ru-RU');}
function fmtRate(rate:number|null):string{return rate===null?'нет данных':(rate*100).toFixed(2)+'%';}
function fmtPosition(n:number|null):string{return n===null?'нет данных':n.toFixed(1);}
function safeCell(s:string):string{return s.replace(/[\r\n|]/g,' ').slice(0,160);}

export function buildReport(input:GscReportInput):string{
  if(!GSC_ALLOWED_PROPERTIES.includes(input.property))throw Error('PROPERTY_NOT_ALLOWED');
  const curr=combineDailyRows(input.totalsCurrent.rows),prev=combineDailyRows(input.totalsPrevious.rows);
  const propertyNote=input.property.startsWith('sc-domain:')?
    'Свойство домена может включать поддомены. Таблица URL ниже относится только к указанным каноническим страницам.':
    'Статистика свойства URL-prefix относится к настроенному префиксу.';
  const lines=[
    '# MNEBYVPN — Search Console: еженедельный отчёт',
    '',
    `Период: **${input.current.startDate} — ${input.current.endDate}** (последние 28 завершённых дней, дата Search Console — Pacific Time).`,
    `Сравнение: ${input.previous.startDate} — ${input.previous.endDate}.`,
    `Свойство: \`${input.property}\`.`,
    '',
    '## Поисковая эффективность свойства',
    '',
    '| Показатель | Текущий период | Предыдущий период |',
    '|---|---:|---:|',
    `| Клики | ${curr.hasData?fmtNumber(curr.clicks):'нет данных'} | ${prev.hasData?fmtNumber(prev.clicks):'нет данных'} |`,
    `| Показы | ${curr.hasData?fmtNumber(curr.impressions):'нет данных'} | ${prev.hasData?fmtNumber(prev.impressions):'нет данных'} |`,
    `| CTR | ${fmtRate(curr.ctr)} | ${fmtRate(prev.ctr)} |`,
    `| Средняя позиция | ${fmtPosition(curr.position)} | ${fmtPosition(prev.position)} |`,
    '',
    propertyNote,
    '',
    '## Канонические посадочные страницы',
    '',
    '| Страница | Клики | Показы | Показы ранее | CTR | Позиция | Вердикт индексации Google |',
    '|---|---:|---:|---:|---:|---:|---|',
  ];
  for(const path of GSC_URL_PATHS){
    const url=GSC_ORIGIN+path;
    const m=pageMetrics(input.pagesCurrent.rows,url);
    const previousPage=pageMetrics(input.pagesPrevious.rows,url);
    const index=input.inspections[path]?.inspectionResult?.indexStatusResult;
    lines.push(`| \`${path}\` | ${m.hasData?fmtNumber(m.clicks):'нет данных'} | ${m.hasData?fmtNumber(m.impressions):'нет данных'} | ${previousPage.hasData?fmtNumber(previousPage.impressions):'нет данных'} | ${fmtRate(m.ctr)} | ${fmtPosition(m.position)} | ${safeCell(index?.verdict??'не проверено')} |`);
  }
  lines.push('',
    '## Запросы по темам (выборка Google)',
    '',
    '| Группа | Клики в выборке | Показы в выборке |',
    '|---|---:|---:|');
  const groups=groupedQuerySamples(input.queryData.rows);
  if(groups.length===0)lines.push('| Нет данных | — | — |');
  for(const group of groups)lines.push(`| ${group.topic} | ${fmtNumber(group.clicks)} | ${fmtNumber(group.impressions)} |`);
  lines.push('',
    '## Что требует внимания',
    '');
  const reviewItems=identifySeoReviewItems(input);
  if(reviewItems.length){
    lines.push('Правила: снижение показов более 50% при ≥40 предыдущих показах; CTR менее 1% при ≥100 текущих показах. Это наблюдения, не доказанные причины.');
    for(const note of reviewItems)lines.push('- '+note);
    lines.push('');
  }
  let issues=0;
  for(const path of GSC_URL_PATHS){
    const index=input.inspections[path]?.inspectionResult?.indexStatusResult;
    if(!index){
      lines.push(`- \`${path}\`: статус Google URL Inspection недоступен; **не делаем вывода об индексации**.`);
      issues++;
    }else if(index.verdict!=='PASS'){
      lines.push(`- \`${path}\`: вердикт ${safeCell(index.verdict??'UNKNOWN')}; причина по API: ${safeCell(index.coverageState??'не указана')}.`);
      issues++;
    }
  }
  if(!issues)lines.push('Все восемь URL получили вердикт PASS в URL Inspection. Это данные об индексной версии, не live-проверка.');
  lines.push('',
    '> Важные ограничения: отсутствие показов **не равно** отсутствию индексации; URL Inspection показывает состояние версии в индексе, не тест живой страницы. Строки по запросам — только доступная выборка верхних запросов Google, а не полная статистика и не частотность рынка. Отчёт не содержит сами поисковые фразы, идентификаторы пользователей или приватные URL.',
    '',
    'Документация: [Search Analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [URL Inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).',
    '');
  return lines.join('\n');
}

function b64url(value:Buffer|string):string{
  return Buffer.from(value).toString('base64url');
}
export function assertionForCredentials(raw:string,now=Math.floor(Date.now()/1000)):string{
  let credential:AuthCredentials;
  try{credential=JSON.parse(raw) as AuthCredentials;}catch{throw Error('INVALID_GSC_CREDENTIAL_FORMAT');}
  if(credential.type!=='service_account'||credential.token_uri!==TOKEN_URL||
    !credential.client_email?.endsWith('.gserviceaccount.com')||
    typeof credential.private_key!=='string'||!credential.private_key.includes('BEGIN PRIVATE KEY'))
    throw Error('INVALID_GSC_CREDENTIAL_FORMAT');
  const header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claim=b64url(JSON.stringify({
    iss:credential.client_email,scope:SCOPE,aud:TOKEN_URL,iat:now,exp:now+3600,
  }));
  try{
    const payload=`${header}.${claim}`;
    const signature=b64url(sign('RSA-SHA256',Buffer.from(payload),credential.private_key));
    return `${payload}.${signature}`;
  }catch{throw Error('GSC_CREDENTIAL_SIGNATURE_FAILED');}
}

type HttpClient=(input:string|URL,init?:RequestInit)=>Promise<Response>;
async function requestJSON(fetchImpl:HttpClient,url:string,init:RequestInit,context:string):Promise<any>{
  let response:Response;
  try{
    response=await fetchImpl(url,{...init,signal:AbortSignal.timeout(20000)});
  }catch{throw Error(`GSC_${context}_NETWORK_ERROR`);}
  if(!response.ok)throw Error(`GSC_${context}_HTTP_${response.status}`);
  try{return await response.json();}catch{throw Error(`GSC_${context}_INVALID_JSON`);}
}
export async function getAccessToken(serviceAccountJson:string,fetchImpl:HttpClient=fetch):Promise<string>{
  const jwt=assertionForCredentials(serviceAccountJson);
  const payload=new URLSearchParams({
    grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:jwt,
  });
  const data=await requestJSON(fetchImpl,TOKEN_URL,{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:payload.toString(),
  },'AUTH');
  if(typeof data.access_token!=='string'||!data.access_token)throw Error('GSC_AUTH_MISSING_TOKEN');
  return data.access_token;
}

export async function readSearchConsoleReport(
  property:string,serviceAccountJson:string,fetchImpl:HttpClient=fetch,now=new Date(),
):Promise<GscReportInput>{
  if(!GSC_ALLOWED_PROPERTIES.includes(property))throw Error('PROPERTY_NOT_ALLOWED');
  const token=await getAccessToken(serviceAccountJson,fetchImpl);
  const auth={Authorization:'Bearer '+token};
  const path=encodeURIComponent(property);
  const site=await requestJSON(fetchImpl,`${API_BASE}/webmasters/v3/sites/${path}`,{
    method:'GET',headers:auth,
  },'SITE');
  if(site.siteUrl!==property||!['siteOwner','siteFullUser','siteRestrictedUser'].includes(site.permissionLevel))
    throw Error('GSC_PROPERTY_ACCESS_NOT_VERIFIED');
  const dates=reportPeriods(now);
  const search=async(body:Record<string,unknown>):Promise<GscResponse>=>{
    return requestJSON(fetchImpl,`${API_BASE}/webmasters/v3/sites/${path}/searchAnalytics/query`,{
      method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body),
    },'ANALYTICS');
  };
  const requestBody=(period:{startDate:string;endDate:string},dimensions:string[],rowLimit:number,filtered=false)=>({
    ...period,dimensions,type:'web',dataState:'final',rowLimit,
    // Filter by the exact eight canonical URLs. Google's filterLists accepts
    // several exact page values in one request; avoid a site-wide top-N cutoff.
    ...(filtered?{dimensionFilterGroups:[{filterLists:[{
      dimension:'page',expressions:GSC_URL_PATHS.map(path=>GSC_ORIGIN+path),
    }]}]}:{}),
  });
  // Property-level daily totals: no page filters, no query-based truncation.
  const totalsCurrent=await search(requestBody(dates.current,['date'],1000));
  const totalsPrevious=await search(requestBody(dates.previous,['date'],1000));
  // Keep just the exact canonical pages, not the top 25k domain-wide pages.
  const pagesCurrent=await search(requestBody(dates.current,['page'],100,true));
  const pagesPrevious=await search(requestBody(dates.previous,['page'],100,true));
  // Sampled/possibly anonymized: never infer market demand from this set.
  const queryData=await search(requestBody(dates.current,['query'],1000,true));

  const inspections:Record<string,GscIndexResult|null>={};
  for(const urlPath of GSC_URL_PATHS){
    try{
      inspections[urlPath]=await requestJSON(fetchImpl,INSPECTION_URL,{
        method:'POST',headers:{...auth,'Content-Type':'application/json'},
        body:JSON.stringify({inspectionUrl:GSC_ORIGIN+urlPath,siteUrl:property,languageCode:'ru-RU'}),
      },'INSPECTION');
    }catch{
      inspections[urlPath]=null; // Do not convert API failures to 'not indexed'.
    }
  }
  return {property,...dates,totalsCurrent,totalsPrevious,pagesCurrent,pagesPrevious,queryData,inspections};
}


/** Private, size-limited Telegram report: never call this with a public GitHub summary. */
export function formatTelegramReport(input:GscReportInput):string{
  const total=combineDailyRows(input.totalsCurrent.rows);
  const previous=combineDailyRows(input.totalsPrevious.rows);
  const lines=[
    'MNEBYVPN · Google Search Console',
    input.current.startDate+' — '+input.current.endDate+' (28 дней)',
    'Показы: '+(total.hasData?fmtNumber(total.impressions):'нет данных')+
      ' (ранее: '+(previous.hasData?fmtNumber(previous.impressions):'нет данных')+')',
    'Клики: '+(total.hasData?fmtNumber(total.clicks):'нет данных')+
      ' (ранее: '+(previous.hasData?fmtNumber(previous.clicks):'нет данных')+')',
    'CTR: '+fmtRate(total.ctr)+' · позиция: '+fmtPosition(total.position),
    '',
    'Страницы:'
  ];
  for(const path of GSC_URL_PATHS){
    const m=pageMetrics(input.pagesCurrent.rows,GSC_ORIGIN+path);
    const verdict=input.inspections[path]?.inspectionResult?.indexStatusResult?.verdict??'не проверено';
    lines.push(path+': '+(m.hasData?fmtNumber(m.impressions)+' показов / '+fmtNumber(m.clicks)+' кликов':'нет данных')+'; индекс: '+safeCell(verdict));
  }
  const grouped=groupedQuerySamples(input.queryData.rows);
  lines.push('','Запросы по темам (выборка, не весь рынок):');
  for(const g of grouped.slice(0,8))lines.push(g.topic+': '+fmtNumber(g.impressions)+' показов');
  const review=identifySeoReviewItems(input);
  lines.push('','Проверить:');
  if(!review.length)lines.push('Нет срабатываний установленных правил.');
  else for(const note of review.slice(0,5))lines.push('• '+note);
  if(review.length>5)lines.push('И ещё '+(review.length-5)+' пункта; полный отчёт доступен при локальном запуске.');
  lines.push('','Отсутствие показов не доказывает отсутствие индексации. Данные Google могут поступать с задержкой.');
  return lines.join('\n').slice(0,3800);
}

export async function sendPrivateTelegramReport(
  summary:string,token:string,chatId:string,fetchImpl:HttpClient=fetch,
):Promise<void>{
  if(!/^\d{5,12}:[A-Za-z0-9_-]{30,}$/.test(token)||
    !/^-?\d{5,20}$/.test(chatId))throw Error('GSC_TELEGRAM_CONFIG_INVALID');
  if(summary.length>3900)throw Error('GSC_TELEGRAM_REPORT_TOO_LONG');
  const reply=await requestJSON(fetchImpl,'https://api.telegram.org/bot'+token+'/sendMessage',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chatId,text:summary,disable_web_page_preview:true}),
  },'TELEGRAM');
  if(reply.ok!==true)throw Error('GSC_TELEGRAM_DELIVERY_FAILED');
}

export async function main():Promise<void>{
  const credential=process.env.GSC_SERVICE_ACCOUNT_JSON;
  if(!credential)throw Error('GSC_NOT_CONFIGURED');
  const property=process.env.GSC_SITE_URL||'sc-domain:mnebyvpn.site';
  const input=await readSearchConsoleReport(property,credential);
  const report=buildReport(input);
  const summary=process.env.GITHUB_STEP_SUMMARY;
  if(process.env.GITHUB_ACTIONS==='true'){
    // This repository is public. Never print metrics into public Action logs/summaries/artifacts.
    const botToken=process.env.GSC_TELEGRAM_BOT_TOKEN||'';
    const adminChat=process.env.GSC_TELEGRAM_CHAT_ID||'';
    if(!botToken||!adminChat)throw Error('GSC_PRIVATE_DELIVERY_NOT_CONFIGURED');
    await sendPrivateTelegramReport(formatTelegramReport(input),botToken,adminChat);
    if(summary)appendFileSync(summary,'GSC: отчёт доставлен в приватный Telegram. Данные не публиковались в GitHub.\n',{encoding:'utf8'});
  }else{
    // Local execution is permitted: stdout stays on the operator's own machine.
    process.stdout.write(report);
  }
  console.log('GSC_REPORT_STATUS=PASS; PAGES='+GSC_URL_PATHS.length+'; RAW_QUERIES_EXPORTED=0');
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  main().catch(error=>{
    // Never log credential, JWT, bearer token, request body or API response.
    const code=error instanceof Error&&/^(?:GSC_|INVALID_GSC_|PROPERTY_NOT_ALLOWED)/.test(error.message)?
      error.message:'GSC_REPORT_UNEXPECTED_ERROR';
    console.error('GSC_REPORT_STATUS=ERROR; REASON='+code);
    process.exitCode=1;
  });
}
