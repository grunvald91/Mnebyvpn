import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createIosDnsProfile,signIosDnsProfile,issueSignedIosDnsProfile,
} from '../packages/dns-policy/src/ios-signed-profile.ts';

const run=promisify(execFile);
const shared={
  identifier:'site.mnebyvpn.ios.sharedtest',
  displayName:'MNEBYDNS — тест & проверка',
  description:'Общий DNS, не личный доступ',
  target:{protocol:'TLS' as const,serverName:'dns.mnebyvpn.site'},
};

test('iOS DoT XML is well formed and correctly names only system encrypted DNS',()=>{
  const xml=createIosDnsProfile(shared).toString('utf8');
  assert.match(xml,/<string>com\.apple\.dnsSettings\.managed<\/string>/);
  assert.match(xml,/<key>DNSProtocol<\/key><string>TLS<\/string>/);
  assert.match(xml,/<key>ServerName<\/key><string>dns\.mnebyvpn\.site<\/string>/);
  assert.match(xml,/MNEBYDNS — тест &amp; проверка/);
  assert.doesNotMatch(xml,/VPNType|PayloadCertificate|PayloadType<\/key><string>com\.apple\.vpn/);
});

test('DoH profile includes only HTTPS and does not mint any authentication token',()=>{
  const xml=createIosDnsProfile({
    ...shared,target:{protocol:'HTTPS',
      serverUrl:'https://dns.mnebyvpn.site/dns-query/example-verified-token'},
  }).toString('utf8');
  assert.match(xml,/<key>ServerURL<\/key><string>https:\/\/dns\.mnebyvpn\.site\/dns-query\/example-verified-token<\/string>/);
  assert.match(xml,/<key>DNSProtocol<\/key><string>HTTPS<\/string>/);
  assert.doesNotMatch(xml,/<key>ServerName<\/key>/);
  for(const serverUrl of [
    'http://dns.mnebyvpn.site/dns-query/x',
    'https://user:pass@dns.mnebyvpn.site/dns-query/x',
    'https://dns.mnebyvpn.site:8443/dns-query/x',
    'https://dns.mnebyvpn.site/dns-query/x?token=secret',
    'https://dns.mnebyvpn.site/anything',
  ]){
    assert.throws(()=>createIosDnsProfile({...shared,target:{protocol:'HTTPS',serverUrl}}));
  }
});

test('Input validation prevents XML injection, user-info and malformed identifiers',()=>{
  assert.throws(()=>createIosDnsProfile({...shared,identifier:'../evil'}));
  assert.throws(()=>createIosDnsProfile({...shared,target:{protocol:'TLS',serverName:'1.1.1.1'}}));
  assert.throws(()=>createIosDnsProfile({...shared,target:{protocol:'TLS',serverName:'dns.local'}}));
  assert.throws(()=>createIosDnsProfile({...shared,description:'bad\u0001xml'}));
  const text=createIosDnsProfile({...shared,displayName:'MNEBYDNS <bad> & "quoted"'}).toString('utf8');
  assert.match(text,/MNEBYDNS &lt;bad&gt; &amp; &quot;quoted&quot;/);
});

test('CMS embedded DER signed profile verifies with a trusted test CA, tampering is rejected',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'mnebydns-cms-ci-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const rootKey=join(dir,'root.key'),rootCert=join(dir,'root.pem');
  const signerKey=join(dir,'signer.key'),csr=join(dir,'signer.csr');
  const signerCert=join(dir,'signer.pem'),ext=join(dir,'leaf.ext');
  await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2',
    '-keyout',rootKey,'-out',rootCert,'-subj','/CN=MNEBYDNS Temporary CI CA',
    '-addext','basicConstraints=critical,CA:TRUE',
    '-addext','keyUsage=critical,keyCertSign,cRLSign'],{timeout:20000});
  await run('openssl',['req','-newkey','rsa:2048','-nodes',
    '-keyout',signerKey,'-out',csr,'-subj','/CN=MNEBYDNS Temporary CI Signer'],
    {timeout:20000});
  await writeFile(ext,[
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=emailProtection',
  ].join('\n')+'\n');
  await run('openssl',['x509','-req','-in',csr,'-CA',rootCert,'-CAkey',rootKey,
    '-CAcreateserial','-days','2','-out',signerCert,'-extfile',ext],{timeout:20000});
  await chmod(signerKey,0o600);
  const identity={certificateFile:signerCert,privateKeyFile:signerKey,trustRootsFile:rootCert};
  const xml=createIosDnsProfile(shared);
  const signed=await signIosDnsProfile(xml,identity);
  assert.notEqual(signed.subarray(0,5).toString(),'<?xml');
  assert.equal(signed[0],0x30);
  const signedFile=join(dir,'signed.mobileconfig'),out=join(dir,'unwrapped.plist');
  await writeFile(signedFile,signed);
  await run('openssl',['cms','-verify','-binary','-inform','DER',
    '-in',signedFile,'-out',out,'-CAfile',rootCert],{timeout:15000});
  assert.deepEqual(await readFile(out),xml);
  // Exercise the operator's complete automated profile issuance path, too.
  const cliOut=join(dir,'operator-test.mobileconfig');
  const cliEnv={...process.env,
    MNEBYDNS_IOS_OUTPUT:cliOut,
    MNEBYDNS_SIGN_CERT_FILE:signerCert,
    MNEBYDNS_SIGN_KEY_FILE:signerKey,
    MNEBYDNS_SIGN_TRUST_ROOTS_FILE:rootCert,
    MNEBYDNS_SIGN_CHAIN_FILE:'',
    MNEBYDNS_VERIFIED_PERSONAL_DOH_URL:'',
    MNEBYDNS_PERSONAL_DOH_ISSUANCE_VERIFIED:'',
    MNEBYDNS_DNS_INGRESS_VERIFIED:'',
  };
  await run(process.execPath,['--experimental-strip-types',
    'scripts/issue-ios-dns-profile.ts'],{env:cliEnv,timeout:15000});
  const issued=await readFile(cliOut);
  assert.equal(issued[0],0x30);
  await writeFile(join(dir,'operator-checked.plist'),Buffer.alloc(0));
  await run('openssl',['cms','-verify','-binary','-inform','DER',
    '-in',cliOut,'-out',join(dir,'operator-checked.plist'),'-CAfile',rootCert],
    {timeout:15000});
  assert.match((await readFile(join(dir,'operator-checked.plist'))).toString('utf8'),
    /dns\.mnebyvpn\.site/);
  await assert.rejects(run(process.execPath,['--experimental-strip-types',
    'scripts/issue-ios-dns-profile.ts'],{env:cliEnv,timeout:15000}));
  const altered=Buffer.from(signed);
  altered[altered.length-15]^=1;
  await writeFile(signedFile,altered);
  await assert.rejects(run('openssl',['cms','-verify','-binary','-inform','DER',
    '-in',signedFile,'-out',out,'-CAfile',rootCert],{timeout:15000}));
  await chmod(signerKey,0o644);
  await assert.rejects(()=>issueSignedIosDnsProfile(shared,identity),/INSECURE_SIGNING_KEY_PERMISSIONS/);
  await chmod(signerKey,0o600);
  const junkTrust=join(dir,'fake-root.pem');
  await writeFile(junkTrust,'not a certificate\n');
  await assert.rejects(()=>signIosDnsProfile(xml,{...identity,trustRootsFile:junkTrust}),
    /PROFILE_SIGNING_FAILED/);
});
