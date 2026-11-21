/**
 * Index-only diagnostics for all approved PUBLIC canonical MNEBYVPN sitemap URLs.
 * Does not export raw Search Console queries, search metrics, tokens or other URLs.
 * Source: https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
 */
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {GSC_ALLOWED_PROPERTIES,GSC_ORIGIN,getAccessToken}
  from './gsc-weekly-report.ts';
import {PUBLIC_SEO_PATHS} from '../apps/web/src/seo-core.ts';

type FetchClient=(input:string|URL,init?:RequestInit)=>Promise<Response>;
type IndexStatus={
  verdict?:string;coverageState?:string;robotsTxtState?:string;
  indexingState?:string;pageFetchState?:string;
  lastCrawlTime?:string;userCanonical?:string;googleCanonical?:string;
};
export type PublicIndexRow={
  path:string;verdict:'PASS'|'FAIL'|'NEUTRAL'|'UNKNOWN'|'ERROR';
  coverage:string;robots:string;fetchStatus:string;indexing:string;
  crawl:string;canonical:'same'|'different'|'unknown';issue:string;
};

function safeStatus(value:unknown):string{
  if(typeof value!=='string'||!value.trim())return 'нет данных';
  // No arbitrary external URLs, credentials, HTML, markdown or newlines in public CI.
  const text=value.replace(/[<>|\r\n\t`]/g,' ').trim();
  if(/https?:\/\//i.test(text))return 'URL скрыт';
  return text.slice(0,110);
}
export function describeIndex(path:string,status:IndexStatus|null,apiError=false):PublicIndexRow{
  const base:PublicIndexRow={
    path,verdict:'UNKNOWN',coverage:'нет данных',robots:'нет данных',
    fetchStatus:'нет данных',indexing:'нет данных',crawl:'неизвестно',
    canonical:'unknown',issue:'Недостаточно данных для вывода об индексации',
  };
  if(apiError)return {...base,verdict:'ERROR',issue:'URL Inspection API: ошибка проверки'};
  if(!status)return {...base,issue:'URL Inspection не вернул сведения о странице'};
  const verdict=['PASS','FAIL','NEUTRAL'].includes(status.verdict||'')?
    status.verdict as PublicIndexRow['verdict']:'UNKNOWN';
  const expected=GSC_ORIGIN+path;
  const canonical:PublicIndexRow['canonical']=typeof status.googleCanonical==='string'&&status.googleCanonical?
    status.googleCanonical===expected?'same':'different':'unknown';
  const result:PublicIndexRow={...base,verdict,coverage:safeStatus(status.coverageState),
    robots:safeStatus(status.robotsTxtState),fetchStatus:safeStatus(status.pageFetchState),
    indexing:safeStatus(status.indexingState),
    crawl:typeof status.lastCrawlTime==='string'&&
      /^\d{4}-\d{2}-\d{2}T/.test(status.lastCrawlTime)?
      status.lastCrawlTime.slice(0,10):'неизвестно',canonical,
  };
  const state=(status.coverageState??'').toLowerCase();
  if(verdict==='PASS')return {...result,issue:canonical==='different'?
    'В индексе, но Google выбрал другой canonical; проверить дубли':
    'Индексация подтверждена URL Inspection'};
  if(status.robotsTxtState==='DISALLOWED'||status.pageFetchState==='BLOCKED_ROBOTS_TXT')
    return {...result,issue:'Google: сканирование заблокировано robots.txt'};
  if(status.indexingState==='BLOCKED_BY_META_TAG'||status.indexingState==='BLOCKED_BY_HTTP_HEADER')
    return {...result,issue:'Google: обнаружен запрет noindex'};
  if(/discovered|обнаружен/i.test(state))
    return {...result,issue:'Google обнаружил страницу, но пока не просканировал'};
  if(/crawled|просканирован/i.test(state))
    return {...result,issue:'Google просканировал страницу, но пока не индексировал'};
  if(/duplicate|дубликат|canonical|каноническ/i.test(state)||canonical==='different')
    return {...result,issue:'Google считает URL дубликатом или выбрал другой canonical'};
  if(verdict==='FAIL')return {...result,issue:'URL Inspection не подтверждает индексацию; изучить coverage'};
  return {...result,issue:'Статус не позволяет подтвердить индексацию'};
}

export function formatIndexAudit(rows:PublicIndexRow[]):string{
  const lines=[
    '# Google URL Inspection — '+PUBLIC_SEO_PATHS.length+' публичных страниц MNEBYVPN',
    '',
    'Только данные индекса Google. Отсутствие поисковых показов не равно отсутствию индексации.',
    'Не включены: поисковые запросы, клики, показы, ключи и персональные страницы.',
    '',
    '| Страница | Вердикт API | Состояние | Последний обход | Canonical | Приоритет проверки |',
    '|---|---|---|---|---|---|',
  ];
  for(const row of rows)lines.push(
    '| `'+row.path+'` | '+row.verdict+' | '+row.coverage+' | '+row.crawl+
    ' | '+row.canonical+' | '+row.issue+' |');
  lines.push('','Подробнее о блокировках:','');
  for(const row of rows)if(row.verdict!=='PASS')
    lines.push('- `'+row.path+'`: robots='+row.robots+
      '; индексирование='+row.indexing+'; загрузка='+row.fetchStatus);
  lines.push('','Источник: [Google URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).',
    'Не используется Live URL Test: данные Google относятся к версии в индексе.','');
  return lines.join('\n');
}

async function api<T>(fetchImpl:FetchClient,url:string,init:RequestInit,code:string):Promise<T>{
  let response:Response;
  try{response=await fetchImpl(url,{...init,redirect:'error',signal:AbortSignal.timeout(18_000)});}
  catch{throw Error('INDEX_'+code+'_NETWORK');}
  if(!response.ok)throw Error('INDEX_'+code+'_HTTP_'+response.status);
  try{return await response.json() as T;}catch{throw Error('INDEX_'+code+'_JSON');}
}
export async function inspectPublicPages(
  property:string,json:string,fetchImpl:FetchClient=fetch,
):Promise<PublicIndexRow[]>{
  if(!GSC_ALLOWED_PROPERTIES.includes(property))throw Error('INDEX_PROPERTY_NOT_ALLOWED');
  const token=await getAccessToken(json,fetchImpl);
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const site=await api<{siteUrl?:string;permissionLevel?:string}>(
    fetchImpl,'https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent(property),
    {method:'GET',headers},'PROPERTY');
  if(site.siteUrl!==property||!['siteOwner','siteFullUser','siteRestrictedUser'].includes(site.permissionLevel||''))
    throw Error('INDEX_PROPERTY_ACCESS_NOT_VERIFIED');
  const rows:PublicIndexRow[]=[];
  for(const path of PUBLIC_SEO_PATHS){
    try{
      const result=await api<{inspectionResult?:{indexStatusResult?:IndexStatus}}>(
        fetchImpl,'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {method:'POST',headers,body:JSON.stringify({
          inspectionUrl:GSC_ORIGIN+path,siteUrl:property,languageCode:'ru-RU',
        })},'INSPECTION');
      rows.push(describeIndex(path,result.inspectionResult?.indexStatusResult??null));
    }catch{rows.push(describeIndex(path,null,true));}
  }
  return rows;
}

/**
 * A technically green check with failed URL Inspection requests is misleading.
 * Unknown/unindexed pages are normal; only API errors or incomplete coverage
 * must fail the scheduled audit AFTER writing the diagnostic summary.
 */
export function assertIndexAuditComplete(rows:readonly PublicIndexRow[]):void {
  if(rows.length!==PUBLIC_SEO_PATHS.length||
     rows.some((r,i)=>r.path!==PUBLIC_SEO_PATHS[i]))
    throw Error('INDEX_PUBLIC_INSPECTION_INCOMPLETE');
  const errors=rows.filter(row=>row.verdict==='ERROR').length;
  if(errors>0)throw Error('INDEX_PUBLIC_INSPECTION_API_ERRORS_'+errors);
}

export async function main():Promise<void>{
  const credential=process.env.GSC_SERVICE_ACCOUNT_JSON;
  if(!credential)throw Error('INDEX_GSC_NOT_CONFIGURED');
  const rows=await inspectPublicPages(process.env.GSC_SITE_URL||'sc-domain:mnebyvpn.site',credential);
  const markdown=formatIndexAudit(rows);
  // Only status of the approved public URLs is logged: never search terms or traffic.
  for(const row of rows)console.log('PUBLIC_INDEX_PAGE='+row.path+
    '; verdict='+row.verdict+'; coverage='+row.coverage+
    '; last_crawl='+row.crawl+'; canonical='+row.canonical+
    '; robots='+row.robots+'; indexing='+row.indexing+
    '; fetch='+row.fetchStatus);
  const summary=process.env.GITHUB_STEP_SUMMARY;
  if(summary)appendFileSync(summary,markdown);
  else process.stdout.write(markdown);
  // Only public-page verdict count; never print arbitrary source strings.
  const apiErrors=rows.filter(r=>r.verdict==='ERROR').length;
  console.log('GSC_INDEX_AUDIT='+(apiErrors?'PARTIAL':'COMPLETED')+'; checked='+rows.length+
    '; passed='+rows.filter(r=>r.verdict==='PASS').length+
    '; failed='+rows.filter(r=>r.verdict==='FAIL').length+
    '; unknown='+rows.filter(r=>r.verdict==='UNKNOWN'||r.verdict==='NEUTRAL').length+
    '; api_errors='+apiErrors);
  assertIndexAuditComplete(rows);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  main().catch(error=>{
    const code=error instanceof Error&&/^INDEX_[A-Z0-9_]+$/.test(error.message)?
      error.message:'INDEX_UNEXPECTED_ERROR';
    console.error('GSC_INDEX_AUDIT=FAILED; reason='+code);
    process.exitCode=1;
  });
}
