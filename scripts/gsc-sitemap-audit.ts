/**
 * Read-only Search Console sitemap discovery diagnostic.
 * Only compares against the known public mnebyvpn.site/sitemap.xml URL.
 * https://developers.google.com/webmaster-tools/v1/sitemaps/list
 */
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {GSC_ALLOWED_PROPERTIES,GSC_ORIGIN,getAccessToken} from './gsc-weekly-report.ts';
type HttpClient=(url:string|URL,init?:RequestInit)=>Promise<Response>;
type SitemapEntry={path?:string;isPending?:boolean;errors?:number;warnings?:number;
  lastSubmitted?:string;lastDownloaded?:string;contents?:{type?:string;submitted?:number;indexed?:number}[]};
export type SitemapDiagnostic={
  status:'SUBMITTED'|'NOT_LISTED'|'ERROR';pending:boolean|null;
  errors:number|null;warnings:number|null;lastSubmitted:string;lastDownloaded:string;
  submittedUrls:number|null;indexedUrls:number|null;
};
const TARGET=GSC_ORIGIN+'/sitemap.xml';
function dateOnly(input:unknown):string{
  return typeof input==='string'&&/^\d{4}-\d{2}-\d{2}/.test(input)?input.slice(0,10):'нет данных';
}
function count(input:unknown):number|null{
  return typeof input==='number'&&Number.isSafeInteger(input)&&input>=0?input:null;
}
export function describeSitemap(entries:SitemapEntry[]|undefined):SitemapDiagnostic{
  const entry=entries?.find(e=>e.path===TARGET);
  const empty:SitemapDiagnostic={status:'NOT_LISTED',pending:null,errors:null,warnings:null,
    lastSubmitted:'нет данных',lastDownloaded:'нет данных',submittedUrls:null,indexedUrls:null};
  if(!entry)return empty;
  const web=entry.contents?.find(x=>x.type==='web')??entry.contents?.[0];
  return {status:'SUBMITTED',pending:typeof entry.isPending==='boolean'?entry.isPending:null,
    errors:count(entry.errors),warnings:count(entry.warnings),
    lastSubmitted:dateOnly(entry.lastSubmitted),lastDownloaded:dateOnly(entry.lastDownloaded),
    submittedUrls:count(web?.submitted),indexedUrls:count(web?.indexed)};
}
async function request<T>(fetchImpl:HttpClient,url:string,headers:Record<string,string>,kind:string):Promise<T>{
  let response:Response;
  try{response=await fetchImpl(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(18000)});}
  catch{throw Error('GSC_SITEMAP_'+kind+'_NETWORK');}
  if(!response.ok)throw Error('GSC_SITEMAP_'+kind+'_HTTP_'+response.status);
  try{return await response.json() as T;}catch{throw Error('GSC_SITEMAP_'+kind+'_JSON');}
}
export async function readSitemapDiagnostic(
  property:string,json:string,fetchImpl:HttpClient=fetch,
):Promise<SitemapDiagnostic>{
  if(!GSC_ALLOWED_PROPERTIES.includes(property))throw Error('GSC_SITEMAP_PROPERTY_NOT_ALLOWED');
  const token=await getAccessToken(json,fetchImpl);
  const headers={Authorization:'Bearer '+token};
  const base='https://www.googleapis.com/webmasters/v3/sites/'+encodeURIComponent(property);
  const site=await request<{siteUrl?:string;permissionLevel?:string}>(fetchImpl,base,headers,'SITE');
  if(site.siteUrl!==property||!['siteOwner','siteFullUser','siteRestrictedUser'].includes(site.permissionLevel??''))
    throw Error('GSC_SITEMAP_PROPERTY_ACCESS_NOT_VERIFIED');
  const response=await request<{sitemap?:SitemapEntry[]}>(fetchImpl,base+'/sitemaps',headers,'LIST');
  return describeSitemap(response.sitemap);
}
export async function main():Promise<void>{
  const credentials=process.env.GSC_SERVICE_ACCOUNT_JSON;
  if(!credentials)throw Error('GSC_SITEMAP_KEY_MISSING');
  const property=process.env.GSC_SITE_URL||'sc-domain:mnebyvpn.site';
  const diagnostic=await readSitemapDiagnostic(property,credentials);
  const lines=[
    '## Карта сайта в Google Search Console','',
    'Проверено свойство: `'+property+'`. Единственный проверяемый URL: `'+TARGET+'`.',
    'Статус: **'+diagnostic.status+'**; обработка: '+
      (diagnostic.pending===null?'нет данных':diagnostic.pending?'ожидается':'не ожидается')+'.',
    'Последняя отправка: '+diagnostic.lastSubmitted+
      '; последняя загрузка Google: '+diagnostic.lastDownloaded+'.',
    'Ошибки: '+(diagnostic.errors??'нет данных')+
      '; предупреждения: '+(diagnostic.warnings??'нет данных')+'.',
    'URL, отчёт Google: отправлено '+(diagnostic.submittedUrls??'нет данных')+
      '; проиндексировано '+(diagnostic.indexedUrls??'нет данных')+'.',
    '',
    'Если карта отсутствует в списке **этого свойства**, это не доказывает, что Google не знает её из robots.txt или другого свойства.',
    'Источник: [Google Search Console Sitemaps API](https://developers.google.com/webmaster-tools/v1/sitemaps/list).',''
  ];
  const summary=process.env.GITHUB_STEP_SUMMARY;
  if(summary)appendFileSync(summary,lines.join('\n'));
  // No URLs other than the known sitemap, no credentials and no search traffic.
  console.log('PUBLIC_GSC_SITEMAP='+diagnostic.status+
    '; pending='+String(diagnostic.pending)+
    '; errors='+String(diagnostic.errors)+
    '; warnings='+String(diagnostic.warnings)+
    '; last_submitted='+diagnostic.lastSubmitted+
    '; last_downloaded='+diagnostic.lastDownloaded+
    '; url_submitted='+String(diagnostic.submittedUrls)+
    '; url_indexed='+String(diagnostic.indexedUrls));
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  main().catch(error=>{
    const code=error instanceof Error&&/^GSC_SITEMAP_[A-Z0-9_]+$/.test(error.message)?
      error.message:'GSC_SITEMAP_UNEXPECTED_ERROR';
    console.error('PUBLIC_GSC_SITEMAP=ERROR; reason='+code);
    process.exitCode=1;
  });
}
