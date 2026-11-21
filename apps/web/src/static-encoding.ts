/**
 * Representation negotiation for immutable, public CSS/JS buffers only.
 * Never run this on personalized HTML, API JSON or subscription responses.
 */
import {brotliCompressSync,constants,gzipSync} from 'node:zlib';

export type StaticEncoding='br'|'gzip';
type Representation={body:Buffer; encoding?:StaticEncoding; vary:boolean};
const compressed=new WeakMap<Buffer,Partial<Record<StaticEncoding,Buffer>>>();

function acceptQuality(header:string|undefined,encoding:StaticEncoding):number {
  if(!header)return 0;
  const values=new Map<string,number>();
  for(const entry of header.split(',')){
    const [name,...params]=entry.trim().toLowerCase().split(';');
    if(!name||values.has(name))continue;
    const qParam=params.map(p=>p.trim()).find(p=>p.startsWith('q='));
    if(!qParam){values.set(name,1);continue;}
    const raw=qParam.slice(2);
    // Invalid q-values must not accidentally enable a disabled codec.
    if(!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(raw)){
      values.set(name,0);continue;
    }
    values.set(name,Number(raw));
  }
  return values.get(encoding)??values.get('*')??0;
}

export function selectStaticRepresentation(
  data:Buffer,type:string,acceptEncoding:string|undefined,
):Representation {
  const vary=data.byteLength>=1024&&/^(?:text\/css|text\/javascript)(?:;|$)/.test(type);
  if(!vary)return {body:data,vary:false};
  const br=acceptQuality(acceptEncoding,'br');
  const gzip=acceptQuality(acceptEncoding,'gzip');
  const encoding:StaticEncoding|undefined=br>0&&br>=gzip?'br':gzip>0?'gzip':undefined;
  if(!encoding)return {body:data,vary:true};
  let cached=compressed.get(data);
  if(!cached){cached={};compressed.set(data,cached);}
  let body=cached[encoding];
  if(!body){
    body=encoding==='br'
      ?brotliCompressSync(data,{params:{[constants.BROTLI_PARAM_QUALITY]:4}})
      :gzipSync(data,{level:6});
    cached[encoding]=body;
  }
  if(body.byteLength>=data.byteLength)return {body:data,vary:true};
  return {body,encoding,vary:true};
}

/** Strong ETags must distinguish wire representations (RFC 9110). */
export function representationEtag(identityEtag:string,encoding:StaticEncoding|undefined):string {
  return encoding?identityEtag.slice(0,-1)+'-'+encoding+'"':identityEtag;
}
