import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {assertIsolatedRuntime} from '../ops/controller188-runtime/probe.mjs';

const offline={
  version:'v22.16.0',uid:0,interfaces:{lo:[]},
  environment:{},protectedRootPresent:false,
};

test('only reviewed Node22.16 root/no-network/no-secrets runtime passes',()=>{
  assert.doesNotThrow(()=>assertIsolatedRuntime(offline));
  for(const changed of [
    {version:'v20.19.0'},{uid:1000},
    {interfaces:{lo:[],eth0:[]}},
    {protectedRootPresent:true},
    {environment:{DATABASE_URL:'postgresql://untrusted'}},
    {environment:{MNEBYVPN_AWG_DELIVERY_WORKER:'enabled'}},
    {environment:{AWG_CONTROLLER_SIGNING_KEY_FILE:'/root/secret'}},
  ]){
    assert.throws(()=>assertIsolatedRuntime({...offline,...changed}));
  }
});

test('controller image copies only FI/AWG sources and uses keyless canary',()=>{
  const docker=readFileSync('ops/controller188-runtime/Dockerfile','utf8');
  const probe=readFileSync('ops/controller188-runtime/probe.mjs','utf8');
  assert.match(docker,/ARG BASE_IMAGE/);
  assert.match(docker,/FROM \$\{BASE_IMAGE\}/);
  assert.match(docker,/apk add --no-cache openssh-client/);
  assert.match(docker,/COPY --chown=0:0 packages\/provisioning\/src/);
  assert.match(docker,/COPY --chown=0:0 apps\/service\/src\/fi-enrollment-controller\.ts/);
  assert.match(docker,/COPY --chown=0:0 apps\/service\/src\/awg-controller-delivery-worker\.ts/);
  assert.match(docker,/rm -rf \/srv\/mnebyvpn\/apps \/srv\/mnebyvpn\/packages/);
  assert.doesNotMatch(docker,/COPY\s+\.|EXPOSE|ENV\s+.*(PASSWORD|TOKEN|KEY)/);
  assert.match(probe,/network_access:false/);
  assert.match(probe,/signing_keys_mounted:false/);
  assert.match(probe,/fi_enrollment_performed:false/);
});

test('RU188 canary launcher is no-network, no-signing-key and non-mutating',()=>{
  const shell=readFileSync('ops/controller188-runtime/stage.sh','utf8');
  assert.match(shell,/--network none/);
  assert.match(shell,/--read-only/);
  assert.match(shell,/--cap-drop ALL/);
  assert.match(shell,/--security-opt no-new-privileges/);
  assert.match(shell,/--pids-limit 64/);
  assert.match(shell,/--pull=never/);
  assert.match(shell,/docker build --pull=false/);
  assert.match(shell,/docker tag "\$base" "\$base_tag"/);
  assert.match(shell,/docker image rm "\$base_tag"/);
  assert.match(shell,/test "\$\(docker image inspect --format '\{\{\.Id\}\}' "\$base_tag"\)" = "\$base"/);
  assert.match(shell,/--build-arg "BASE_IMAGE=\$base_tag"/);

  assert.match(shell,/^base="\$\(docker inspect --format /m);
  assert.match(shell,/^image="mnebyvpn-controller188-canary:/m);
  assert.doesNotMatch(shell,/--network host|--privileged|--mount\s+type=bind|docker stop|docker rm|docker restart|docker exec/);
});
