/**
 * MNEBYDNS iOS configuration profile creator + CMS SignedData signer.
 *
 * No certificate/key/private DNS token is embedded into repository artifacts.
 * The caller supplies a server-verified DNS endpoint and a stable identifier.
 * Produces a DER CMS opaque signed .mobileconfig, NOT an MDM enrollment.
 */
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,stat,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';

const run=promisify(execFile);
const dnsName=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const profileId=/^[a-z][a-z0-9.-]{5,150}$/;
const xml=(s:string):string=>{
  if(s.length>1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))
    throw Error('INVALID_PROFILE_TEXT');
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
};

export type IosDnsTarget=
  |{protocol:'TLS';serverName:string}
  |{protocol:'HTTPS';serverUrl:string};

export interface IosDnsProfileOptions{
  identifier:string;displayName:string;description:string;target:IosDnsTarget;
}

export function createIosDnsProfile(options:IosDnsProfileOptions):Buffer{
  if(!profileId.test(options.identifier)||options.identifier.endsWith('.'))
    throw Error('INVALID_PROFILE_IDENTIFIER');
  if(options.displayName.length<1||options.description.length<1)
    throw Error('INVALID_PROFILE_TEXT');
  let targetXml:string;
  if(options.target.protocol==='TLS'){
    const name=options.target.serverName;
    if(name!==name.toLowerCase()||name.length>253||!dnsName.test(name))
      throw Error('INVALID_DOT_HOSTNAME');
    targetXml='<key>ServerName</key><string>'+xml(name)+'</string>';
  }else{
    let url:URL;
    try{url=new URL(options.target.serverUrl);}catch{throw Error('INVALID_DOH_URL');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||
       url.search||!dnsName.test(url.hostname)||url.hostname!==url.hostname.toLowerCase()||
       !url.pathname.startsWith('/dns-query/'))
      throw Error('INVALID_DOH_URL');
    // A token-bearing DoH URI MUST come from a trusted entitlement issuer,
    // never user input. The signing utility does not create/authorize a token.
    targetXml='<key>ServerURL</key><string>'+xml(url.toString())+'</string>';
  }
  const uuid1=randomUUID().toUpperCase(),uuid2=randomUUID().toUpperCase();
  const name=xml(options.displayName),description=xml(options.description);
  const protocol=options.target.protocol;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>${options.identifier}</string>
<key>PayloadUUID</key><string>${uuid1}</string>
<key>PayloadDisplayName</key><string>${name}</string>
<key>PayloadDescription</key><string>${description}</string>
<key>PayloadOrganization</key><string>MNEBYDNS</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>${options.identifier}.dns</string>
<key>PayloadUUID</key><string>${uuid2}</string>
<key>PayloadDisplayName</key><string>${name}</string>
<key>DNSSettings</key><dict>
<key>DNSProtocol</key><string>${protocol}</string>
${targetXml}
</dict></dict></array>
</dict></plist>
`,'utf8');
}

export interface IosProfileSigner{
  certificateFile:string;privateKeyFile:string;trustRootsFile:string;
  intermediateChainFile?:string;
}

function safeFilePath(p:string):boolean{
  return typeof p==='string'&&isAbsolute(p)&&p.length<1024&&!/[\r\n\0]/.test(p);
}

/**
 * Sign an already constructed profile using a non-exported server-side key,
 * verify CMS integrity AND chain with OpenSSL, and fail closed otherwise.
 * Trusting this chain in OpenSSL does NOT prove iOS trusts its root.
 */
export async function signIosDnsProfile(
  profile:Buffer,identity:IosProfileSigner,
):Promise<Buffer>{
  if(!Buffer.isBuffer(profile)||profile.length<300||profile.length>65536)
    throw Error('INVALID_PROFILE_SIZE');
  if(![identity.certificateFile,identity.privateKeyFile,identity.trustRootsFile,
       ...(identity.intermediateChainFile?[identity.intermediateChainFile]:[])]
      .every(safeFilePath))throw Error('INVALID_SIGNING_CONFIGURATION');
  const keyInfo=await stat(identity.privateKeyFile).catch(()=>null);
  if(!keyInfo?.isFile()||(keyInfo.mode&0o077)!==0)
    throw Error('INSECURE_SIGNING_KEY_PERMISSIONS');
  const dir=await mkdtemp(join(tmpdir(),'mnebydns-ios-'));
  try{
    await chmod(dir,0o700);
    const unsigned=join(dir,'input.plist'),signed=join(dir,'signed.der'),
      extracted=join(dir,'checked.plist');
    await writeFile(unsigned,profile,{mode:0o600});
    const args=['cms','-sign','-binary','-nodetach','-md','sha256',
      '-in',unsigned,'-out',signed,'-outform','DER',
      '-signer',identity.certificateFile,'-inkey',identity.privateKeyFile];
    if(identity.intermediateChainFile)
      args.push('-certfile',identity.intermediateChainFile);
    await run('openssl',args,{timeout:15000,maxBuffer:64*1024});
    await run('openssl',['cms','-verify','-binary','-inform','DER',
      '-in',signed,'-out',extracted,'-CAfile',identity.trustRootsFile],
      {timeout:15000,maxBuffer:64*1024});
    const verified=await readFile(extracted);
    if(!verified.equals(profile))throw Error('PROFILE_INTEGRITY_MISMATCH');
    const result=await readFile(signed);
    if(result.length>262144)throw Error('SIGNED_PROFILE_TOO_LARGE');
    return result;
  }catch{
    // Never return or log OpenSSL stderr (might reveal internal key paths).
    throw Error('PROFILE_SIGNING_FAILED');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
}

export async function issueSignedIosDnsProfile(
  options:IosDnsProfileOptions,identity:IosProfileSigner,
):Promise<Buffer>{
  return signIosDnsProfile(createIosDnsProfile(options),identity);
}
