import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify} from 'node:crypto';
import {
  enrollmentChallengeMessage,enrollmentControllerChallengeMessage,
  verifyNodeEnrollmentProof,
} from '../packages/provisioning/src/node-enrollment.ts';

test('Ed25519 node signs one exact, versioned possession proof',()=>{
  const pair=generateKeyPairSync('ed25519');
  const controller=generateKeyPairSync('ed25519');
  const publicSpki=pair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
  const challenge={
    nodeId:'nl-amsterdam-02',endpointHost:'nl02.nodes.example.net',
    publicSpki,nonce:'a'.repeat(43),
    challengeId:'11111111-2222-4333-8444-555555555555',
    expiresAt:new Date(Date.now()+4*60_000),
  };
  const challengeSignature=sign(null,enrollmentControllerChallengeMessage(challenge),
    controller.privateKey);
  assert.equal(challengeSignature.length,64);
  assert.equal(verify(null,enrollmentControllerChallengeMessage(challenge),
    controller.publicKey,challengeSignature),true);
  const proof={
    nodeId:challenge.nodeId,endpointHost:challenge.endpointHost,
    publicSpki,nonce:challenge.nonce,challengeId:challenge.challengeId,
    signature:'',
  };
  proof.signature=sign(null,enrollmentChallengeMessage(proof),pair.privateKey)
    .toString('base64url');
  assert.equal(verifyNodeEnrollmentProof(proof),true);
  for(const input of [
    {...proof,nodeId:'nl-amsterdam-03'},
    {...proof,endpointHost:'fake.example.net'},
    {...proof,nonce:'b'.repeat(43)},
    {...proof,challengeId:'11111111-2222-4333-8444-555555555556'},
    {...proof,signature:'0'.repeat(86)},
    {...proof,publicSpki:controller.publicKey.export({format:'der',type:'spki'}).toString('base64url')},
  ]){
    assert.equal(verifyNodeEnrollmentProof(input),false);
  }
});
