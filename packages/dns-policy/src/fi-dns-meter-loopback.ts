/** Private length-framed RPC listener. Bind only IPv4 loopback; external
 * connectivity must use a separately pinned, restricted private SSH tunnel.
 * Caller must supply handleFiMeterRequest with trusted keys and scoped DB.
 * No public route, service install, or production configuration is implied.
 */
import {createServer,type Server} from 'node:net';
import {TextDecoder} from 'node:util';

export const FI_METER_MAX_FRAME=4096;
const MAX_ACTIVE=32;
const DEADLINE_MS=2500;
type Handler=(request:unknown)=>Promise<unknown>;

export async function startFiMeterLoopbackServer(port:number,handler:Handler):Promise<Server>{
 if(!Number.isInteger(port)||(port!==0&&(port<1024||port>65535))||typeof handler!=='function')
  throw Error('Invalid private FI meter listener configuration');
 let active=0;
 const server=createServer(socket=>{
  if(active>=MAX_ACTIVE){socket.destroy();return;}
  active++;
  let closed=false,working=false,freed=false,handled=false;
  const free=()=>{
   if(closed&&!working&&!freed){freed=true;active--;}
  };
  const deadline=setTimeout(()=>socket.destroy(),DEADLINE_MS);
  socket.setNoDelay(true);
  socket.on('error',()=>socket.destroy());
  socket.once('close',()=>{clearTimeout(deadline);closed=true;free();});
  let buffered=Buffer.alloc(0),size:number|undefined;
  socket.on('data',chunk=>{
   if(handled||buffered.length+chunk.length>FI_METER_MAX_FRAME+4){socket.destroy();return;}
   buffered=Buffer.concat([buffered,chunk]);
   if(size===undefined&&buffered.length>=4){
    size=buffered.readUInt32BE(0);
    if(size<1||size>FI_METER_MAX_FRAME){socket.destroy();return;}
   }
   if(size===undefined||buffered.length<size+4)return;
   if(buffered.length!==size+4){socket.destroy();return;}
   handled=true;
   socket.pause();
   const body=buffered.subarray(4);
   buffered=Buffer.alloc(0);
   working=true;
   void (async()=>{
    try{
     const request:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
     // Exact compact JSON emitted by FI; rejects duplicate keys, extra
     // whitespace and ambiguous encoding before cryptographic verification.
     if(!Buffer.from(JSON.stringify(request),'utf8').equals(body))throw Error('Noncanonical RPC frame');
     const decision=await handler(request);
     const wire=Buffer.from(JSON.stringify(decision),'utf8');
     if(wire.length<1||wire.length>FI_METER_MAX_FRAME)throw Error('Invalid RPC result size');
     if(!socket.destroyed){
      const prefix=Buffer.alloc(4);prefix.writeUInt32BE(wire.length);
      socket.end(Buffer.concat([prefix,wire]));
     }
    }catch{socket.destroy();}
    finally{working=false;free();}
   })();
  });
 });
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);
  server.listen({host:'127.0.0.1',port,exclusive:true},()=>{
   server.off('error',reject);resolve();
  });
 });
 return server;
}
