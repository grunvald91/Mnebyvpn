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

export async function sendIndexNow(fetchImpl:FetchClient=fetch):Promise<'SUBMITTED'|'PENDING'>{
  let proof:Response;
  try{
    proof=await fetchImpl(INDEXNOW_KEY_LOCATION,{method:'GET',redirect:'error',
      signal:AbortSignal.timeout(12000)});
  }catch{throw Error('INDEXNOW_PROOF_NETWORK');}
  if(proof.status!==200)throw Error('INDEXNOW_PROOF_HTTP_'+proof.status);
  let content:string;
  try{content=await proof.text();}catch{throw Error('INDEXNOW_PROOF_BODY');}
  if(content.trim()!==YANDEX_INDEXNOW_KEY)throw Error('INDEXNOW_PROOF_MISMATCH');
  // Notify only after public root key is actually deployed and serves correct text.
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

export async function main():Promise<void>{
  const result=await sendIndexNow();
  console.log('YANDEX_INDEXNOW='+result+
    '; submitted_urls='+INDEXNOW_UPDATED_PATHS.length+
    '; target=yandex.com; indexation_guaranteed=no');
  if(result==='PENDING')console.log('YANDEX_INDEXNOW_VERIFICATION_PENDING=true');
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  main().catch(err=>{
    const code=err instanceof Error&&/^INDEXNOW_[A-Z0-9_]+$/.test(err.message)
      ?err.message:'INDEXNOW_UNEXPECTED_ERROR';
    console.error('YANDEX_INDEXNOW=FAILED; reason='+code);
    process.exitCode=1;
  });
}
