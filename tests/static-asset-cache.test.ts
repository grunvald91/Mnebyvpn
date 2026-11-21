import test from 'node:test';
import assert from 'node:assert/strict';
import {publicEtag,matchesPublicEtag} from '../apps/web/src/static-asset-cache.ts';

test('ETag is stable for immutable bytes and changes for modified assets',()=>{
  const first=Buffer.from('public CSS v1');
  const same=Buffer.from('public CSS v1');
  const changed=Buffer.from('public CSS v2');
  const a=publicEtag(first);
  assert.match(a,/^"[a-f0-9]{64}"$/);
  assert.equal(a,publicEtag(first));
  assert.equal(a,publicEtag(same));
  assert.notEqual(a,publicEtag(changed));
});

test('conditional GET and HEAD accept strong, weak, wildcard and lists',()=>{
  const etag=publicEtag(Buffer.from('public image'));
  for(const method of ['GET','HEAD']){
    for(const value of [etag,'W/'+etag,'*','"old", W/'+etag])
      assert.equal(matchesPublicEtag(method,value,etag),true,value);
    for(const value of ['"different"','W/"different"','','"old", "new"'])
      assert.equal(matchesPublicEtag(method,value,etag),false,value);
  }
  for(const method of ['POST','PUT','PATCH','DELETE',undefined])
    assert.equal(matchesPublicEtag(method,etag,etag),false,method??'undefined');
  assert.equal(matchesPublicEtag('GET',undefined,etag),false);
  assert.equal(matchesPublicEtag('GET',[etag],etag),false);
});
