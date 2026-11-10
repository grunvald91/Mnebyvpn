import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import type {ChunkQuota,TrustedEntitlement} from './postgres-chunk-quota.ts';

export type RelayStop =
  'peer-closed'|'quota-denied'|'revoked'|'lease-expired'|'db-failure'|
  'socket-failure'|'manual';

export interface MeteredRelayOptions {
  client:Socket;
  upstream:Socket;
  // This value MUST come from a trusted transport-level ingress lookup,
  // never from DNS hostname, client payload or source IP. The caller is
  // responsible for verifying destination ownership or proxy credentials.
  identity:TrustedEntitlement|null;
  quota:ChunkQuota;
  maxChunkBytes?:number;
  recheckMs?:number;
}
export interface RelayResult {
  stopReason:RelayStop;
  uploadBytes:number;
  downloadBytes:number;
  // These are bytes accepted by the receiving TCP socket's write callback,
  // NOT proof the peer received them; packet-capture E2E remains mandatory.
}

/**
 * No listener is created by this function. This only bridges sockets a
 * separate, trusted ingress has ALREADY accepted and attributed.
 *
 * Reserve each bounded chunk BEFORE calling Socket.write. Never forward
 * bytes on missing identity, failed DB, negative permit or stale revision.
 * Every successful write is settled exactly once under the reserved event ID.
 * Any ambiguous write/settlement failure leaves the database HOLD intact.
 */
export function runMeteredTcpRelay(o:MeteredRelayOptions):{
  done:Promise<RelayResult>;
  stop:(reason?:RelayStop)=>void;
}{
  const maxChunkBytes=o.maxChunkBytes??1024;
  const recheckMs=o.recheckMs??200;
  if(!Number.isSafeInteger(maxChunkBytes)||maxChunkBytes<1||maxChunkBytes>65536)
    throw new Error('Invalid maximum chunk bytes');
  if(!Number.isSafeInteger(recheckMs)||recheckMs<20||recheckMs>1000)
    throw new Error('Invalid entitlement recheck interval');
  let stopped=false;
  let stopReason:RelayStop='peer-closed';
  let uploadBytes=0;
  let downloadBytes=0;
  let checking=false;
  let timer:NodeJS.Timeout|undefined;

  const stop=(reason:RelayStop='manual')=>{
    if(stopped)return;
    stopped=true;
    stopReason=reason;
    if(timer)clearInterval(timer);
    // Fail closed for BOTH directions. Do not recycle uncertain held chunks.
    o.client.destroy();
    o.upstream.destroy();
  };
  const identity=o.identity;
  if(!identity||!identity.entitlementId||!identity.revision){
    stop('revoked');
    return {done:Promise.resolve({stopReason,uploadBytes,downloadBytes}),stop};
  }

  const alive=async()=>!stopped && await o.quota.active(identity);

  const pump=async(from:Socket,to:Socket,direction:'upload'|'download')=>{
    try {
      for await(const packet of from){
        const buf=Buffer.isBuffer(packet)?packet:Buffer.from(packet);
        for(let start=0;start<buf.length;start+=maxChunkBytes){
          if(stopped)return;
          const bytes=Math.min(maxChunkBytes,buf.length-start);
          if(!await alive()){stop('revoked');return;}
          const eventId=randomUUID();
          const permit=await o.quota.reserve(identity,eventId,bytes);
          if(!permit||permit.reservedBytes!==bytes||permit.revision!==identity.revision){
            stop('quota-denied');return;
          }
          const deadline=permit.allowedUntil.getTime();
          if(!Number.isFinite(deadline)||deadline<=Date.now()){
            stop('lease-expired');return;
          }
          // If status changed between reserve and send, do not forward. A
          // stranded hold is safer than an unsafe replay of prepaid bytes.
          if(!await alive()){stop('revoked');return;}
          if(stopped || Date.now()>=deadline){stop('lease-expired');return;}

          const piece=buf.subarray(start,start+bytes);
          await new Promise<void>((resolve,reject)=>{
            let finished=false;
            const settle=(err?:Error)=>{
              if(finished)return;
              finished=true;
              clearTimeout(watchdog);
              if(err)reject(err);else resolve();
            };
            const watchdog=setTimeout(
              ()=>settle(new Error('chunk write exceeded lease')),
              Math.max(1,deadline-Date.now()));
            to.write(piece,(err?:Error|null)=>settle(err??undefined));
          });
          // Never classify an uncertain write as "zero bytes": it may have
          // reached the peer. A failed settlement intentionally retains HOLD.
          const accounted=await o.quota.settle(
            identity,eventId,direction==='upload'?bytes:0,
            direction==='download'?bytes:0);
          if(!accounted){stop('db-failure');return;}
          if(direction==='upload')uploadBytes+=bytes;
          else downloadBytes+=bytes;
        }
      }
      stop('peer-closed');
    }catch{
      stop('socket-failure');
    }
  };

  o.client.once('error',()=>stop('socket-failure'));
  o.upstream.once('error',()=>stop('socket-failure'));
  o.client.once('close',()=>stop('peer-closed'));
  o.upstream.once('close',()=>stop('peer-closed'));

  timer=setInterval(()=>{
    if(stopped||checking)return;
    checking=true;
    void alive().then(allowed=>{
      if(!allowed)stop('revoked');
    }).catch(()=>stop('db-failure')).finally(()=>{
      checking=false;
    });
  },recheckMs);
  timer.unref();

  const done=Promise.allSettled([
    pump(o.client,o.upstream,'upload'),
    pump(o.upstream,o.client,'download'),
  ]).then(()=>({stopReason,uploadBytes,downloadBytes}));
  return {done,stop};
}
