import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import {
  chmodSync,lstatSync,readFileSync,rmSync,symlinkSync,writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
  initializeController,auditController,
  ControllerBootstrapError,requireExistingController188,
} from '../ops/trusted-controller-bootstrap.mjs';

function testRoot(){
  return '/root/mnebyvpn-bootstrap-test-'+randomBytes(8).toString('hex');
}
function withController(run){
  const root=testRoot();
  try{
    const initial=initializeController(root);
    return run(root,initial);
  }finally{rmSync(root,{recursive:true,force:true});}
}
const required=['controller-signing-key.pem','controller-public.spki',
  'fi-enrollment-ssh','fi-enrollment-ssh.pub','bootstrap-manifest.json'];

test('trusted bootstrap creates two distinct root-only private Ed25519 identities and cannot publish',()=>{
  withController((root,initial)=>{
    assert.equal(initial.state,'awaiting_independent_approval');
    assert.equal(initial.private_key_exported,false);
    assert.equal(initial.client_publication,false);
    assert.match(initial.controller_public_sha256,/^[a-f0-9]{64}$/);
    assert.equal(lstatSync(root).mode&0o077,0);
    for(const file of required){
      const st=lstatSync(join(root,file));
      assert.equal(st.uid,0);
      assert.equal(st.mode&0o077,0);
      assert(st.isFile());
    }
    const signer=readFileSync(join(root,'controller-signing-key.pem'),'utf8');
    const sshPrivate=readFileSync(join(root,'fi-enrollment-ssh'),'utf8');
    assert.match(signer,/BEGIN PRIVATE KEY/);
    assert.match(sshPrivate,/BEGIN OPENSSH PRIVATE KEY/);
    assert.notEqual(signer,sshPrivate);
    const audit=auditController(root);
    assert.equal(audit.controller_key_consistent,true);
    assert.equal(audit.controller_key_independently_pinned,false);
    assert.equal(audit.local_ssh_enrollment_material_ready,false);
    assert.equal(audit.database_inventory_approved,false);
    assert.equal(audit.enrollment_performed,false);
    assert.equal(audit.subscriber_publication,false);
    assert(!('DATABASE_URL' in initial));
  });
});

test('bootstrap is immutable and never silently rotates established identities',()=>{
  withController((root,initial)=>{
    const before=readFileSync(join(root,'controller-signing-key.pem'));
    assert.throws(()=>initializeController(root),ControllerBootstrapError);
    assert.deepEqual(readFileSync(join(root,'controller-signing-key.pem')),before);
    const wrong='f'.repeat(64);
    assert.notEqual(initial.controller_public_sha256,wrong);
    assert.throws(()=>auditController(root,{approvedControllerSha256:wrong}),
      /differs from independent Ed25519 pin/);
    const partial=auditController(root,{
      approvedControllerSha256:initial.controller_public_sha256,
    });
    assert.equal(partial.controller_key_independently_pinned,true);
    assert.equal(partial.local_ssh_enrollment_material_ready,false);
  });
});

test('independent SSH host fingerprint must match FI alias and exactly one Ed25519 line',()=>{
  withController((root,initial)=>{
    const publicLine=readFileSync(join(root,'fi-enrollment-ssh.pub'),'utf8').trim();
    const parts=publicLine.split(/\s+/);
    const hostLine='fi.mnebyvpn.site '+parts[0]+' '+parts[1]+'\n';
    const raw=Buffer.from(parts[1],'base64');
    const approvedFingerprint='SHA256:'+createHash('sha256').update(raw)
      .digest('base64').replace(/=+$/,'');
    writeFileSync(join(root,'fi-known_hosts'),hostLine,{mode:0o600,flag:'wx'});
    const checked=auditController(root,{
      approvedControllerSha256:initial.controller_public_sha256,
      approvedFiSshFingerprint:approvedFingerprint,
    });
    assert.equal(checked.fi_host_key_independently_pinned,true);
    assert.equal(checked.fi_node_identity_matched,false);
    assert.equal(checked.enrollment_performed,false);
    assert.throws(()=>auditController(root,{
      approvedControllerSha256:initial.controller_public_sha256,
      approvedFiSshFingerprint:'SHA256:'+'a'.repeat(43),
    }),/independent SSH fingerprint/);
    writeFileSync(join(root,'fi-known_hosts'),
      hostLine+hostLine,{mode:0o600});
    assert.throws(()=>auditController(root,{
      approvedFiSshFingerprint:approvedFingerprint,
    }),/one independently approved key/);
  });
});

test('review rejects tampered root-owned controller assets',()=>{
  withController((root,initial)=>{
    const name=join(root,'controller-public.spki');
    const bytes=readFileSync(name);
    writeFileSync(name,Buffer.alloc(bytes.length,0));
    assert.throws(()=>auditController(root),/does not match protected signer/);
  });
  withController((root)=>{
    const name=join(root,'controller-signing-key.pem');
    chmodSync(name,0o644);
    assert.throws(()=>auditController(root),/Unsafe root-only controller asset/);
  });
});

test('review refuses symlinks and unsafe ancestry',()=>{
  withController(root=>{
    const link=join(root,'fi-node-public.spki');
    symlinkSync('/etc/hosts',link);
    assert.throws(()=>auditController(root));
  });
  assert.throws(()=>initializeController('/tmp/new-mnebyvpn-controller'),
    /Untrusted controller directory or ancestor/);
  assert.throws(()=>initializeController('/root/../tmp/nope'),
    /Canonical absolute controller root/);
});

test('bootstrap test itself runs only as root on disposable CI host',()=>{
  assert.equal(process.getuid(),0);
});

test('production CLI trust boundary refuses FI, DE89 and an unknown controller',()=>{
  withController(root=>{
    for(const address of [['217.11.167.91'],['89.125.90.101'],['127.0.0.1']]){
      assert.throws(()=>requireExistingController188({
        addresses:address,deploymentRoot:root,
      }),/Only existing RU188 central controller/);
    }
    const valid=requireExistingController188({
      addresses:['127.0.0.1','188.120.254.223'],deploymentRoot:root,
    });
    assert.equal(valid.controller_host,'188.120.254.223');
    assert.equal(valid.existing_deployment_verified,true);
    assert.throws(()=>requireExistingController188({
      addresses:['188.120.254.223'],deploymentRoot:root+'/missing',
    }),/Existing MNEBYVPN controller deployment absent/);
  });
});
