/** One-shot, explicitly gated smoke for an isolated disposable canary.
 * Never queries a live entitlement database or touches public ingress.
 * Requires a local self-signed wildcard CA and fixture-only accounts.
 */
import {readFileSync} from 'node:fs';
import {connect as connectTls} from 'node:tls';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {dnsResponseMatchesQuestion} from '../../../packages/dns-policy/src/personal-dot-gateway-core.ts';

function env(k:string):string{
 const value=process.env[k];if(!value)throw Error('Missing isolated canary env: '+k);
 return value;
}
function question(name:string,id:number):Buffer{
 const head=Buffer.alloc(12);
 head.writeUInt16BE(id,0);head.writeUInt16BE(0x0100,2);head.writeUInt16BE(1,4);
 return Buffer.concat([head,...name.split('.').map(s=>
  Buffer.concat([Buffer.from([s.length]),Buffer.from(s)])),Buffer.from([0,0,1,0,1])]);
}
/** IPv4 answers only: per-client identity is the 12-character DoT name,
 * never an IPv6 address or a unique public IPv4 for each subscriber.
 * Ignore alias and CNAME records; require at least one actual A mapping.
 */
function ipv4Answers(reply:Buffer):string[]{
  if(reply.length<12)throw Error('DNS answer too short');
  const qd=reply.readUInt16BE(4),an=reply.readUInt16BE(6);
  if(qd!==1||an>128)throw Error('Unexpected DNS section counts');
  const skipName=(start:number):number=>{
    let pos=start;
    for(let i=0;i<128;i++){
      if(pos>=reply.length)throw Error('Truncated DNS RR name');
      const size=reply[pos++];
      if(size===0)return pos;
      if((size&0xc0)===0xc0){
        if(pos>=reply.length)throw Error('Truncated DNS RR compression');
        return pos+1;
      }
      if(size>63||pos+size>reply.length)throw Error('Bad DNS RR name');
      pos+=size;
    }
    throw Error('DNS RR name too long');
  };
  let pos=12;
  for(let i=0;i<qd;i++){
    pos=skipName(pos);
    if(pos+4>reply.length)throw Error('DNS question truncated');
    pos+=4;
  }
  const addresses:string[]=[];
  for(let i=0;i<an;i++){
    pos=skipName(pos);
    if(pos+10>reply.length)throw Error('DNS resource record truncated');
    const type=reply.readUInt16BE(pos);
    const dnsClass=reply.readUInt16BE(pos+2);
    const length=reply.readUInt16BE(pos+8);
    pos+=10;
    if(pos+length>reply.length)throw Error('DNS resource data truncated');
    if(type===1&&dnsClass===1&&length===4)
      addresses.push(Array.from(reply.subarray(pos,pos+4)).join('.'));
    pos+=length;
  }
  return [...new Set(addresses)];
}
async function ask(
 label:string,name:string,id:number,ca:Buffer,
):Promise<{rcode:number,ms:number,bytes:number,ipv4:string[]}>{
 const sent=question(name,id);
 const started=performance.now();
 return new Promise((resolve,reject)=>{
  let closed=false,received=Buffer.alloc(0);
  const socket=connectTls({host:'127.0.0.1',port:8853,
   servername:label+'.dns.mnebyvpn.site',
   ca,rejectUnauthorized:true,minVersion:'TLSv1.2'});
  const done=(error?:Error,answer?:Buffer)=>{
   if(closed)return;closed=true;
   clearTimeout(timer);socket.destroy();
   if(error)reject(error);
   else if(answer)resolve({rcode:answer.readUInt16BE(2)&15,
    ms:performance.now()-started,bytes:answer.length,
    ipv4:ipv4Answers(answer)});
   else reject(Error('No DNS reply'));
  };
  const timer=setTimeout(()=>done(Error('DoT canary timeout')),9500);
  socket.on('error',()=>done(Error('DoT canary TLS error')));
  socket.on('close',()=>done(Error('DoT canary closed without answer')));
  socket.on('secureConnect',()=>{
   if(!socket.authorized){done(Error('DoT peer certificate invalid'));return;}
   const frame=Buffer.alloc(sent.length+2);
   frame.writeUInt16BE(sent.length,0);sent.copy(frame,2);
   socket.write(frame);
  });
  socket.on('data',(chunk:Buffer)=>{
   received=Buffer.concat([received,chunk]);
   if(received.length<2)return;
   const n=received.readUInt16BE(0);
   if(n<17||n>16384){done(Error('Malformed DoT response length'));return;}
   if(received.length<n+2)return;
   const answer=Buffer.from(received.subarray(2,n+2));
   if(received.length!==n+2||!dnsResponseMatchesQuestion(sent,answer)){
    done(Error('DoT canary response mismatched original question'));return;
   }
   done(undefined,answer);
  });
 });
}
function percentile(values:number[],pct:number){
 const ordered=[...values].sort((a,b)=>a-b);
 return ordered[Math.max(0,Math.ceil(ordered.length*pct)-1)]!;
}
async function main():Promise<void>{
 if(process.env.MNEBYVPN_ENV!=='offline-test'||
    process.env.MNEBYDNS_CANARY_SMOKE_APPROVED!=='yes')
   throw Error('Isolated DoT canary smoke requires explicit offline-test approval');
 const ca=readFileSync(env('MNEBYDNS_CANARY_TLS_CERT_FILE'));
 const db=new Pool({connectionString:env('MNEBYDNS_CANARY_DATABASE_URL'),
  max:2,connectionTimeoutMillis:2000});
 const owner=env('MNEBYDNS_SMOKE_ACCOUNT_ID');
 const entitlement=env('MNEBYDNS_SMOKE_ENTITLEMENT_ID');
 const oldLabel='abcdefghijkl',newLabel='bcdefghijklm';
 const mappedIp=env('MNEBYDNS_CANARY_EXPECTED_MAPPED_IPV4');
 if(!/^(?:\\d{1,3}\\.){3}\\d{1,3}$/.test(mappedIp) ||
    mappedIp.split('.').some(part=>Number(part)>255))
   throw Error('Invalid expected canary mapped IPv4');
 const results:number[]=[];
 try{
  const direct=await ask(oldLabel,'example.org',0x4301,ca);
  if(direct.rcode!==0||direct.ipv4.length===0||direct.ipv4.includes(mappedIp))
   throw Error('Independent direct resolver failed or returned a mapped IP');
  console.info('CANARY_DIRECT_TLS_DNS=PASS ms='+direct.ms.toFixed(1));
  for(let i=0;i<2;i++){
   const mapped=await ask(oldLabel,'claude.ai',0x4400+i,ca);
   if(mapped.rcode!==0||!mapped.ipv4.includes(mappedIp))
     throw Error('Foreign CoreDNS did not return the expected mapped A record');
   results.push(mapped.ms);
  }
  const before=await db.query('SELECT used_queries FROM personal_dns_query_status($1)',[entitlement]);
  if(BigInt(before.rows[0]?.used_queries??-1)!==2n)
   throw Error('Premium query accounting mismatch before rotation');
  const rotated=await db.query(
   'SELECT rotate_personal_dns_credential($1,$2,$3,$4,$5) AS verdict',
   [owner,entitlement,1,newLabel,
    createHash('sha256').update(newLabel).digest('hex')]);
  if(rotated.rows[0]?.verdict!=='ROTATED')throw Error('Credential rotation failed');
  try{
   await ask(oldLabel,'example.org',0x4501,ca);
   throw Error('Old DNS hostname incorrectly survived rotation');
  }catch(error){
   if(error instanceof Error && error.message==='Old DNS hostname incorrectly survived rotation')
    throw error;
  }
  const newlyMapped=await ask(newLabel,'claude.ai',0x4502,ca);
  if(newlyMapped.rcode!==0||!newlyMapped.ipv4.includes(mappedIp))
   throw Error('New personal hostname cannot resolve expected mapped A record');
  results.push(newlyMapped.ms);
  const status=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
  if(BigInt(status.rows[0]?.used_queries??-1)!==3n ||
     BigInt(status.rows[0]?.remaining_queries??-1)!==0n ||
     BigInt(status.rows[0]?.credential_revision??-1)!==2n)
   throw Error('Rotation reset usage or premium quota accounting failed');
  const exhausted=await ask(newLabel,'claude.ai',0x4503,ca);
  if(exhausted.rcode!==0||exhausted.ipv4.length===0||
     exhausted.ipv4.includes(mappedIp))
    throw Error('Quota-exhausted request returned mapped IP or no origin address');
  const stable=await db.query('SELECT used_queries FROM personal_dns_query_status($1)',[entitlement]);
  if(BigInt(stable.rows[0]?.used_queries??-1)!==3n)
   throw Error('Quota exceeded after origin-only fallback');
  console.info('CANARY_EXPECTED_MAPPED_A=PASS count='+results.length);
  console.info('CANARY_DIRECT_IP_NOT_MAPPED=PASS');
  console.info('CANARY_ROTATION_OLD_DENIED_NEW_WORKS=PASS');
  console.info('CANARY_QUOTA_EXHAUSTED_DIRECT_ONLY=PASS');
  console.info('CANARY_LIVE_PREMIUM_RTT_P50_MS='+percentile(results,.5).toFixed(1));
  console.info('CANARY_LIVE_PREMIUM_RTT_P95_MS='+percentile(results,.95).toFixed(1));
  console.info('CANARY_ISOLATED_RU_TO_DE_SMOKE=PASS');
 }finally{await db.end();}
}
void main().catch(error=>{
 console.error('CANARY_ISOLATED_RU_TO_DE_SMOKE=FAIL '+(error instanceof Error?error.message:'unknown'));
 process.exitCode=1;
});
