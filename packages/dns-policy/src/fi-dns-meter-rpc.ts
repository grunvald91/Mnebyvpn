/** Private FI meter RPC, independent from the VPN admission protocol.
 * No public listener, keys on disk, or implicit grant. The caller provides an
 * independently pinned enrolled node and a controller-only SQL connection.
 */
import {createHash,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';

export type MeterOperation='reserve'|'settle'|'release';
export type MeterRequest={
 version:1;nodeId:'fi-test-01';countryCode:'FI';op:MeterOperation;
 requestId:string;tokenSha256:string|null;issuedAt:string;nonce:string;
};
export type SignedMeterRequest=MeterRequest&{signature:string};
export type MeterDecision={version:1;requestSha256:string;result:string;decidedAt:string};
export type SignedMeterDecision=MeterDecision&{signature:string};
export type PinnedMeterKey={spki:string;sha256:string};
export type MeterDatabase={query:(sql:string,values:unknown[])=>Promise<{rows:{result:unknown}[]}>};

const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const REQ=['version','nodeId','countryCode','op','requestId','tokenSha256','issuedAt','nonce'] as const;
const DEC=['version','requestSha256','result','decidedAt'] as const;
const DENIALS=new Set(['DENY_INVALID','DENY_NODE','DENY_REPLAY','DENY_DISABLED','DENY_UNKNOWN','DENY_DUPLICATE','DENY_INACTIVE','DENY_QUOTA']);
function exact(v:unknown,keys:readonly string[]):v is Record<string,unknown>{
 return v!==null&&typeof v==='object'&&!Array.isArray(v)&&
 Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
}
function hash(v:unknown):v is string{return typeof v==='string'&&v.length===64&&HEX.test(v);}
function fresh(v:unknown,now:number):boolean{
 if(typeof v!=='string'||!TIME.test(v)||!Number.isSafeInteger(now))return false;
 const t=Date.parse(v);
 return Number.isFinite(t)&&new Date(t).toISOString()===v&&Math.abs(now-t)<=15_000;
}
function pub(pin:PinnedMeterKey):KeyObject{
 if(typeof pin.spki!=='string'||pin.spki.length!==59||!/^[A-Za-z0-9_-]{59}$/.test(pin.spki)||!hash(pin.sha256))throw Error('Invalid meter key pin');
 const der=Buffer.from(pin.spki,'base64url');
 if(der.length!==44||der.toString('base64url')!==pin.spki||
 !der.subarray(0,12).equals(Buffer.from('302a300506032b6570032100','hex'))||
 createHash('sha256').update(der).digest('hex')!==pin.sha256)throw Error('Untrusted meter key');
 return createPublicKey({key:der,format:'der',type:'spki'});
}
function sig(s:unknown):Buffer{
 if(typeof s!=='string'||s.length!==86||!/^[A-Za-z0-9_-]{86}$/.test(s))throw Error('Invalid meter signature');
 const raw=Buffer.from(s,'base64url');
 if(raw.length!==64||raw.toString('base64url')!==s)throw Error('Noncanonical meter signature');
 return raw;
}
function signer(key:KeyObject):void{
 if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 signer required');
}
function request(v:unknown,now:number):MeterRequest{
 if(!exact(v,REQ)||v.version!==1||v.nodeId!=='fi-test-01'||v.countryCode!=='FI'||
 (v.op!=='reserve'&&v.op!=='settle'&&v.op!=='release')||
 typeof v.requestId!=='string'||v.requestId.length!==36||!UUID.test(v.requestId)||
 (v.op==='reserve'?!hash(v.tokenSha256):v.tokenSha256!==null)||
 !hash(v.nonce)||v.nonce==='0'.repeat(64)||!fresh(v.issuedAt,now))throw Error('Invalid FI meter request');
 return v as MeterRequest;
}
function reqBytes(r:MeterRequest):Buffer{
 return Buffer.from(JSON.stringify(['MNEBYVPN_FI_DNS_METER_REQUEST_V1',r.version,r.nodeId,r.countryCode,
 r.op,r.requestId,r.tokenSha256,r.issuedAt,r.nonce]),'utf8');
}
function reqHash(r:MeterRequest):string{return createHash('sha256').update(reqBytes(r)).digest('hex');}
function decBytes(d:MeterDecision):Buffer{
 return Buffer.from(JSON.stringify(['MNEBYVPN_FI_DNS_METER_DECISION_V1',d.version,d.requestSha256,d.result,d.decidedAt]),'utf8');
}
function validResult(op:MeterOperation,result:unknown):result is string{
 return typeof result==='string'&&(DENIALS.has(result)||
 (op==='reserve'&&result==='RESERVED')||
 (op!=='reserve'&&(result==='SETTLED'||result==='RELEASED')));
}
export function signFiMeterRequest(r:MeterRequest,key:KeyObject,now=Date.now()):SignedMeterRequest{
 const v=request(r,now);signer(key);
 return {...v,signature:sign(null,reqBytes(v),key).toString('base64url')};
}
export function verifyFiMeterRequest(v:unknown,pin:PinnedMeterKey,now=Date.now()):MeterRequest{
 if(!exact(v,[...REQ,'signature']))throw Error('Unexpected FI meter envelope');
 const {signature,...body}=v;
 const r=request(body,now);
 if(!verify(null,reqBytes(r),pub(pin),sig(signature)))throw Error('Untrusted FI meter request');
 return r;
}
export function verifyFiMeterDecision(v:unknown,r:MeterRequest,pin:PinnedMeterKey,now=Date.now()):MeterDecision{
 request(r,now);
 if(!exact(v,[...DEC,'signature']))throw Error('Unexpected meter decision envelope');
 const {signature,...d}=v;
 if(d.version!==1||d.requestSha256!==reqHash(r)||!fresh(d.decidedAt,now)||
 !validResult(r.op,d.result))throw Error('Unbound meter decision');
 const body=d as MeterDecision;
 if(!verify(null,decBytes(body),pub(pin),sig(signature)))throw Error('Untrusted meter decision');
 return body;
}
/** Called only by the isolated controller, never public web/bot.
 * The DB independently fences stale timestamps, enrolled pins and nonces.
 * Unknown DB results or SQL failure must not produce a positive decision.
 */
export async function handleFiMeterRequest(input:unknown,node:PinnedMeterKey,
 controller:KeyObject,db:MeterDatabase,clock:()=>number=Date.now):Promise<SignedMeterDecision>{
 signer(controller);
 const r=verifyFiMeterRequest(input,node,clock());
 const reply=await db.query(
 'SELECT public.fi_dns_meter_verified_apply($1,$2::uuid,$3,$4,$5,$6::timestamptz) AS result',
 [r.op,r.requestId,r.tokenSha256,node.sha256,r.nonce,r.issuedAt]);
 const result=reply.rows.length===1?reply.rows[0]?.result:undefined;
 if(!validResult(r.op,result))throw Error('Unrecognized meter database decision');
 const now=clock();
 if(!fresh(r.issuedAt,now))throw Error('Meter decision exceeded request validity');
 const d:MeterDecision={version:1,requestSha256:reqHash(r),result,decidedAt:new Date(now).toISOString()};
 return {...d,signature:sign(null,decBytes(d),controller).toString('base64url')};
}
