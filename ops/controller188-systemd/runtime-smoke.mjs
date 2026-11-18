#!/usr/bin/env node
// Safe systemd runtime-only smoke; no database, SSH network session or signing.
// Both importing modules must have zero side effects (entrypoint guards).
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export async function smoke({
  version=process.version,
  exec=spawnSync,
  keyRoot=existsSync('/root/mnebyvpn-controller'),
}={}){
  if(version!=='v22.23.5')throw Error('Unexpected Node.js runtime');
  if(!keyRoot)throw Error('Existing controller188 protected root not found');
  const result=exec('/usr/bin/ssh',['-V'],{timeout:2500,encoding:'utf8',maxBuffer:2048});
  if(result.error||result.status!==0)throw Error('System OpenSSH client missing');
  const {Pool}=await import('pg');
  if(typeof Pool!=='function')throw Error('Local PostgreSQL library unavailable');
  await import('../../apps/service/src/fi-enrollment-controller.ts');
  await import('../../apps/service/src/awg-controller-delivery-worker.ts');
  return {node:'v22.23.5',ssh_client:true,pg_driver:true,
          fi_module_imported:true,awg_module_imported:true,
          network_access_used:false,db_queries:0,keys_read:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  smoke().then(x=>process.stdout.write('CONTROLLER188_RUNTIME_SMOKE='+JSON.stringify(x)+'\n'))
    .catch(()=>{process.stderr.write('CONTROLLER188_RUNTIME_SMOKE_FAILED\n');process.exitCode=2;});
