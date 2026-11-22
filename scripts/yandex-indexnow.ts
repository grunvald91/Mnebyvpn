/**
 * Owner-only Yandex IndexNow notification for newly published SEO pages.
 * No Google Indexing API misuse: that API is not for ordinary website guides.
 * Public ownership key is served by /<key>.txt on our own HTTPS origin.
 * Sources: https://yandex.ru/support/webmaster/ru/indexing-options/index-now
 */
import {pathToFileURL} from 'node:url';
import {SEO_PAGES} from '../apps/web/src/seo-pages.ts';
import {YANDEX_INDEXNOW_KEY,YANDEX_INDEXNOW_KEY_PATH}
  from '../apps/web/src/seo-core.ts';

const ORIGIN='https://mnebyvpn.site';
export const INDEXNOW_ENDPOINT='https://yandex.com/indexnow';
export const INDEXNOW_KEY_LOCATION=ORIGIN+YANDEX_INDEXNOW_KEY_PATH;
// New 19 Nov instructions and updated homepage: don't resubmit unchanged legal pages.
export const INDEXNOW_UPDATED_PATHS=Object.freeze(['/',...SEO_PAGES.map(p=>p.path)]);
type FetchClient=(url:string,init?:RequestInit)=>Promise<Response>;

export function buildIndexNowPayload(paths:readonly string[]=INDEXNOW_UPDATED_PATHS){
  const permitted=new Set(INDEXNOW_UPDATED_PATHS);
  if(!paths.length||paths.length>INDEXNOW_UPDATED_PATHS.length||
     paths.some(p=>!permitted.has(p))||new Set(paths).size!==paths.length)
    throw Error('INDEXNOW_INVALID_PUBLIC_URLS');
  return {
    host:'mnebyvpn.site',key:YANDEX_INDEXNOW_KEY,
    keyLocation:INDEXNOW_KEY_LOCATION,
    urlList:paths.map(p=>ORIGIN+p),
  };
}

/**
 * Only notify Yandex after these exact public routes are actually available
 * and indexable on production. Source code or a successful merge alone is not
 * proof of deployment. No private pages or external URLs are requested.
 */
export async function verifyLiveSeoReady(fetchImpl:FetchClient=fetch):Promise<void>{
  let proof:Response;
  try{
    proof=await fetchImpl(INDEXNOW_KEY_LOCATION,{method:'GET',redirect:'error',
      signal:AbortSignal.timeout(12000)});
  }catch{throw Error('INDEXNOW_PROOF_NETWORK');}
  if(proof.status!==200)throw Error('INDEXNOW_PROOF_HTTP_'+proof.status);
  let content:string;
  try{content=await proof.text();}catch{throw Error('INDEXNOW_PROOF_BODY');}
  if(content.trim()!==YANDEX_INDEXNOW_KEY)throw Error('INDEXNOW_PROOF_MISMATCH');

  for(const path of INDEXNOW_UPDATED_PATHS){
    const url=ORIGIN+path;
    let page:Response;
    try{
      page=await fetchImpl(url,{method:'GET',redirect:'error',
        signal:AbortSignal.timeout(12000)});
    }catch{throw Error('INDEXNOW_PUBLIC_PAGE_NETWORK');}
    if(page.status!==200)throw Error('INDEXNOW_PUBLIC_PAGE_HTTP_'+page.status);
    if(!page.headers.get('content-type')?.toLowerCase().includes('text/html'))
      throw Error('INDEXNOW_PUBLIC_PAGE_NOT_HTML');
    const robots=page.headers.get('x-robots-tag')||'';
    if(/\\bnoindex\\b/i.test(robots))throw Error('INDEXNOW_PUBLIC_PAGE_NOINDEX');
    let html:string;
    try{html=await page.text();}catch{throw Error('INDEXNOW_PUBLIC_PAGE_BODY');}
    if(!html.includes('<link rel="canonical" href="'+url+'">'))
      throw Error('INDEXNOW_PUBLIC_PAGE_CANONICAL');
    if(/<meta\\b(?=[^>]*\\bname=["']robots["'])(?=[^>]*\\bcontent=["'][^"']*\\bnoindex\\b)[^>]*>/i.test(html))
      throw Error('INDEXNOW_PUBLIC_PAGE_NOINDEX');
    const guide=SEO_PAGES.find(p=>p.path===path);
    if(guide&&(!html.includes('<h1>'+guide.headline+'</h1>')||
        !html.includes('<title>'+guide.title+'</title>')))
      throw Error('INDEXNOW_PUBLIC_PAGE_STALE');
  }
}

export async function sendIndexNow(fetchImpl:FetchClient=fetch):Promise<'SUBMITTED'|'PENDING'>{
  await verifyLiveSeoReady(fetchImpl);
  // The public key and all 8 canonical pages were verified on live HTTPS.
  const payload=buildIndexNowPayload();
  let result:Response;
  try{
    result=await fetchImpl(INDEXNOW_ENDPOINT,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json; charset=utf-8'},
      body:JSON.stringify(payload)});
  }catch{throw Error('INDEXNOW_SUBMIT_NETWORK');}
  if(result.status===200)return 'SUBMITTED';
  if(result.status===202)return 'PENDING'; // New key still awaits verification; not indexed.
  throw Error('INDEXNOW_SUBMIT_HTTP_'+result.status);
}

export async function main(preflightOnly=false):Promise<void>{
  if(preflightOnly){
    await verifyLiveSeoReady();
    console.log('YANDEX_INDEXNOW_PREFLIGHT=PASS; public_urls='+INDEXNOW_UPDATED_PATHS.length+
      '; submitted=no');
    return;
  }
  const result=await sendIndexNow();
  console.log('YANDEX_INDEXNOW='+result+
    '; submitted_urls='+INDEXNOW_UPDATED_PATHS.length+
    '; target=yandex.com; indexation_guaranteed=no');
  if(result==='PENDING')throw Error('INDEXNOW_KEY_VERIFICATION_PENDING');
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const args=process.argv.slice(2);
  (args.length>0&&!(args.length===1&&args[0]==='--preflight')
    ?Promise.reject(Error('INDEXNOW_INVALID_ARGUMENT'))
    :main(args[0]==='--preflight')).catch(err=>{
    const code=err instanceof Error&&/^INDEXNOW_[A-Z0-9_]+$/.test(err.message)
      ?err.message:'INDEXNOW_UNEXPECTED_ERROR';
    console.error('YANDEX_INDEXNOW=FAILED; reason='+code);
    process.exitCode=1;
  });
}
