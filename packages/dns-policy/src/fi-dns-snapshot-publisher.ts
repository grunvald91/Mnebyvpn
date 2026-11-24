/** Private controller worker's single publication cycle. No public endpoint,
 * credential issuance, key discovery, service installation or automatic gate.
 * DB must be dedicated autocommit READ COMMITTED. Delivery must atomically
 * install only a verified increasing signed revision on the enrolled FI node.
 */
import type {KeyObject} from 'node:crypto';
import {signFiPersonalDnsSnapshot,type FiDnsGrant,type FiDnsSignedSnapshot} from './fi-personal-dns-signed-snapshot.ts';

export type FiSnapshotDatabase={query:(sql:string)=>Promise<{rows:{snapshot:unknown}[]}>};
export type FiSnapshotDelivery=(snapshot:FiDnsSignedSnapshot)=>Promise<void>;

export async function buildFiDnsSnapshot(db:FiSnapshotDatabase,key:KeyObject,
 clock:()=>number=Date.now):Promise<FiDnsSignedSnapshot>{
 const result=await db.query('SELECT public.fi_dns_snapshot_next() AS snapshot');
 const s=result.rows.length===1?result.rows[0]?.snapshot:undefined;
 if(s===null||typeof s!=='object'||Array.isArray(s)||
    Object.keys(s).length!==4||
    !['revision','issuedAt','validUntil','grants'].every(k=>Object.prototype.hasOwnProperty.call(s,k)))
   throw Error('Unexpected FI snapshot source');
 const {revision,issuedAt,validUntil,grants}=s as Record<string,unknown>;
 if(typeof revision!=='number'||typeof issuedAt!=='string'||typeof validUntil!=='string'||!Array.isArray(grants))
   throw Error('Invalid FI snapshot source');
 return signFiPersonalDnsSnapshot({revision,issuedAt,validUntil,grants:grants as FiDnsGrant[]},key,clock());
}
export async function publishFiDnsSnapshotOnce(db:FiSnapshotDatabase,key:KeyObject,
 deliver:FiSnapshotDelivery,clock:()=>number=Date.now):Promise<number>{
 const snapshot=await buildFiDnsSnapshot(db,key,clock);
 if(Date.parse(snapshot.validUntil)-clock()<30_000)
   throw Error('Insufficient FI snapshot lifetime for delivery');
 await deliver(snapshot);
 return snapshot.revision;
}
