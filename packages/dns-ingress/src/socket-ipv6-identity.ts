import {isIP} from 'node:net';
import type {Socket} from 'node:net';
import type {Pool} from 'pg';
import type {TrustedEntitlement} from './postgres-chunk-quota.ts';

/**
 * Identity is checked against the actual destination of the ACCEPTED TCP
 * socket. DNS query, SNI, Host, source IP, X-Forwarded-For and client-provided
 * strings are NEVER accepted as subscriber identity.
 *
 * This still needs a ROUTED per-subscriber IPv6 address in production.
 * A bind to ::1 only proves the local mechanism in CI.
 */
export async function identifyPaidDnsFromAcceptedSocket(
  socket:Socket,
  db:Pick<Pool,'query'>,
  timeoutMs=1500,
):Promise<TrustedEntitlement|null>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>5000)
    throw new Error('Invalid ingress identity lookup deadline');

  // IPv4-mapped socket addresses may be reported as IPv6 by Node.
  // Never mistake shared IPv4 transport for a unique per-subscriber IPv6.
  const destination=socket.localAddress;
  if(socket.destroyed || !destination || isIP(destination)!==6 ||
     /(?:^|:)ffff:/i.test(destination) ||
     destination.includes('%'))return null;

  let timer:NodeJS.Timeout|undefined;
  try {
    const res=await Promise.race([
      db.query(
        'SELECT entitlement_id,entitlement_revision FROM dns_ingress_identify_destination_ipv6($1::inet)',
        [destination],
      ),
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('identity lookup timeout')),timeoutMs);
      }),
    ]);
    if(socket.destroyed || res.rows.length!==1)return null;
    const row=res.rows[0];
    if(typeof row.entitlement_id!=='string' ||
       typeof row.entitlement_revision!=='string')return null;
    return {entitlementId:row.entitlement_id,
            revision:row.entitlement_revision};
  }catch{
    // No fallback to source IP, DNS cache, untrusted SNI or default account.
    return null;
  }finally{
    if(timer)clearTimeout(timer);
  }
}
