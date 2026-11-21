/** Only public, immutable-at-process-boot buffers are eligible for caching. */
import {createHash} from 'node:crypto';

const fingerprints=new WeakMap<Buffer,string>();

export function publicEtag(bytes: Buffer): string {
  let etag=fingerprints.get(bytes);
  if(!etag){
    etag='"'+createHash('sha256').update(bytes).digest('hex')+'"';
    fingerprints.set(bytes,etag);
  }
  return etag;
}

/** If-None-Match uses weak comparison for safe GET and HEAD responses. */
export function matchesPublicEtag(
  method: string|undefined, header: string|string[]|undefined, etag: string,
): boolean {
  if(method!=='GET'&&method!=='HEAD')return false;
  if(typeof header!=='string')return false;
  return header.split(',').some(part=>{
    const item=part.trim();
    return item==='*'||item===etag||item==='W/'+etag;
  });
}
