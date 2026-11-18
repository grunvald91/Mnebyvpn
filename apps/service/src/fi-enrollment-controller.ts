/**
 * One-shot private FI node registration. No HTTP listener and no publication.
 * Must run manually on the trusted central controller after the independent
 * node/public-key approval, SSH host-key pinning and database migration.
 */
import {Pool} from 'pg';
import {pathToFileURL} from 'node:url';
import {trustedControllerKey} from './awg-controller-delivery-worker.ts';
import {enrollApprovedFiNode} from '../../../packages/provisioning/src/fi-enrollment-ssh.ts';

async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production'||
     process.env.MNEBYVPN_FI_ENROLLMENT!=='enabled')
    throw Error('FI controller enrollment is not authorized');
  const url=process.env.DATABASE_URL??'';
  if(!/^postgres(?:ql)?:\/\//.test(url))
    throw Error('Canonical PostgreSQL database is required');
  const signer=trustedControllerKey(
    process.env.AWG_CONTROLLER_SIGNING_KEY_FILE??'',
    process.env.AWG_CONTROLLER_PUBLIC_SHA256??'',
  );
  const db=new Pool({connectionString:url,max:1,connectionTimeoutMillis:3000,
                     idleTimeoutMillis:10000});
  try{
    const schema=await db.query(
      "SELECT to_regclass('public.vpn_node_enrollment_inventory')::text AS inventory,"+
      "to_regclass('public.vpn_node_enrollment_challenges')::text AS challenges",
    );
    if(!schema.rows[0]?.inventory||!schema.rows[0]?.challenges)
      throw Error('Node enrollment migrations have not been applied');
    const enrolled=await enrollApprovedFiNode(db,signer,{
      sshIdentityFile:process.env.FI_ENROLL_SSH_KEY_FILE??'',
      pinnedKnownHostsFile:process.env.FI_ENROLL_KNOWN_HOSTS_FILE??'',
      approvedNodePublicSpkiFile:process.env.FI_ENROLL_NODE_PUBLIC_SPKI_FILE??'',
    });
    // Do not print private keys, signed challenge/response, or DB entitlements.
    if(enrolled.state!=='testing'||enrolled.published!==false)
      throw Error('Unexpected enrollment release state');
    process.stdout.write('FI_ENROLLMENT=testing;SUBSCRIBER_PUBLICATION=false\n');
  }finally{
    await db.end();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  await main().catch(()=>{
    process.stderr.write('FI_ENROLLMENT_STOPPED\n');
    process.exitCode=1;
  });
