import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import type {ChunkQuota,TrustedEntitlement} from './postgres-chunk-quota.ts';

export type RelayStop =
  'peer-closed'|'quota-denied'|'revoked'|'lease-expired'|'db-failure'|
  'socket-failure'|'manual';
export interface MeteredRelayOptions {
  client:Socket;
  upstream:Socket;
  // A separate authenticated ingress MUST establish this identity from
  // transport-level routing/credentials; DoT hostname alone is insufficient.
  identity:TrustedEntitlement|null;
  quota:ChunkQuota;
  maxChunkBytes?:number;
  recheckMs?:number;
  quotaTimeoutMs?:number;
}
export interface RelayResult {
  stopReason:RelayStop;
  uploadBytes:number;
  downloadBytes:number;
  // Counts bytes accepted by Socket.write, NOT confirmed remote delivery.
}

class QuotaDatabaseUnavailable extends Error {}
async function quotaCall<T>(fn:()=>Promise<T>,timeoutMs:number):Promise<T>{
  let timeout:NodeJS.Timeout|undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_,reject)=>{
        timeout=setTimeout(
          ()=>reject(new Error('quota operation exceeded deadline')),timeoutMs);
      }),
    ]);
  }catch{
    throw new QuotaDatabaseUnavailable('quota backend unavailable');
  }finally{
    if(timeout)clearTimeout(timeout);
  }
}

/**
 * An OFFLINE transport bridge for two ALREADY established trusted TCP sockets.
 * The creator MUST use allowHalfOpen:true for BOTH sockets; otherwise a
 * normal client FIN can implicitly close its response path.
 * No public listener is opened here; no DNS authentication is invented.
 *
 * Each payload fragment is preauthorised before Socket.write; settlement is
 * attempted even if a stop occurs during a previously submitted write.
 * A failed/ambiguous settlement retains HELD bytes rather than inventing
 * "zero delivered" usage.
 */
export function runMeteredTcpRelay(o:MeteredRelayOptions):{
  done:Promise<RelayResult>;
  stop:(reason?:RelayStop)=>void;
}{
  const maxChunkBytes=o.maxChunkBytes??65536;
  const recheckMs=o.recheckMs??1000;
  const quotaTimeoutMs=o.quotaTimeoutMs??1500;
  if(!Number.isSafeInteger(maxChunkBytes)||maxChunkBytes<1||maxChunkBytes>65536)
    throw new Error('Invalid maximum chunk bytes');
  if(!Number.isSafeInteger(recheckMs)||recheckMs<20||recheckMs>1000)
    throw new Error('Invalid entitlement recheck interval');
  if(!Number.isSafeInteger(quotaTimeoutMs)||quotaTimeoutMs<50||quotaTimeoutMs>5000)
    throw new Error('Invalid quota deadline');
  if(!o.client.allowHalfOpen || !o.upstream.allowHalfOpen)
    throw new Error('Metered relay requires allowHalfOpen TCP sockets');

  let stopped=false;
  let stopReason:RelayStop='peer-closed';
  let uploadBytes=0, downloadBytes=0;
  let checking=false;
  let timer:NodeJS.Timeout|undefined;
  const stop=(reason:RelayStop='manual')=>{
    if(stopped)return;
    stopped=true;
    stopReason=reason;
    if(timer)clearInterval(timer);
    o.client.destroy();
    o.upstream.destroy();
  };
  const identity=o.identity;
  if(!identity||!identity.entitlementId||!identity.revision){
    stop('revoked');
    return {done:Promise.resolve({stopReason,uploadBytes,downloadBytes}),stop};
  }
  const alive=async()=>!stopped &&
    await quotaCall(()=>o.quota.active(identity),quotaTimeoutMs);

  const pump=async(from:Socket,to:Socket,direction:'upload'|'download')=>{
    try {
      // Node's default stream async iterator DESTROYS the socket on EOF,
      // even with allowHalfOpen:true. Disable iterator-owned destruction so
      // a client FIN can still be followed by a delayed upstream response.
      for await(const packet of from.iterator({destroyOnReturn:false})){
        const buf=Buffer.isBuffer(packet)?packet:Buffer.from(packet);
        for(let start=0;start<buf.length;start+=maxChunkBytes){
          if(stopped)return;
          const bytes=Math.min(maxChunkBytes,buf.length-start);
          if(!await alive()){stop('revoked');return;}
          const eventId=randomUUID();
          const permit=await quotaCall(
            ()=>o.quota.reserve(identity,eventId,bytes),quotaTimeoutMs);
          if(!permit||permit.reservedBytes!==bytes||permit.revision!==identity.revision){
            stop('quota-denied');return;
          }
          const deadline=permit.allowedUntil.getTime();
          if(!Number.isFinite(deadline)||deadline<=Date.now()){
            stop('lease-expired');return;
          }
          if(stopped || Date.now()>=deadline){stop('lease-expired');return;}
          // Sending bytes from this moment is committed; a subsequent stop
          // must never treat this chunk as untransmitted.
          const piece=buf.subarray(start,start+bytes);
          try {
            await new Promise<void>((resolve,reject)=>{
              let finished=false;
              const complete=(error?:Error)=>{
                if(finished)return;
                finished=true;
                clearTimeout(watchdog);
                if(error)reject(error);else resolve();
              };
              const writeDeadline=Math.max(1,Math.min(quotaTimeoutMs,deadline-Date.now()));
              const watchdog=setTimeout(
                ()=>complete(new Error('TCP write did not finish in time')),
                writeDeadline);
              if(stopped){complete(new Error('relay closed'));return;}
              to.write(piece,(err?:Error|null)=>complete(err??undefined));
            });
          }catch(error){
            // A timed-out callback might have already placed bytes on wire.
            // Leave the reservation HELD for later audited recovery.
            stop('socket-failure');
            return;
          }

          // Even if a different direction just closed, this write may have
          // succeeded. Attempt settlement once before stopping.
          const accounted=await quotaCall(
            ()=>o.quota.settle(identity,eventId,
              direction==='upload'?bytes:0,direction==='download'?bytes:0),
            quotaTimeoutMs);
          if(!accounted){stop('db-failure');return;}
          if(direction==='upload')uploadBytes+=bytes;
          else downloadBytes+=bytes;
          if(stopped)return;
        }
      }

      // A normal TCP FIN is a HALF-CLOSE, not an error. The other read
      // direction may still be receiving a response and must be drained.
      if(!stopped && !to.destroyed)to.end();
    }catch(error){
      stop(error instanceof QuotaDatabaseUnavailable?'db-failure':'socket-failure');
    }
  };

  o.client.on('error',()=>stop('socket-failure'));
  o.upstream.on('error',()=>stop('socket-failure'));
  o.client.on('close',hadError=>{
    if(hadError || !o.client.readableEnded)stop('socket-failure');
  });
  o.upstream.on('close',hadError=>{
    if(hadError || !o.upstream.readableEnded)stop('socket-failure');
  });

  timer=setInterval(()=>{
    if(stopped||checking)return;
    checking=true;
    void alive().then(allowed=>{
      if(!allowed)stop('revoked');
    }).catch(()=>stop('db-failure')).finally(()=>{checking=false;});
  },recheckMs);
  timer.unref();

  const done=Promise.allSettled([
    pump(o.client,o.upstream,'upload'),
    pump(o.upstream,o.client,'download'),
  ]).then(()=>{
    if(timer)clearInterval(timer);
    return {stopReason,uploadBytes,downloadBytes};
  });
  return {done,stop};
}
