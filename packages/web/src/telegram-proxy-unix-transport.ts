/** Private Telemt HTTP transport over a filesystem-restricted SSH UDS.
 * NO TCP admin listener on the billing controller. Only the local worker
 * service UID can open the UNIX socket. The remote Telemt API remains
 * bound to 127.0.0.1 on the foreign host.
 */
import {request} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
export const OWNER_TELEMT_SSH_SOCKET='/run/mnebyvpn-owner-mtproxy/telemt.sock';
const ALLOWED_API='http://127.0.0.1:9096';
const MAX=65536;
export function createTelemtUnixTransport(socketPath:string):typeof fetch{
  if(typeof socketPath!=='string'||!socketPath.startsWith('/')||
     socketPath.length>100||socketPath.includes('\0')||socketPath.includes('..'))
    throw Error('Invalid local Telemt socket');
  return (async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
    if(typeof input!=='string')throw Error('Telemt unix transport accepts only local string URL');
    const url=new URL(input);
    if(url.origin!==ALLOWED_API||!url.pathname.startsWith('/v1/')||
       url.search||url.hash||url.username||url.password)
      throw Error('Unexpected Telemt destination');
    const method=init?.method??'GET';
    if(!['GET','POST','PATCH'].includes(method))throw Error('Unexpected Telemt method');
    const data=typeof init?.body==='string'?init.body:undefined;
    if(init?.body!==undefined&&data===undefined)throw Error('Unexpected Telemt request body');
    if(data!==undefined&&Buffer.byteLength(data,'utf8')>MAX)
      throw Error('Telemt request too large');
    const headers:Record<string,string>={};
    const h=new Headers(init?.headers);
    for(const [name,val] of h.entries())headers[name]=val;
    return new Promise<Response>((resolve,reject)=>{
      const req=request({
        socketPath,path:url.pathname,method,headers,signal:init?.signal??undefined,
        timeout:8000,
      },res=>{
        const chunks:Buffer[]=[];
        let len=0;
        res.on('data',(raw:Buffer)=>{
          const chunk=Buffer.from(raw);
          len+=chunk.length;
          if(len>MAX){
            res.destroy(Error('Oversized Telemt response'));return;
          }
          chunks.push(chunk);
        });
        res.once('error',reject);
        res.once('end',()=>{
          const status=res.statusCode??502;
          // All API responses consumed by TelemtAdminClient are JSON; 404/409
          // are intentionally allowed to have empty bodies.
          if(status<200||status>=500||status===204||status>=300&&status<400){
            reject(Error('Invalid Telemt HTTP response'));return;
          }
          resolve(new Response(Buffer.concat(chunks),{
            status,
            headers:res.headers as IncomingHttpHeaders as HeadersInit,
          }));
        });
      });
      req.once('error',reject);
      req.once('timeout',()=>req.destroy(Error('Telemt admin timeout')));
      req.end(data);
    });
  }) as typeof fetch;
}
