#!/usr/bin/env node
/**
 * Offline-only isolated-controller image probe.
 * NEVER import client grants or activate a database listener/SSH command.
 * The Docker launcher MUST use --network none and mount NO secrets.
 */
import {networkInterfaces} from 'node:os';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function assertIsolatedRuntime({
  version=process.version,
  uid=process.getuid?.(),
  interfaces=networkInterfaces(),
  environment=process.env,
  protectedRootPresent=existsSync('/root/mnebyvpn-controller'),
}={}){
  if(version!=='v22.16.0')
    throw Error('Unreviewed Node runtime version');
  if(uid!==0)
    throw Error('Runtime preflight must have the dedicated root-only worker UID');
  if(Object.keys(interfaces).some(name=>name!=='lo'))
    throw Error('Network interface exposed to offline preflight');
  if(protectedRootPresent)
    throw Error('Private controller signing material mounted into preflight');
  for(const name of [
    'DATABASE_URL','MNEBYVPN_ENV','MNEBYVPN_FI_ENROLLMENT',
    'MNEBYVPN_AWG_DELIVERY_WORKER','AWG_CONTROLLER_SIGNING_KEY_FILE',
    'AWG_CONTROLLER_PUBLIC_SHA256','FI_ENROLL_SSH_KEY_FILE',
    'AWS_ACCESS_KEY_ID','GITHUB_TOKEN',
  ]){
    if(Object.hasOwn(environment,name))
      throw Error('Private controller environment leaked into offline preflight');
  }
}

export async function verifyModules(){
  // Imports are deliberately side-effect-free; no main() is invoked.
  const modules=[
    '../../apps/service/src/fi-enrollment-controller.ts',
    '../../apps/service/src/awg-controller-delivery-worker.ts',
  ];
  for(const path of modules)
    await import(new URL(path,import.meta.url).href);
  const sql=await import('pg');
  if(typeof sql.Pool!=='function')
    throw Error('Verified PostgreSQL driver missing in isolated image');
  const ssh=spawnSync('/usr/bin/ssh',['-V'],{
    encoding:'utf8',timeout:2500,maxBuffer:1000,
  });
  if(ssh.error||ssh.status!==0)
    throw Error('Required OpenSSH client missing from isolated image');
  return {controller_imports_verified:true,pg_driver_verified:true,
          openssh_client_verified:true};
}

async function main(){
  assertIsolatedRuntime();
  const checked=await verifyModules();
  process.stdout.write(JSON.stringify({
    ...checked,controller_host:'188.120.254.223',
    runtime:'isolated_offline_canary',
    network_access:false,
    signing_keys_mounted:false,
    fi_enrollment_performed:false,
    awg_delivery_worker_started:false,
    subscriber_publication:false,
  })+'\n');
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)
  main().catch(()=>{
    process.stderr.write('CONTROLLER188_OFFLINE_RUNTIME_STOPPED\n');
    process.exitCode=2;
  });
